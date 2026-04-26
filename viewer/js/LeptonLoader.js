// LeptonLoader.js — native three.js loader for the Kaon "lepton" format.
// Port of lepton_to_gltf.py (decode_headers, decode_raw_stream, walk).
// Reads lepton.xml + app.xml + geometry_raw.bin; returns a scene description
// the rest of the viewer turns into THREE objects.

import * as THREE from 'three';

const MAGIC = 0xADFF;            // 44543
const FLAG_NON_REDUNDANT = 4;
const FLAG_FP16 = 64;            // quantized stream; not handled (use raw)
const REF_LIMIT = 65536 * 64;    // 4194304

const DEG = Math.PI / 180;

// ----------------------------------------------------------------------------
// XML helpers
// ----------------------------------------------------------------------------

function parseXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('XML parse error: ' + err.textContent);
  return doc.documentElement;
}

function attrFloat(el, name, dflt = 0) {
  const v = el.getAttribute(name);
  return v == null ? dflt : parseFloat(v);
}

function attrAlpha(el) {
  const v = el.getAttribute('alpha');
  if (v == null || v === '_N') return null;           // inherit
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ----------------------------------------------------------------------------
// lepton.xml
// ----------------------------------------------------------------------------

function parseLeptonXML(root) {
  const title = root.getAttribute('title') || '';
  const lights = [...root.querySelectorAll(':scope > lights > light')].map(l => ({
    intensity: attrFloat(l, 'intensity', 1.0),
    ambient: l.getAttribute('ambient') === 'true',
    x: attrFloat(l, 'x'), y: attrFloat(l, 'y'), z: -attrFloat(l, 'z'),
  }));

  const materials = [...root.querySelectorAll(':scope > materials > material')].map(m => ({
    id: m.getAttribute('id'),
    color: parseInt(m.getAttribute('color') || '0xffffff', 16),
    image: m.getAttribute('image') || '',
    backface: m.getAttribute('backface') === 'true',
    light: m.getAttribute('light') || 'phong',
    alpha: attrFloat(m, 'alpha', 1.0),
    ambient: attrFloat(m, 'ambient', 1.0),
    diffuse: attrFloat(m, 'diffuse', 1.0),
    specular: attrFloat(m, 'specular', 0.0),
    glossiness: attrFloat(m, 'glossiness', 0.5),
    chrome: attrFloat(m, 'chrome', 0.0),
  }));
  const matIdxById = new Map();
  materials.forEach((m, i) => matIdxById.set(m.id, i));

  const objsEl = root.querySelector(':scope > objects');
  const mm = attrFloat(objsEl, 'mm', 1.0);

  const objects = [];
  const meshOrder = [];
  const objIdxById = new Map();

  function walk(el, parent) {
    const idx = objects.length;
    const id = el.getAttribute('id') || `node_${idx}`;
    const meshEl = el.querySelector(':scope > mesh');
    // Kaon engine flips XML z and theta on read (left-to-right-handed conversion).
    // The binary vertex stream is already in engine convention, so we apply the
    // same flip to XML object/view/light/waypoint attributes here.
    const obj = {
      idx, id, parent,
      x: attrFloat(el, 'x'), y: attrFloat(el, 'y'), z: -attrFloat(el, 'z'),
      theta: -attrFloat(el, 'theta'),
      phi: attrFloat(el, 'phi'),
      psi: attrFloat(el, 'psi'),
      alpha: attrAlpha(el),
      mesh: null,
    };
    if (meshEl) {
      obj.mesh = {
        bin: meshEl.getAttribute('bin') || '',
        faces: parseInt(meshEl.getAttribute('faces') || '0', 10),
        vertices: parseInt(meshEl.getAttribute('vertices') || '0', 10),
      };
    }
    objects.push(obj);
    objIdxById.set(id, idx);
    if (obj.mesh) meshOrder.push(idx);
    for (const child of el.querySelectorAll(':scope > object')) walk(child, idx);
  }
  for (const top of objsEl.querySelectorAll(':scope > object')) walk(top, -1);

  const views = {};
  for (const v of root.querySelectorAll(':scope > views > view')) {
    const id = v.getAttribute('id');
    views[id] = {
      id,
      theta: -attrFloat(v, 'theta'),
      phi: attrFloat(v, 'phi'),
      cx: attrFloat(v, 'cx', 0.5),
      cy: attrFloat(v, 'cy', 0.5),
      aspect: attrFloat(v, 'aspect', 1.0),
      fov: attrFloat(v, 'fov', 30),
      dist: attrFloat(v, 'dist', 10),
      x: attrFloat(v, 'x'), y: attrFloat(v, 'y'), z: -attrFloat(v, 'z'),
      minPhi: attrFloat(v, 'minPhi', -89),
      maxPhi: attrFloat(v, 'maxPhi', 89),
      minFOV: attrFloat(v, 'minFOV', 5),
      maxFOV: attrFloat(v, 'maxFOV', 60),
    };
  }

  const sequences = {};
  for (const s of root.querySelectorAll(':scope > sequences > sequence')) {
    const id = s.getAttribute('id');
    const waypoints = [...s.querySelectorAll(':scope > waypoint')].map(wp => {
      const obj = { wp: attrFloat(wp, 'wp', 0), mask: parseInt(wp.getAttribute('mask') || '0', 10) };
      for (const k of ['x','y','z','theta','phi','psi','scaleX','scaleY','scaleZ','alpha']) {
        const v = wp.getAttribute(k);
        if (v != null) {
          let n = parseFloat(v);
          if (k === 'z' || k === 'theta') n = -n;   // engine handedness flip
          obj[k] = n;
        }
      }
      return obj;
    }).sort((a, b) => a.wp - b.wp);
    sequences[id] = {
      id,
      object: s.getAttribute('object') || null,
      length: parseFloat(s.getAttribute('length') || '0'),
      waypoints,
    };
  }

  const scripts = {};
  let initScript = null;
  const scriptsEl = root.querySelector(':scope > scripts');
  if (scriptsEl) {
    initScript = scriptsEl.getAttribute('init');
    for (const s of scriptsEl.querySelectorAll(':scope > script')) {
      const id = s.getAttribute('id');
      const events = [];
      for (const ev of s.children) {
        const obj = { tag: ev.tagName };
        for (const a of ev.attributes) obj[a.name] = a.value;
        events.push(obj);
      }
      scripts[id] = {
        id,
        length: parseFloat(s.getAttribute('length') || '0'),
        events,
      };
    }
  }

  return {
    title, mm, lights, materials, matIdxById,
    objects, meshOrder, objIdxById,
    views, sequences, scripts, initScript,
  };
}

// ----------------------------------------------------------------------------
// app.xml (optional)
// ----------------------------------------------------------------------------

function parseAppXML(root) {
  const uiFields = {};
  for (const f of root.querySelectorAll(':scope > ui-fields > field'))
    uiFields[f.getAttribute('name')] = f.getAttribute('value');

  const controls = [...root.querySelectorAll(':scope > controls > control')].map(c => {
    const g = c.querySelector(':scope > graphic');
    const txt = g ? g.querySelector(':scope > text') : null;
    const img = g ? g.querySelector(':scope > image') : null;
    const fields = {};
    for (const f of c.querySelectorAll(':scope > field')) fields[f.getAttribute('name')] = f.getAttribute('value');
    const gfields = {};
    if (g) for (const f of g.querySelectorAll(':scope > field')) gfields[f.getAttribute('name')] = f.getAttribute('value');
    return {
      id: c.getAttribute('id'),
      cls: c.getAttribute('class'),
      script: c.getAttribute('script'),
      textPlain: txt ? txt.getAttribute('text') || '' : '',
      textHtml: txt ? txt.textContent || '' : '',
      image: img ? img.getAttribute('resource-path') || '' : '',
      fields, gfields,
    };
  });

  const hotspots = [...root.querySelectorAll(':scope > hotspots > hotspot')].map(h => {
    const g = h.querySelector(':scope > graphic');
    const txt = g ? g.querySelector(':scope > text') : null;
    const img = g ? g.querySelector(':scope > image') : null;
    return {
      id: h.getAttribute('id'),
      cls: h.getAttribute('class'),
      x: attrFloat(h, 'x'), y: attrFloat(h, 'y'), z: attrFloat(h, 'z'),
      radius: attrFloat(h, 'radius', 0.5),
      alwaysOn: h.getAttribute('always-on') === 'true',
      object: h.getAttribute('object'),
      textPlain: txt ? txt.getAttribute('text') || '' : '',
      textHtml: txt ? txt.textContent || '' : '',
      image: img ? img.getAttribute('resource-path') || '' : '',
    };
  });

  return { hotspots, controls, uiFields };
}

// ----------------------------------------------------------------------------
// Binary decode
// ----------------------------------------------------------------------------

class BEReader {
  constructor(buffer, offset = 0) { this.dv = new DataView(buffer); this.o = offset; }
  u16() { const v = this.dv.getUint16(this.o, false); this.o += 2; return v; }
  u32() { const v = this.dv.getUint32(this.o, false); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, false); this.o += 4; return v; }
}

