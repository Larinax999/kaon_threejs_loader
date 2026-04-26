// LeptonViewer.js — app shell. Routes URL hash → loads lepton asset → builds
// scene → runs render loop.

import * as THREE from 'three';
import { DDSLoader } from './vendor/DDSLoader.js';
import { loadLepton, leptonEuler, resolveTextureUrl } from './LeptonLoader.js';
import { makeLeptonMaterial, updateLeptonUniforms, setMaterialAlpha, getSceneCubeMap } from './LeptonMaterial.js';
import { LeptonControls } from './LeptonControls.js';
import { LeptonAnimator } from './LeptonAnimator.js';
import { LeptonHotspots } from './LeptonHotspots.js';
import { LeptonDebug } from './LeptonDebug.js';

const DUMPS_BASE = '../dumps/';
const CATALOG_BASE = `${DUMPS_BASE}catalog/`;
const DEFAULT_HASH = '2/264';

// Populated from models.json on startup. Keyed by entry.id (the URL hash).
let modelsById = new Map();

// ----------------------------------------------------------------------------

const canvas = document.getElementById('canvas');
const loaderEl = document.getElementById('loader');
const titleEl = document.getElementById('title');
const menuEl = document.getElementById('menu');
const viewsEl = document.getElementById('views');
const sidecarEl = document.getElementById('sidecar');
const sidecarTitleEl = document.getElementById('sidecar-title');
const sidecarBodyEl = document.getElementById('sidecar-body');
const sidecarImageEl = document.getElementById('sidecar-image');
const sidecarCloseEl = document.getElementById('sidecar-close');
const hotspotCardEl = document.getElementById('hotspot-card');
const hotspotBodyEl = document.getElementById('hotspot-body');
const hotspotImageEl = document.getElementById('hotspot-image');
const hotspotCloseEl = document.getElementById('hotspot-close');
const objectCardEl = document.getElementById('object-card');
const objectTitleEl = document.getElementById('object-title');
const objectActionsEl = document.getElementById('object-actions');
const objectBodyEl = document.getElementById('object-body');
const objectCloseEl = document.getElementById('object-close');
const debugToggleEl = document.getElementById('debug-toggle');
const debugPanelEl = document.getElementById('debug-panel');
const pickerSelectEl = document.getElementById('picker-select');

sidecarCloseEl.addEventListener('click', () => sidecarEl.classList.remove('open'));
hotspotCloseEl.addEventListener('click', () => hotspotCardEl.classList.remove('open'));
objectCloseEl.addEventListener('click', () => selectMesh(null));

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
// HiDPI sharpness: respect the device's full pixel ratio (capped at 3 to keep
// pathological reports from blowing up the framebuffer).
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
// Match Kaon's pipeline: textures and shader output stay in display (sRGB) space —
// no linear↔sRGB encoding. Doing the conversion would dim everything ~2x relative to
// the reference renderer.
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setClearColor(0xc8cdd2, 1);   // light grey, like the hosted viewer's gradient

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 1, 500);
const controls = new LeptonControls(camera, canvas);
const debug = new LeptonDebug({
  toggleEl: debugToggleEl,
  panelEl: debugPanelEl,
  scene,
  onChange: (group, key, value) => {
    // Clear any active selection (and tear down the highlight) when picking is disabled.
    if (group === 'interaction' && key === 'clickToPick' && !value) selectMesh(null);
  },
});

let current = null;       // loaded asset state
let stopRAF = false;

// ----------------------------------------------------------------------------
// Asset loading
// ----------------------------------------------------------------------------

