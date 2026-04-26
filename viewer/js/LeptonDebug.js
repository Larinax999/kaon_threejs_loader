// LeptonDebug.js — collapsible debug panel + overlay manager. Owns flag state,
// persists it to localStorage, builds the panel UI, and pushes flags into the
// active scene (materials, hotspots, axes/bbox/normals overlays).

import * as THREE from 'three';

const STORAGE_KEY = 'lepton.debug';

// Default state, also the source of truth for which keys exist. Saved values
// are shallow-merged onto this on load — unknown keys are dropped, new keys
// pick up defaults.
const DEFAULT_FLAGS = {
  render: {
    normals:    false,
    axes:       false,
    bbox:       false,
    wireframe:  false,
    noTextures: false,
    flatShade:  false,
    backface:   false,
  },
  hotspots: {
    showHidden: false,
    logClicks:  false,
  },
  interaction: {
    clickToPick: true,
  },
};

const LABELS = {
  render: {
    title: 'Rendering',
    flags: {
      wireframe:  'Wireframe',
      noTextures: 'No textures',
      flatShade:  'Flat shading',
      backface:   'Backface',
      normals:    'Show normals',
      axes:       'Show axes',
      bbox:       'Bounding boxes',
    },
  },
  hotspots: {
    title: 'Hotspots',
    flags: {
      showHidden: 'Show invisible',
      logClicks:  'Log clicks',
    },
  },
  interaction: {
    title: 'Interaction',
    flags: {
      clickToPick: 'Click to select',
    },
  },
};

function loadFlags() {
  const out = structuredClone(DEFAULT_FLAGS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const saved = JSON.parse(raw);
    for (const group of Object.keys(out)) {
      if (saved && saved[group]) {
        for (const key of Object.keys(out[group])) {
          if (typeof saved[group][key] === 'boolean') out[group][key] = saved[group][key];
        }
      }
    }
  } catch { /* ignore corrupted state */ }
  return out;
}

// Build a LineSegments helper that draws each vertex's normal as a short line
// outward from the surface. Length is scaled per-mesh to its bounding sphere.
function buildNormalsLines(mesh) {
  const geom = mesh.geometry;
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  if (!pos || !nrm) return null;
  if (!geom.boundingSphere) geom.computeBoundingSphere();
  const length = (geom.boundingSphere?.radius || 1) * 0.04;
  const n = pos.count;
  const verts = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
    const o = i * 6;
    verts[o    ] = px;            verts[o + 1] = py;            verts[o + 2] = pz;
    verts[o + 3] = px + nx * length;
    verts[o + 4] = py + ny * length;
    verts[o + 5] = pz + nz * length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  return new THREE.LineSegments(
    g,
    new THREE.LineBasicMaterial({ color: 0x00ff88, depthTest: false, transparent: true, opacity: 0.85 }),
  );
}

export class LeptonDebug {
  constructor({ toggleEl, panelEl, scene, onChange }) {
    this.toggleEl = toggleEl;
    this.panelEl  = panelEl;
    this.scene    = scene;
    this._flags   = loadFlags();
    this._current = null;
    this._overlays = { axes: null, bbox: [], normals: [] };
    this._onChange = onChange || null;

    this._buildPanel();
    this._bindToggle();
  }

  /** Read a flag value, e.g. debug.flag('interaction', 'clickToPick'). */
  flag(group, key) { return this._flags[group]?.[key]; }

  _bindToggle() {
    this.toggleEl.addEventListener('click', () => {
      const open = this.toggleEl.getAttribute('aria-expanded') === 'true';
      this.toggleEl.setAttribute('aria-expanded', String(!open));
      this.panelEl.hidden = open;
    });
  }