function decodeHeaders(buffer, meshCount) {
  const br = new BEReader(buffer);
  const headers = [];
  for (let i = 0; i < meshCount; ++i) {
    const hStart = br.o;
    const magic = br.u16();
    if (magic !== MAGIC)
      throw new Error(`bad magic 0x${magic.toString(16)} at offset ${hStart}, expected 0x${MAGIC.toString(16)}`);
    const flags = br.u32();
    const faces = br.u32();
    const vertices = br.u32();
    const bitsXYZ = br.u16(), bitsUV = br.u16(), bitsNorm = br.u16();
    const minX = br.f32(), maxX = br.f32();
    const minY = br.f32(), maxY = br.f32();
    const zA = br.f32(), zB = br.f32();
    const minU = br.f32(), maxU = br.f32();
    const minV = br.f32(), maxV = br.f32();
    const matLen = br.u16();
    const matGroups = [];
    for (let k = 0; k < matLen; ++k) {
      const mi = br.u16();
      const cnt = br.u32();
      matGroups.push({ matIdx: mi, triCount: cnt });
    }
    br.u32(); br.u32(); br.u32(); br.u32();   // reserved
    // per-material OBB (8 corners * 3 floats) — skip
    for (let k = 0; k < matLen; ++k) for (let c = 0; c < 8; ++c) { br.f32(); br.f32(); br.f32(); }
    headers.push({
      flags, faces, vertices, bitsXYZ, bitsUV, bitsNorm,
      bbox: { min: [minX, minY, -zB], max: [maxX, maxY, -zA] },
      uvBbox: { min: [minU, minV], max: [maxU, maxV] },
      matGroups,
      headerSize: br.o - hStart,
    });
  }
  let streamOff = br.o;
  if (streamOff % 4 !== 0) streamOff += 2;
  return { headers, streamOff };
}