async function loadTexture(assetDir, imageName) {
  if (!imageName) return null;
  // Prefer DDS when available (full-resolution BC-compressed); JPEG twins are
  // ~70× smaller and visibly soft. Never flip Y: the lepton format authors UVs
  // assuming V=0 = top of image (DX convention), matching UNPACK_FLIP_Y_WEBGL=false.
  const resolved = await resolveTextureUrl(assetDir, imageName, /*preferDDS*/ true);
  if (!resolved) {
    console.warn('[lepton] texture not found:', imageName);
    return null;
  }
  return new Promise((resolve) => {
    const loader = resolved.kind === 'dds' ? new DDSLoader() : new THREE.TextureLoader();
    loader.load(
      resolved.url,
      (t) => {
        t.colorSpace = THREE.NoColorSpace;     // engine doesn't sRGB-decode textures
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        t.magFilter = THREE.LinearFilter;
        // Compressed (DDS) textures ship pre-built mipmaps; runtime
        // glGenerateMipmap fails on compressed formats, so opt out and trust
        // the embedded chain. Uncompressed sources still need runtime mipmaps.
        if (resolved.kind === 'dds') {
          t.generateMipmaps = false;
          t.minFilter = (t.mipmaps && t.mipmaps.length > 1)
            ? THREE.LinearMipmapLinearFilter
            : THREE.LinearFilter;
        } else {
          t.generateMipmaps = true;
          t.minFilter = THREE.LinearMipmapLinearFilter;
        }
        t.flipY = false;                       // Kaon never sets UNPACK_FLIP_Y_WEBGL
        resolve(t);
      },
      undefined,
      (err) => {
        console.warn('[lepton] texture load failed:', resolved.url, err);
        resolve(null);
      },
    );
  });
}

async function buildScene(data) {
  // Clear existing
  while (scene.children.length > 0) scene.remove(scene.children[0]);

  const { assetDir, scene: S, app, geometries } = data;

  // Textures (dedup by image name)
  const texByImage = new Map();
  const loadJobs = [];
  for (const m of S.materials) {
    if (!m.image) continue;
    if (texByImage.has(m.image)) continue;
    texByImage.set(m.image, null);
    loadJobs.push(loadTexture(assetDir, m.image).then(t => texByImage.set(m.image, t)));
  }
  await Promise.all(loadJobs);

  // Bake the lighting cubemap once for this scene's lights.
  const cubeMap = getSceneCubeMap(S.lights);
  const ambientIntensity = S.lights
    .filter(l => l.ambient)
    .reduce((s, l) => s + l.intensity, 0);

  // Root node: one THREE.Group per XML object, parented by flat `parent` indices.
  const nodesByIdx = new Array(S.objects.length);
  const nodesByObjId = new Map();

  // Roots go into a container we parent to the scene.
  const root = new THREE.Group();
  root.name = 'lepton-root';
  scene.add(root);

  const allMaterials = [];

  for (const obj of S.objects) {
    const node = new THREE.Group();
    node.name = obj.id;
    node.position.set(obj.x, obj.y, obj.z);
    node.rotation.copy(leptonEuler(obj.theta, obj.phi, obj.psi));
    node.userData.objDef = obj;
    // null preserves the XML "_N" semantics (inherit from parent) so
    // propagateAlpha can distinguish it from an explicit alpha value.
    node.userData.currentAlpha = obj.alpha;
    nodesByIdx[obj.idx] = node;
    nodesByObjId.set(obj.id, node);
    if (obj.parent < 0) root.add(node);
    else nodesByIdx[obj.parent].add(node);
  }

  // Attach meshes. `geometries[i]` corresponds to mesh_order[i].
  for (let i = 0; i < S.meshOrder.length; ++i) {
    const objIdx = S.meshOrder[i];
    const obj = S.objects[objIdx];
    const { geometry, matGroups } = geometries[i];

    // One material per draw group (clone per mesh so alpha is per-instance).
    const mats = matGroups.map((g) => {
      const def = S.materials[g.matIdx];
      if (!def) { console.warn('[lepton] missing material', g.matIdx); return null; }
      const tex = def.image ? texByImage.get(def.image) || null : null;
      const mat = makeLeptonMaterial(def, tex, cubeMap, ambientIntensity);
      allMaterials.push(mat);
      return mat;
    });

    const mesh = new THREE.Mesh(geometry, mats);
    mesh.name = obj.id + '/mesh';
    mesh.frustumCulled = true;
    nodesByIdx[objIdx].add(mesh);
    nodesByIdx[objIdx].userData.meshMaterials = mats;
  }

  // Fit camera near/far to the model's bounding sphere. The default planes
  // (1, 500) clip the back of large scenes, which reads as "fog" — distant
  // geometry just disappears. Scale far to ~20× the radius so the camera can
  // orbit out without clipping; grow near in proportion to keep depth precision.
  const _bboxAll = new THREE.Box3().setFromObject(root);
  if (!_bboxAll.isEmpty()) {
    const _sphereAll = _bboxAll.getBoundingSphere(new THREE.Sphere());
    const r = _sphereAll.radius || 1;
    camera.far  = Math.max(500, r * 20);
    camera.near = Math.max(0.1, camera.far / 10000);
    camera.updateProjectionMatrix();
  }

  // Compute a default view if no init script view available.
  const initView = S.views['View_0'] || Object.values(S.views)[0];
  if (initView) controls.setView(initView);

  // Animator wires sequences → nodes, scripts → controls + sequences.
  const animator = new LeptonAnimator(S, nodesByObjId, controls, S.views,
    (objId, alpha) => {
      const n = nodesByObjId.get(objId);
      if (n) n.userData.currentAlpha = alpha;
    });
  animator.applyInit();

  // Hotspots
  const hotspots = new LeptonHotspots(app, nodesByObjId, camera, canvas);
  scene.add(hotspots.group);
  hotspots.onClick(openHotspot);

  current = { data, root, allMaterials, nodesByObjId, animator, hotspots };
  // DEBUG hook (temporary) — expose scene state so devtools can introspect
  // textures/materials from console / MCP evaluate_script.
  window.__viewer = { THREE, renderer, scene, camera, current };

  buildChrome();
  propagateAlpha();   // initial alpha push to materials
  debug.apply(current);
}