  _buildPanel() {
    this.panelEl.innerHTML = '';
    for (const groupKey of Object.keys(LABELS)) {
      const groupDef = LABELS[groupKey];
      const header = document.createElement('div');
      header.className = 'debug-section';
      header.textContent = groupDef.title;
      this.panelEl.appendChild(header);
      for (const flagKey of Object.keys(groupDef.flags)) {
        const label = document.createElement('label');
        label.className = 'debug-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this._flags[groupKey][flagKey];
        cb.addEventListener('change', () => this._onToggle(groupKey, flagKey, cb.checked));
        const span = document.createElement('span');
        span.textContent = groupDef.flags[flagKey];
        label.appendChild(cb);
        label.appendChild(span);
        this.panelEl.appendChild(label);
      }
    }
  }

  _onToggle(group, key, value) {
    this._flags[group][key] = value;
    this._persist();
    if (this._current) this.apply(this._current);
    if (this._onChange) this._onChange(group, key, value);
  }

  _persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._flags)); } catch { /* quota / disabled */ }
  }

  /** Re-apply all flags against the freshly-built scene. Safe to call repeatedly. */
  apply(current) {
    this._current = current;
    if (!current) return;
    this._applyMaterials(current);
    this._applyOverlays(current);
    this._applyHotspots(current);
  }

  _applyMaterials(current) {
    const f = this._flags.render;
    for (const m of current.allMaterials) {
      if (!m) continue;
      m.wireframe = f.wireframe;
      m.uniforms.debugBackface.value = f.backface;
      m.uniforms.debugNoTex.value    = f.noTextures;
      m.uniforms.debugFlat.value     = f.flatShade;
      const baseSide = m.userData.leptonBackface ? THREE.DoubleSide : THREE.FrontSide;
      const desired = f.backface ? THREE.DoubleSide : baseSide;
      if (m.side !== desired) { m.side = desired; m.needsUpdate = true; }
    }
  }

  _applyOverlays(current) {
    const f = this._flags.render;
    this._rebuildOverlaysIfStale(current);
    if (this._overlays.axes) this._overlays.axes.visible = f.axes;
    for (const h of this._overlays.bbox) h.visible = f.bbox;
    for (const h of this._overlays.normals) h.visible = f.normals;
  }

  _rebuildOverlaysIfStale(current) {
    if (this._overlays._builtFor === current) return;

    // Tear down anything from the previous scene.
    if (this._overlays.axes) {
      this.scene.remove(this._overlays.axes);
      this._overlays.axes.geometry?.dispose();
      this._overlays.axes.material?.dispose();
    }
    for (const h of this._overlays.bbox) {
      h.parent?.remove(h);
      h.geometry?.dispose();
      h.material?.dispose();
    }
    for (const h of this._overlays.normals) {
      h.parent?.remove(h);
      h.geometry?.dispose();
      h.material?.dispose();
    }
    this._overlays.bbox = [];
    this._overlays.normals = [];

    // Axes: size to the scene's bounding sphere so it's visible regardless of model scale.
    const box = new THREE.Box3().setFromObject(current.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const axesSize = (sphere.radius || 1) * 1.2;
    const axes = new THREE.AxesHelper(axesSize);
    axes.material.depthTest = false;
    axes.renderOrder = 999;
    axes.visible = false;
    this.scene.add(axes);
    this._overlays.axes = axes;

    // Bbox + normals: per mesh in the loaded root.
    current.root.traverse((obj) => {
      if (!obj.isMesh) return;
      const bbox = new THREE.BoxHelper(obj, 0xffff00);
      bbox.material.depthTest = false;
      bbox.visible = false;
      this.scene.add(bbox);
      this._overlays.bbox.push(bbox);

      const lines = buildNormalsLines(obj);
      if (lines) {
        lines.visible = false;
        obj.parent.add(lines);
        lines.position.copy(obj.position);
        lines.rotation.copy(obj.rotation);
        lines.scale.copy(obj.scale);
        this._overlays.normals.push(lines);
      }
    });

    this._overlays._builtFor = current;
  }

  _applyHotspots(current) {
    if (current.hotspots && typeof current.hotspots.setDebug === 'function') {
      current.hotspots.setDebug(this._flags.hotspots);
    }
  }
}
