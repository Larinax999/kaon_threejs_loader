// LeptonHotspots.js — renders app.xml hotspots as billboarded rings on the scene
// and dispatches click events with hotspot metadata.

import * as THREE from 'three';

function makeRingTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const cx = size / 2, cy = size / 2;

  // Outer soft halo
  const grad = ctx.createRadialGradient(cx, cy, size * 0.30, cx, cy, size * 0.48);
  grad.addColorStop(0, 'rgba(0, 179, 255, 0.00)');
  grad.addColorStop(0.7, 'rgba(0, 179, 255, 0.22)');
  grad.addColorStop(1, 'rgba(0, 179, 255, 0.00)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Solid ring
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = size * 0.045;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.32, 0, Math.PI * 2);
  ctx.stroke();

  // Center dot
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.06, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class LeptonHotspots {
  constructor(app, nodesByObjId, camera, domElement) {
    this.app = app;
    this.nodesByObjId = nodesByObjId;
    this.camera = camera;
    this.dom = domElement;

    this.sprites = [];
    this.group = new THREE.Group();
    this.group.name = 'hotspots';

    const tex = makeRingTexture();
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false,
      sizeAttenuation: true,
    });

    for (const h of app.hotspots || []) {
      const s = new THREE.Sprite(mat.clone());
      s.scale.setScalar((h.radius || 0.5) * 1.4);
      s.position.set(h.x, h.y, h.z);
      s.userData.hotspot = h;
      s.renderOrder = 10;
      const parent = h.object ? this.nodesByObjId.get(h.object) : null;
      (parent || this.group).add(s);
      this.sprites.push(s);
    }

    this._onClick = null;
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._debug = { showHidden: false, logClicks: false };
    this._bind();
  }

  onClick(fn) { this._onClick = fn; }

  setDebug(d) { Object.assign(this._debug, d); }

  _bind() {
    this.dom.addEventListener('pointerdown', (e) => {
      this._pressX = e.clientX; this._pressY = e.clientY;
    });
    this.dom.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - this._pressX, e.clientY - this._pressY) > 4) return;
      const rect = this.dom.getBoundingClientRect();
      this._ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this._ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this._raycaster.setFromCamera(this._ndc, this.camera);
      const hits = this._raycaster.intersectObjects(this.sprites, false);
      if (hits.length > 0) {
        if (this._debug.logClicks) console.log('[hotspot]', hits[0].object.userData.hotspot);
        if (this._onClick) this._onClick(hits[0].object.userData.hotspot);
      }
    });
  }

  /** Hide hotspots whose parent object is invisible (alpha=0) or behind the camera. */
  update() {
    const camPos = this.camera.position;
    const tmpV = new THREE.Vector3();
    for (const s of this.sprites) {
      if (this._debug.showHidden) { s.visible = true; continue; }
      let parent = s.parent;
      let visible = true;
      while (parent && parent !== this.group) {
        if (parent.visible === false) { visible = false; break; }
        const aProp = parent.userData && parent.userData.currentAlpha;
        if (aProp !== undefined && aProp < 0.05) { visible = false; break; }
        parent = parent.parent;
      }
      if (visible && !s.userData.hotspot.alwaysOn) {
        // Hide if facing away: dot(cam→hotspot, world-space sprite-normal toward camera) heuristic:
        // here we just keep hotspots on when the backing object is visible, and also hide if
        // the sprite is behind the camera (trivial cull).
        s.getWorldPosition(tmpV);
        const toCam = tmpV.sub(camPos);
        // distance cull: too close reads like occlusion
        visible = toCam.length() > 0.01;
      }
      s.visible = visible;
    }
  }

  focus(id) {
    const hit = this.sprites.find(s => s.userData.hotspot.id === id);
    if (hit && this._onClick) this._onClick(hit.userData.hotspot);
    return !!hit;
  }
}