// ----------------------------------------------------------------------------
// Alpha inheritance + material uniform push
// ----------------------------------------------------------------------------

function propagateAlpha() {
  if (!current) return;
  const { data, nodesByObjId } = current;
  // Kaon semantics: alpha="_N" (own == null) means inherit parent's effective
  // alpha; an explicit numeric alpha is independent — it is never multiplied
  // by the parent's. This is what lets ROOT-fade scripts (seq_0) hide the
  // chassis while leaving the SSD/PSU cards (alpha="1.0") visible.
  const effByIdx = new Array(data.scene.objects.length);
  for (const obj of data.scene.objects) {
    const node = nodesByObjId.get(obj.id);
    const own = node.userData.currentAlpha;
    const parentEff = obj.parent < 0 ? 1.0 : effByIdx[obj.parent];
    const eff = (own == null) ? parentEff : own;
    effByIdx[obj.idx] = eff;
    const mats = node.userData.meshMaterials;
    if (mats) {
      for (const m of mats) {
        if (!m) continue;
        setMaterialAlpha(m, m.userData.leptonBaseAlpha * eff);
      }
      // Only flip visibility on mesh-bearing nodes; toggling parent transform
      // groups would also hide their independently-alphaed children in three.js.
      // userHidden is a manual override set by the object info card's Hide button —
      // it forces the node off regardless of alpha state.
      node.visible = !node.userData.userHidden && eff > 0.001;
    }
  }
}

// ----------------------------------------------------------------------------
// UI chrome (title, menu buttons, view dots, sidecar, hotspot card)
// ----------------------------------------------------------------------------

