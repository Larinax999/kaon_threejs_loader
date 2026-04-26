// LeptonMaterial.js — material shader, ported as a 1:1 functional match to
// Kaon's mesh fragment shader (extracted live from the running engine).
//
// Lighting works via a precomputed 3-channel cubemap:
//   .r = lambertian diffuse intensity at world-normal direction
//   .g = sharp specular highlight at reflection direction
//   .b = broad chrome reflection at reflection direction
//
// Per-fragment math (matching engine):
//   currColor = texture(tex, uv) * material_color  (premultiplied alpha)
//   currColor.rgb *= min(ambient + diffuse * cubeMap(N).r, 1.0)
//   L = cubeMap(reflect(eye, N))
//   sl = (specularK * L.g - chromeK * L.b) * currColor.a
//   currColor.rgb += sl
//
// The cubemap is built once from the scene's <light> entries and shared across
// materials; per-material specular/chrome strengths are pushed as uniforms.

import * as THREE from 'three';

// three.js's ShaderMaterial auto-prepends declarations for `position`, `uv`, `normal`,
// `modelMatrix`, `viewMatrix`, `projectionMatrix`, `modelViewMatrix`, `normalMatrix`.
const VERT = /* glsl */`
precision highp float;
varying vec2 texCoord;
varying vec3 vWorldNormal;
varying vec4 fragPositionCamera;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  fragPositionCamera = viewMatrix * wp;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);   // for cubemap lookups
  texCoord = uv;
  gl_Position = projectionMatrix * fragPositionCamera;
}
`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D tex;
uniform bool hasTex;
uniform vec3  color;
uniform float alpha;
uniform float ambient;
uniform float diffuse;
uniform float specularK;
uniform float chromeK;
uniform samplerCube cubeMap;
uniform mat3  viewToWorld;
uniform bool  debugBackface;
uniform bool  debugNoTex;
uniform bool  debugFlat;
uniform bool  selected;
varying vec2 texCoord;
varying vec3 vWorldNormal;
varying vec4 fragPositionCamera;