function decodeRawStream(buffer, streamOff, totalVboVerts) {
  // Views over the payload. Alignment is guaranteed (streamOff % 4 === 0).
  const f32 = new Float32Array(buffer, streamOff);
  const i32 = new Int32Array(buffer, streamOff);
  const vbo = new Float32Array(totalVboVerts * 8);
  let j = 0;
  const total = vbo.length;
  for (let k = 0; k < total; k += 8) {
    const r = i32[j];
    if (r > 0 && r < REF_LIMIT) {
      const src = k - r * 8;
      vbo[k    ] = vbo[src    ];
      vbo[k + 1] = vbo[src + 1];
      vbo[k + 2] = vbo[src + 2];
      vbo[k + 3] = vbo[src + 3];
      vbo[k + 4] = vbo[src + 4];
      vbo[k + 5] = vbo[src + 5];
      vbo[k + 6] = vbo[src + 6];
      vbo[k + 7] = vbo[src + 7];
      j += 1;
    } else {
      vbo[k    ] = f32[j    ];
      vbo[k + 1] = f32[j + 1];
      vbo[k + 2] = f32[j + 2];
      vbo[k + 3] = f32[j + 3];
      vbo[k + 4] = f32[j + 4];
      vbo[k + 5] = f32[j + 5];
      vbo[k + 6] = f32[j + 6];
      vbo[k + 7] = f32[j + 7];
      j += 8;
    }
  }
  return { vbo, bytesUsed: j * 4 };
}

// ----------------------------------------------------------------------------
// Geometry building
// ----------------------------------------------------------------------------