function buildChrome() {
  const { data } = current;
  titleEl.textContent = data.scene.title || '';

  // Menu buttons from MENU_ORDER, falling back to any AppControl class entries.
  menuEl.innerHTML = '';
  const controlsArr = data.app.controls || [];
  const controlById = new Map(controlsArr.map(c => [c.id, c]));
  const menuOrder = (data.app.uiFields.MENU_ORDER || '').split(',').map(s => s.trim()).filter(Boolean);
  const menuIds = menuOrder.length > 0 ? menuOrder : controlsArr.filter(c => c.cls === 'AppControl').map(c => c.id);
  for (const id of menuIds) {
    const c = controlById.get(id);
    if (!c) continue;
    const btn = document.createElement('button');
    btn.textContent = c.textPlain || c.fields?.titleText || c.id;
    btn.title = c.gfields?.tipText || '';
    btn.dataset.scriptId = c.script || '';
    btn.addEventListener('click', () => {
      if (c.script) current.animator.runScript(c.script);
      // Light up active button; sidecar info lookup on AppControlSidecar with same script
      menuEl.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      showSidecarForScript(c.script);
    });
    menuEl.appendChild(btn);
  }

  // View dots
  viewsEl.innerHTML = '';
  const viewIds = Object.keys(data.scene.views);
  for (const id of viewIds) {
    const d = document.createElement('div');
    d.className = 'dot';
    d.title = id;
    d.dataset.viewId = id;
    d.addEventListener('click', () => {
      current.animator.goToView(id, 600);
      viewsEl.querySelectorAll('.dot').forEach(x => x.classList.remove('active'));
      d.classList.add('active');
    });
    viewsEl.appendChild(d);
  }
  // Highlight the initial view dot
  const initial = viewIds.includes('View_0') ? 'View_0' : viewIds[0];
  const initDot = [...viewsEl.children].find(d => d.dataset.viewId === initial);
  if (initDot) initDot.classList.add('active');
}

function showSidecarForScript(scriptId) {
  sidecarEl.classList.remove('open');
  if (!scriptId || !current) return;
  // Find an AppControlSidecar whose script matches.
  const sc = (current.data.app.controls || []).find(
    c => c.cls === 'AppControlSidecar' && c.script === scriptId,
  );
  if (!sc) return;
  const title = sc.gfields?.titleText || '';
  const hasContent = title || sc.textHtml?.trim() || sc.image;
  if (!hasContent) return;
  sidecarTitleEl.textContent = title;
  sidecarBodyEl.innerHTML = sc.textHtml || '';
  if (sc.image) {
    sidecarImageEl.src = `${current.data.assetDir}${sc.image}`;
    sidecarImageEl.alt = title;
  } else {
    sidecarImageEl.removeAttribute('src');
  }
  sidecarEl.classList.add('open');
}

// ----------------------------------------------------------------------------
// Object picking — click a mesh to highlight it and show its info card.
// Drag-threshold and hotspot-priority match LeptonHotspots so the existing
// orbit/pan and hotspot-click paths keep working unchanged.
// ----------------------------------------------------------------------------

const _pickRay = new THREE.Raycaster();
const _pickNdc = new THREE.Vector2();
let _pickPressX = 0, _pickPressY = 0;

canvas.addEventListener('pointerdown', (e) => {
  _pickPressX = e.clientX; _pickPressY = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  if (!current) return;
  if (!debug.flag('interaction', 'clickToPick')) return;
  if (Math.hypot(e.clientX - _pickPressX, e.clientY - _pickPressY) > 4) return;
  const rect = canvas.getBoundingClientRect();
  _pickNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  _pickNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  _pickRay.setFromCamera(_pickNdc, camera);
  // Hotspots take priority — LeptonHotspots' own pointerup will open the card.
  if (_pickRay.intersectObjects(current.hotspots.sprites, false).length > 0) return;
  // Filter to actual meshes so debug overlays (normal-line helpers) aren't selectable.
  const hits = _pickRay.intersectObject(current.root, true).filter(h => h.object.isMesh);
  selectMesh(hits.length > 0 ? hits[0].object : null);
});

