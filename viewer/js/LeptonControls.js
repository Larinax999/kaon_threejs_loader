// LeptonControls.js — Kaon-style orbit camera.
// View parameters come straight from lepton.xml <view>: theta (yaw, deg),
// phi (pitch, deg; negative=camera above), dist, lookAt (x,y,z), fov,
// cx/cy (principal-point offset, normalized), phi/fov clamps.
//
// Kaon zoom is FOV-based (not distance); every view ships its own min/max FOV.

import * as THREE from 'three';

const DEG = Math.PI / 180;

function sphericalOffset(thetaDeg, phiDeg, dist) {
  const t = thetaDeg * DEG, p = phiDeg * DEG;
  // Convention: phi < 0 ⇒ camera above horizon (looking down).
  return new THREE.Vector3(
    Math.sin(t) * Math.cos(p) * dist,
    -Math.sin(p) * dist,
    Math.cos(t) * Math.cos(p) * dist,
  );
}

function easeInOut(t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; }

function wrapAngle(a, ref) {
  // Bring `a` into the half-open ±180 window around `ref` so tweens take the short path.
  while (a - ref > 180) a -= 360;
  while (a - ref < -180) a += 360;
  return a;
}

export class LeptonControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;

    this.state = {
      theta: 0, phi: 0, dist: 10, fov: 30,
      lookAt: new THREE.Vector3(),
      cx: 0.5, cy: 0.5,
      minPhi: -89, maxPhi: 89,
      minFOV: 5, maxFOV: 60,
    };
    this._tween = null;
    this._dragging = false;
    this._lastX = 0; this._lastY = 0;
    this._pinchDist = 0;
    this._onChange = null;

    this._bind();
  }

  onChange(fn) { this._onChange = fn; }

  _bind() {
    const el = this.dom;
    el.addEventListener('pointerdown', (e) => {
      this._dragging = true;
      this._lastX = e.clientX; this._lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      this._cancelTween();
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX; this._lastY = e.clientY;
      // Scale rotation by current FOV — tighter FOV = slower rotation.
      const rotScale = this.state.fov / 40;
      this.state.theta -= dx * 0.3 * rotScale;
      this.state.phi   -= dy * 0.3 * rotScale;
      this._clampPhi();
      this._apply();
    });
    const endDrag = (e) => {
      this._dragging = false;
      try { el.releasePointerCapture(e.pointerId); } catch {}
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._cancelTween();
      const factor = Math.exp(e.deltaY * 0.001);
      this.state.fov = Math.max(this.state.minFOV, Math.min(this.state.maxFOV, this.state.fov * factor));
      this._apply();
    }, { passive: false });

    // Touch pinch zoom
    const touches = new Map();
    el.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        this._pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (touches.has(t.identifier)) touches.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (this._pinchDist > 0) {
          const factor = this._pinchDist / d;
          this.state.fov = Math.max(this.state.minFOV, Math.min(this.state.maxFOV, this.state.fov * factor));
          this._apply();
        }
        this._pinchDist = d;
      }
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) touches.delete(t.identifier);
      if (touches.size < 2) this._pinchDist = 0;
    });
  }

  _clampPhi() {
    const s = this.state;
    s.phi = Math.max(s.minPhi, Math.min(s.maxPhi, s.phi));
  }

  /** Snap to view immediately. */
  setView(view) {
    this._cancelTween();
    Object.assign(this.state, {
      theta: view.theta, phi: view.phi, dist: view.dist, fov: view.fov,
      cx: view.cx, cy: view.cy,
      minPhi: view.minPhi, maxPhi: view.maxPhi,
      minFOV: view.minFOV, maxFOV: view.maxFOV,
    });
    this.state.lookAt.set(view.x, view.y, view.z);
    this._apply();
  }

  /** Tween to view over `durationMs`. */
  tweenToView(view, durationMs = 800) {
    this._cancelTween();
    const s = this.state;
    const from = {
      theta: s.theta, phi: s.phi, dist: s.dist, fov: s.fov,
      cx: s.cx, cy: s.cy,
      lookAt: s.lookAt.clone(),
    };
    const to = {
      theta: wrapAngle(view.theta, s.theta),
      phi: view.phi, dist: view.dist, fov: view.fov,
      cx: view.cx, cy: view.cy,
      lookAt: new THREE.Vector3(view.x, view.y, view.z),
    };
    const tween = {
      t0: performance.now(), dur: durationMs, from, to, view,
    };
    this._tween = tween;
    // Clamps become active immediately (permissive during tween, strict after).
    s.minPhi = Math.min(s.minPhi, view.minPhi);
    s.maxPhi = Math.max(s.maxPhi, view.maxPhi);
    s.minFOV = Math.min(s.minFOV, view.minFOV);
    s.maxFOV = Math.max(s.maxFOV, view.maxFOV);
  }

  _cancelTween() {
    if (!this._tween) return;
    const { view } = this._tween;
    // Lock to target view's clamps once the tween ends.
    if (view) {
      Object.assign(this.state, { minPhi: view.minPhi, maxPhi: view.maxPhi, minFOV: view.minFOV, maxFOV: view.maxFOV });
    }
    this._tween = null;
  }

  update(now = performance.now()) {
    const tw = this._tween;
    if (tw) {
      const u = Math.min(1, (now - tw.t0) / tw.dur);
      const k = easeInOut(u);
      const s = this.state;
      s.theta = tw.from.theta + (tw.to.theta - tw.from.theta) * k;
      s.phi = tw.from.phi + (tw.to.phi - tw.from.phi) * k;
      s.dist = tw.from.dist + (tw.to.dist - tw.from.dist) * k;
      s.fov = tw.from.fov + (tw.to.fov - tw.from.fov) * k;
      s.cx = tw.from.cx + (tw.to.cx - tw.from.cx) * k;
      s.cy = tw.from.cy + (tw.to.cy - tw.from.cy) * k;
      s.lookAt.lerpVectors(tw.from.lookAt, tw.to.lookAt, k);
      if (u >= 1) this._cancelTween();
    }
    this._apply();
  }

  _apply() {
    const s = this.state;
    const cam = this.camera;
    const offset = sphericalOffset(s.theta, s.phi, s.dist);
    cam.position.copy(s.lookAt).add(offset);
    cam.up.set(0, 1, 0);
    cam.lookAt(s.lookAt);

    if (cam.fov !== s.fov) { cam.fov = s.fov; cam.updateProjectionMatrix(); }

    // Principal-point offset via setViewOffset. cx=0.5,cy=0.5 is a no-op.
    // Mirrors Kaon's reference engine (dumps/lepton_webgl_obf.js): cy is read
    // as (1 - cy_xml) and the NDC shift is aspect-corrected so the smaller
    // viewport dimension governs both axes. The (0.5 - cy) sign in the derived
    // setViewOffset formula absorbs Kaon's cy flip, so the loader keeps cy raw.
    const el = this.dom;
    const W = el.clientWidth, H = el.clientHeight;
    if (Math.abs(s.cx - 0.5) < 1e-4 && Math.abs(s.cy - 0.5) < 1e-4) {
      cam.clearViewOffset();
    } else {
      const m = Math.min(W, H);
      const offX = (s.cx - 0.5) * m;
      const offY = (s.cy - 0.5) * m;
      cam.setViewOffset(W, H, offX, offY, W, H);
    }

    if (this._onChange) this._onChange();
  }

  resize() { this._apply(); }
}