function buildGeometries(vbo, headers) {
  const geoms = [];
  let vertCursor = 0;      // in "8-float records"
  for (const h of headers) {
    const faceCount = h.faces;
    const vertCount = faceCount * 3;
    const slice = vbo.subarray(vertCursor * 8, (vertCursor + vertCount) * 8);

    const position = new Float32Array(vertCount * 3);
    const uv       = new Float32Array(vertCount * 2);
    const normal   = new Float32Array(vertCount * 3);
    // Kaon authors triangles CW (engine sets gl.frontFace(CW), confirmed in
    // dumps/lepton_webgl_obf.js offset 433024). Three.js culls assuming CCW
    // front, so we reverse winding per triangle here: emit verts in [0,2,1]
    // order. Stored normals already point outward, so they remain valid.
    for (let t = 0; t < faceCount; ++t) {
      for (let k = 0; k < 3; ++k) {
        const dst = t * 3 + k;
        const src = t * 3 + (k === 0 ? 0 : k === 1 ? 2 : 1);
        const o = src * 8;
        position[dst*3    ] = slice[o    ];
        position[dst*3 + 1] = slice[o + 1];
        position[dst*3 + 2] = slice[o + 2];
        uv[dst*2    ] = slice[o + 3];
        uv[dst*2 + 1] = slice[o + 4];
        normal[dst*3    ] = slice[o + 5];
        normal[dst*3 + 1] = slice[o + 6];
        normal[dst*3 + 2] = slice[o + 7];
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(position, 3));
    g.setAttribute('uv',       new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal',   new THREE.BufferAttribute(normal, 3));

    // Material groups: each consumes triCount * 3 vertices in order.
    let vOff = 0;
    let groupIdx = 0;
    for (const g2 of h.matGroups) {
      const count = g2.triCount * 3;
      g.addGroup(vOff, count, groupIdx);
      vOff += count;
      groupIdx += 1;
    }
    g.computeBoundingSphere();
    geoms.push({ geometry: g, matGroups: h.matGroups });
    vertCursor += vertCount;
  }
  return geoms;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return await r.text();
}
async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return await r.arrayBuffer();
}

async function headOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch { return false; }
}

/**
 * Resolve a material's image name to a URL in the asset dir.
 * Tries .dds → .jpeg → .jpg → .png variants. Returns {url, kind} or null.
 */
async function resolveTextureUrl(assetDir, imageName, preferDDS) {
  if (!imageName) return null;
  const stem = imageName.replace(/\.[^.]+$/, '');
  const exts = preferDDS
    ? [['dds','dds'], ['jpeg','jpeg'], ['jpg','jpeg'], ['JPG','jpeg'], ['JPEG','jpeg'], ['png','png'], ['PNG','png']]
    : [['jpeg','jpeg'], ['jpg','jpeg'], ['JPG','jpeg'], ['JPEG','jpeg'], ['png','png'], ['PNG','png'], ['dds','dds']];
  for (const [ext, kind] of exts) {
    const url = `${assetDir}${stem}.${ext}`;
    if (await headOk(url)) return { url, kind };
  }
  return null;
}

export async function loadLepton(assetDir) {
  if (!assetDir.endsWith('/')) assetDir += '/';
  // lepton.xml + app.xml in parallel, bin fetched after so we know mesh count.
  const [leptonXML, appXML] = await Promise.all([
    fetchText(assetDir + 'lepton.xml'),
    fetchText(assetDir + 'app.xml').catch(() => null),
  ]);
  const scene = parseLeptonXML(parseXML(leptonXML));
  const app = appXML ? parseAppXML(parseXML(appXML)) : { hotspots: [], controls: [], uiFields: {} };

  const bin = await fetchBuffer(assetDir + 'geometry_raw.bin');
  const meshCount = scene.meshOrder.length;
  const { headers, streamOff } = decodeHeaders(bin, meshCount);

  // Sanity: XML and header face counts must agree.
  for (let i = 0; i < meshCount; ++i) {
    const obj = scene.objects[scene.meshOrder[i]];
    if (headers[i].faces !== obj.mesh.faces)
      console.warn(`[lepton] face mismatch at mesh ${i}: header=${headers[i].faces} xml=${obj.mesh.faces}`);
  }

  const totalVbo = headers.reduce((s, h) => s + h.faces * 3, 0);
  const { vbo } = decodeRawStream(bin, streamOff, totalVbo);
  const geometries = buildGeometries(vbo, headers);

  return { assetDir, scene, app, headers, geometries };
}

export { resolveTextureUrl };

// Shared helper for YXZ Euler (matches Python qz*qx*qy in lepton_to_gltf.py)
export function leptonEuler(thetaDeg, phiDeg, psiDeg) {
  return new THREE.Euler(phiDeg * DEG, thetaDeg * DEG, psiDeg * DEG, 'YXZ');
}