function selectMesh(mesh) {
  if (!current) return;
  if (current._selected === mesh) return;
  if (current._selected) setMeshSelected(current._selected, false);
  current._selected = mesh || null;
  if (mesh) {
    setMeshSelected(mesh, true);
    showObjectInfo(mesh);
  } else {
    objectCardEl.classList.remove('open');
  }
}

function setMeshSelected(mesh, on) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    if (m && m.uniforms && m.uniforms.selected) m.uniforms.selected.value = on;
  }
}

function fmt(n) { return Number.isFinite(n) ? n.toFixed(3) : String(n); }

function showObjectInfo(mesh) {
  // mesh is the THREE.Mesh; its parent Group carries the lepton object def.
  const node = mesh.parent;
  const obj = node?.userData?.objDef;
  if (!obj) { objectCardEl.classList.remove('open'); return; }

  const matCount = Array.isArray(mesh.material) ? mesh.material.length : 1;
  const matIds = (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
    .map(m => m?.userData?.leptonId)
    .filter(Boolean);
  const pos = mesh.geometry.attributes.position;
  const idx = mesh.geometry.index;
  const triCount = idx ? (idx.count / 3) : (pos ? pos.count / 3 : 0);
  const parentObj = current.data.scene.objects.find(o => o.idx === obj.parent);

  const rows = [
    ['ID',       obj.id],
    ['Parent',   parentObj ? parentObj.id : '(root)'],
    ['Position', `${fmt(obj.x)}, ${fmt(obj.y)}, ${fmt(obj.z)}`],
    ['Rotation', `θ ${fmt(obj.theta)}°  φ ${fmt(obj.phi)}°  ψ ${fmt(obj.psi)}°`],
    ['Alpha',    obj.alpha == null ? 'inherit' : fmt(obj.alpha)],
    ['Vertices', pos ? pos.count : 0],
    ['Triangles', Math.round(triCount)],
    ['Materials', matIds.length ? `${matCount} (${matIds.join(', ')})` : String(matCount)],
  ];
  if (obj.mesh?.bin) rows.push(['Mesh bin', obj.mesh.bin]);

  objectTitleEl.textContent = obj.id;
  objectBodyEl.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${String(v)}</dd>`)
    .join('');
  buildObjectActions(node);
  objectCardEl.classList.add('open');
}

function buildObjectActions(node) {
  objectActionsEl.innerHTML = '';
  const hidden = !!node.userData.userHidden;
  const hideBtn = document.createElement('button');
  hideBtn.textContent = hidden ? 'Show' : 'Hide';
  hideBtn.setAttribute('aria-pressed', String(hidden));
  hideBtn.addEventListener('click', () => {
    node.userData.userHidden = !node.userData.userHidden;
    // propagateAlpha runs every frame and reads userHidden, so the visibility
    // change picks up automatically. Just refresh the button label.
    buildObjectActions(node);
  });
  objectActionsEl.appendChild(hideBtn);

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy ID';
  copyBtn.addEventListener('click', async () => {
    const text = node.userData.objDef?.id ?? node.name ?? '';
    const ok = await copyToClipboard(text);
    copyBtn.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => { copyBtn.textContent = 'Copy ID'; }, 1200);
  });
  objectActionsEl.appendChild(copyBtn);
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  // Legacy/fallback for non-secure contexts (file://, plain http on some browsers).
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function openHotspot(h) {
  hotspotBodyEl.innerHTML = h.textHtml || h.textPlain || '';
  if (h.image) {
    hotspotImageEl.src = `${current.data.assetDir}${h.image}`;
    hotspotImageEl.alt = '';
  } else {
    hotspotImageEl.removeAttribute('src');
  }
  hotspotCardEl.classList.add('open');
}

// ----------------------------------------------------------------------------
// Hash routing
// ----------------------------------------------------------------------------

async function loadFromHash() {
  const raw = (location.hash || '').replace(/^#/, '').trim() || DEFAULT_HASH;
  const [pathPart, token] = raw.split(';');
  // Prefer the model index entry — it knows the asset dir for non-catalog
  // scenes (modules, vrnull). Fallback to the legacy catalog path so old URLs
  // keep working before models.json has loaded.
  const entry = modelsById.get(pathPart);
  let assetDir;
  if (entry) {
    assetDir = `${DUMPS_BASE}${entry.dir}/`;
  } else {
    const parts = pathPart.split('/').filter(Boolean);
    if (parts.length < 2) {
      loaderEl.textContent = `Invalid URL: #${raw}`;
      return;
    }
    assetDir = `${CATALOG_BASE}${parts.join('/')}/lepton/`;
  }
  if (pickerSelectEl) pickerSelectEl.value = pathPart;
  loaderEl.classList.remove('hidden');
  loaderEl.textContent = 'Loading…';
  // Drop any selection from the previous scene; old materials are about to be torn down.
  objectCardEl.classList.remove('open');

  try {
    const data = await loadLepton(assetDir);
    await buildScene(data);
    loaderEl.classList.add('hidden');
    if (token) resolveToken(token);
  } catch (err) {
    console.error(err);
    loaderEl.textContent = `Error: ${err.message}`;
  }
}