void main() {
  if (debugBackface && !gl_FrontFacing) {
    gl_FragColor = vec4(1.0, 0.15, 0.8, 1.0);
    return;
  }
  vec3 N;
  if (debugFlat) {
    // Flat-shading override: rebuild normal from screen-space derivatives of
    // camera-space position, then transform back to world-space for the
    // cubemap lookups below.
    vec3 fdx = dFdx(fragPositionCamera.xyz);
    vec3 fdy = dFdy(fragPositionCamera.xyz);
    vec3 nCam = normalize(cross(fdx, fdy));
    N = normalize(viewToWorld * nCam);
  } else {
    N = normalize(vWorldNormal);
  }
  vec4 currColor;
  if (hasTex && !debugNoTex) currColor = texture2D(tex, texCoord);
  else                       currColor = vec4(1.0);
  // Pre-multiply, mirroring engine path with !premultiplied.
  currColor.rgb *= currColor.a;
  // Material color (vec4 in engine; alpha is the runtime effective alpha).
  currColor *= vec4(color, alpha);

  // Diffuse lookup by world-space normal.
  if (ambient < 0.95) {
    float diffuseLevel = textureCube(cubeMap, N).r;
    currColor.rgb *= min(ambient + diffuse * diffuseLevel, 1.0);
  }

  // Specular/chrome lookup. Engine samples cubeMap with reflect(cameraEye, N) —
  // mixing camera-space eye and world-space normal. This is intentional in the
  // Kaon shader and ties highlights to the camera frame.
  vec3 eye = normalize(fragPositionCamera.xyz);
  vec3 L   = textureCube(cubeMap, reflect(eye, N)).rgb;
  float specularLevel = L.g;
  float chromeLevel   = L.b;
  float sl = (specularK * specularLevel - chromeK * chromeLevel) * currColor.a;
  currColor.rgb += sl;
  currColor.a   += abs(sl);

  if (selected) {
    // Pulse-tint the picked object yellow-orange. Mix in screen space so the
    // tint stays visible even when the underlying material is dark.
    currColor.rgb = mix(currColor.rgb, vec3(1.0, 0.78, 0.15) * currColor.a, 0.55);
  }

  gl_FragColor = currColor;
}
`;

// ----------------------------------------------------------------------------
// Cubemap baker — produces a 64² cube whose RGB encodes the recipe above.
// ----------------------------------------------------------------------------

function bakeCube(lights, size = 64) {
  // Lights as { ambient, intensity, dir:Vector3 } — directional only.
  const dirs = lights.filter(l => !l.ambient).map(l => {
    const d = new THREE.Vector3(l.x || 0, l.y || 0, l.z || 0);
    if (d.lengthSq() < 1e-8) d.set(0, -1, 0);
    d.normalize();
    return { dir: d, intensity: l.intensity };
  });

  // Engine's lights are stored as directions toward the surface, i.e. light comes from -dir.
  // For a normal n, lambertian = max(0, dot(n, -dir)) * intensity.
  function evalRGB(n) {
    let r = 0, g = 0, b = 0;
    for (const L of dirs) {
      const ndl = -(n.x * L.dir.x + n.y * L.dir.y + n.z * L.dir.z);
      const c = Math.max(0, ndl);
      r += c * L.intensity;
      // Sharp specular lobe: pow(c, 32). Glossiness modulation comes from per-mat uniform.
      g += Math.pow(c, 32.0) * L.intensity;
      // Broader chrome lobe: pow(c, 8).
      b += Math.pow(c, 8.0) * L.intensity;
    }
    // Clamp to [0,1] — these are stored as 8-bit channels.
    return [Math.min(1, r), Math.min(1, g), Math.min(1, b)];
  }

  // For each cube face, generate a Canvas with the right RGB for each direction.
  const faceData = {};
  // Three.js CubeTexture face order: +X, -X, +Y, -Y, +Z, -Z (using image-space Y-down within each face).
  const faces = [
    { key: 'px', axis: [+1, 0, 0] },
    { key: 'nx', axis: [-1, 0, 0] },
    { key: 'py', axis: [0, +1, 0] },
    { key: 'ny', axis: [0, -1, 0] },
    { key: 'pz', axis: [0, 0, +1] },
    { key: 'nz', axis: [0, 0, -1] },
  ];

  // Cube face uv → 3D direction (matching GL cubemap convention).
  function faceDir(key, u, v) {
    // u,v in [-1, 1]
    let x = 0, y = 0, z = 0;
    switch (key) {
      case 'px': x =  1; y = -v; z = -u; break;
      case 'nx': x = -1; y = -v; z =  u; break;
      case 'py': x =  u; y =  1; z =  v; break;
      case 'ny': x =  u; y = -1; z = -v; break;
      case 'pz': x =  u; y = -v; z =  1; break;
      case 'nz': x = -u; y = -v; z = -1; break;
    }
    const il = 1 / Math.hypot(x, y, z);
    return new THREE.Vector3(x * il, y * il, z * il);
  }

  const tmp = new THREE.Vector3();
  for (const f of faces) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; ++y) {
      for (let x = 0; x < size; ++x) {
        const u = (x + 0.5) / size * 2 - 1;
        const v = (y + 0.5) / size * 2 - 1;
        tmp.copy(faceDir(f.key, u, v));
        const [r, g, b] = evalRGB(tmp);
        const i = (y * size + x) * 4;
        img.data[i    ] = (r * 255) | 0;
        img.data[i + 1] = (g * 255) | 0;
        img.data[i + 2] = (b * 255) | 0;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    faceData[f.key] = c;
  }

  const tex = new THREE.CubeTexture([
    faceData.px, faceData.nx, faceData.py, faceData.ny, faceData.pz, faceData.nz,
  ]);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

let sharedCube = null;
let sharedCubeSig = null;

export function getSceneCubeMap(lights) {
  // Lights signature for cache invalidation
  const sig = JSON.stringify(lights.map(l => [l.ambient, l.intensity, l.x, l.y, l.z]));
  if (sharedCubeSig !== sig) {
    sharedCube = bakeCube(lights);
    sharedCubeSig = sig;
  }
  return sharedCube;
}

// ----------------------------------------------------------------------------
// Material factory
// ----------------------------------------------------------------------------

function colorVec(c) {
  return new THREE.Vector3(
    ((c >> 16) & 0xff) / 255,
    ((c >> 8) & 0xff) / 255,
    (c & 0xff) / 255,
  );
}

export function makeLeptonMaterial(matDef, texture, cubeMap, ambientLightIntensity) {
  const ambientUniform = matDef.ambient * (ambientLightIntensity ?? 1.0);
  const uniforms = {
    tex:       { value: texture || null },
    hasTex:    { value: !!texture },
    color:     { value: colorVec(matDef.color) },
    alpha:     { value: matDef.alpha },
    ambient:   { value: ambientUniform },
    diffuse:   { value: matDef.diffuse },
    specularK: { value: matDef.specular },
    chromeK:   { value: matDef.chrome },
    cubeMap:   { value: cubeMap },
    viewToWorld: { value: new THREE.Matrix3() },
    debugBackface: { value: false },
    debugNoTex:    { value: false },
    debugFlat:     { value: false },
    selected:      { value: false },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: matDef.backface ? THREE.DoubleSide : THREE.FrontSide,
    transparent: matDef.alpha < 1.0,
    depthWrite: matDef.alpha >= 1.0,
    lights: false,
    extensions: { derivatives: true },
  });
  mat.userData.leptonBaseAlpha = matDef.alpha;
  mat.userData.leptonId = matDef.id;
  mat.userData.leptonBackface = !!matDef.backface;
  return mat;
}

/**
 * Push the camera→world matrix into every material once per frame.
 */
export function updateLeptonUniforms(materials, camera) {
  const viewToWorld = new THREE.Matrix3().setFromMatrix4(camera.matrixWorld);
  for (const mat of materials) {
    mat.uniforms.viewToWorld.value.copy(viewToWorld);
  }
}

export function setMaterialAlpha(mat, effectiveAlpha) {
  const a = Math.max(0, Math.min(1, effectiveAlpha));
  mat.uniforms.alpha.value = a;
  const shouldBlend = a < 1.0 - 1e-4;
  if (mat.transparent !== shouldBlend) {
    mat.transparent = shouldBlend;
    mat.depthWrite = !shouldBlend;
    mat.needsUpdate = true;
  }
}