function resolveToken(token) {
  if (!current) return;
  const { data, animator, hotspots } = current;
  if (data.scene.views[token]) { animator.goToView(token, 0); return; }
  const ctrl = (data.app.controls || []).find(c => c.id === token || c.script === token);
  if (ctrl) {
    if (ctrl.script) animator.runScript(ctrl.script);
    showSidecarForScript(ctrl.script);
    return;
  }
  if (hotspots.focus(token)) return;
  console.warn('[lepton] token not found in views/controls/hotspots:', token);
}

// ----------------------------------------------------------------------------
// Render loop
// ----------------------------------------------------------------------------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  controls.resize();
}
window.addEventListener('resize', resize);
resize();

function animate() {
  if (stopRAF) return;
  requestAnimationFrame(animate);
  if (current) {
    current.animator.update();
    propagateAlpha();
    controls.update();
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    current.hotspots.update();
    updateLeptonUniforms(current.allMaterials, camera);
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
}

window.addEventListener('hashchange', loadFromHash);

// ----------------------------------------------------------------------------
// Model picker (populated from viewer/models.json built by tools/build_model_index.py)
// ----------------------------------------------------------------------------

function renderModelPicker(models) {
  if (!pickerSelectEl) return;
  pickerSelectEl.innerHTML = '';
  // Group by category, preserving the index file's sort order within each group.
  const groups = new Map();
  for (const m of models) {
    const cat = m.category || 'Other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(m);
  }
  for (const [cat, items] of groups) {
    const og = document.createElement('optgroup');
    og.label = cat;
    for (const m of items) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name + (m.kind === 'module' && !/vrnull|sample|scene/.test(m.name) ? '' : '');
      og.appendChild(opt);
    }
    pickerSelectEl.appendChild(og);
  }
  const current = (location.hash || '').replace(/^#/, '').split(';')[0].trim() || DEFAULT_HASH;
  if (modelsById.has(current)) pickerSelectEl.value = current;
  pickerSelectEl.addEventListener('change', () => {
    const id = pickerSelectEl.value;
    if (!id) return;
    if (location.hash === `#${id}`) loadFromHash();
    else location.hash = id;
  });
}

async function loadModelIndex() {
  try {
    const res = await fetch('./models.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    modelsById = new Map((data.models || []).map(m => [m.id, m]));
    renderModelPicker(data.models || []);
  } catch (err) {
    console.warn('[lepton] model index unavailable, picker disabled:', err.message);
    if (pickerSelectEl && pickerSelectEl.parentElement) {
      pickerSelectEl.parentElement.style.display = 'none';
    }
  }
}

// Load the index first so the very first hash resolution can use it; then
// kick off the asset load + render loop.
loadModelIndex().then(loadFromHash).then(() => animate());
