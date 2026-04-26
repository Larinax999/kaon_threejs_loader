// LeptonAnimator.js — applies <sequence> waypoint interpolation to scene nodes
// and runs <script> timelines.
//
// Sequence model:
//  - Each sequence targets an object by id and has waypoints sorted by `wp` (0..1).
//  - A waypoint's `mask` hints which channels it contributes (1=pos, 4=rot, 8=alpha,
//    256=scale). In practice we just apply whatever attributes are present.
//  - The sequence has a current `wp` that can be set (snap) or tweened.
//
// Script model:
//  - `<at t="..." sequence="X" wp="W">` schedules sequence X to reach wp=W at time t,
//    linearly interpolated from its previous scheduled value for X.
//  - `<at t="..." view="V">` triggers a view tween on the controls.
//  - `<before script="Y" duration="..."/>` runs Y first (we run it immediately).

import * as THREE from 'three';

const DEG = Math.PI / 180;

function lerp(a, b, k) { return a + (b - a) * k; }

/** Given waypoints and wp value, interpolate between the bracketing waypoints. */
function sampleWaypoints(wps, wp) {
  if (wps.length === 0) return null;
  if (wp <= wps[0].wp) return { ...wps[0] };
  if (wp >= wps[wps.length - 1].wp) return { ...wps[wps.length - 1] };
  let a = wps[0], b = wps[1];
  for (let i = 0; i < wps.length - 1; ++i) {
    if (wp >= wps[i].wp && wp <= wps[i + 1].wp) { a = wps[i]; b = wps[i + 1]; break; }
  }
  const span = b.wp - a.wp || 1;
  const k = (wp - a.wp) / span;
  const out = { wp };
  const attrs = ['x','y','z','theta','phi','psi','scaleX','scaleY','scaleZ','alpha'];
  for (const key of attrs) {
    const av = a[key], bv = b[key];
    if (av !== undefined && bv !== undefined) out[key] = lerp(av, bv, k);
    else if (av !== undefined) out[key] = av;
    else if (bv !== undefined) out[key] = bv;
  }
  return out;
}

export class LeptonAnimator {
  /**
   * @param {object} sceneData  — from LeptonLoader (scene.sequences, scripts, objects, etc.)
   * @param {Map<string, THREE.Object3D>} nodesByObjId
   * @param {function(string):void} [setNodeAlpha] — called with (objId, alpha) when alpha changes;
   *        useful for pushing alpha to materials (nodes drive material uniforms via the viewer).
   * @param {object} controls   — LeptonControls instance, for view tweens
   * @param {Map<string, object>} views
   */
  constructor(sceneData, nodesByObjId, controls, views, setNodeAlpha) {
    this.scene = sceneData;
    this.nodesByObjId = nodesByObjId;
    this.controls = controls;
    this.views = views;
    this.setNodeAlpha = setNodeAlpha || (() => {});

    // Per-sequence state: { currentWp, lastSetAt, history:[{time, wp}] }
    this.seqState = new Map();
    for (const id of Object.keys(this.scene.sequences || {})) {
      this.seqState.set(id, { currentWp: 0, history: [] });
    }

    // Per-node baseline (resting) TRS captured at construction.
    this.baseline = new Map();
    for (const obj of this.scene.objects) {
      const node = this.nodesByObjId.get(obj.id);
      if (!node) continue;
      this.baseline.set(obj.id, {
        position: node.position.clone(),
        rotation: node.rotation.clone(),
        scale: node.scale.clone(),
        alpha: obj.alpha != null ? obj.alpha : 1.0,
      });
    }

    // Running script instances: each tracks its start time and ordered event list.
    this.runningScripts = [];
  }

  /** Set a sequence's wp immediately (no tween). */
  setSequenceWp(seqId, wp) {
    const st = this.seqState.get(seqId);
    if (!st) return;
    st.currentWp = wp;
    this._applySequence(seqId, wp);
  }

  _applySequence(seqId, wp) {
    const seq = this.scene.sequences[seqId];
    if (!seq || !seq.object) return;
    const targetId = seq.object;
    const node = this.nodesByObjId.get(targetId);
    if (!node) return;
    const base = this.baseline.get(targetId);
    if (!base) return;
    const sample = sampleWaypoints(seq.waypoints, wp);
    if (!sample) return;

    // Position: waypoint coords are ABSOLUTE in the object's local-frame slot.
    if (sample.x !== undefined || sample.y !== undefined || sample.z !== undefined) {
      node.position.set(
        sample.x !== undefined ? sample.x : base.position.x,
        sample.y !== undefined ? sample.y : base.position.y,
        sample.z !== undefined ? sample.z : base.position.z,
      );
    }
    // Rotation: waypoint angles (deg) override corresponding Euler slot (YXZ order).
    if (sample.theta !== undefined || sample.phi !== undefined || sample.psi !== undefined) {
      const e = node.rotation;
      const theta = sample.theta !== undefined ? sample.theta * DEG : e.y;  // Y slot holds theta
      const phi   = sample.phi   !== undefined ? sample.phi   * DEG : e.x;  // X slot holds phi
      const psi   = sample.psi   !== undefined ? sample.psi   * DEG : e.z;  // Z slot holds psi
      node.rotation.set(phi, theta, psi, 'YXZ');
    }
    // Scale
    if (sample.scaleX !== undefined || sample.scaleY !== undefined || sample.scaleZ !== undefined) {
      node.scale.set(
        sample.scaleX !== undefined ? sample.scaleX : base.scale.x,
        sample.scaleY !== undefined ? sample.scaleY : base.scale.y,
        sample.scaleZ !== undefined ? sample.scaleZ : base.scale.z,
      );
    }
    // Alpha — pushed through callback so viewer can propagate to materials.
    // Visibility is owned by propagateAlpha (only flipped on mesh-bearing
    // nodes), so we don't touch node.visible here — toggling it on a parent
    // transform like ROOT would hide independently-alphaed children too.
    if (sample.alpha !== undefined) {
      this.setNodeAlpha(targetId, sample.alpha);
    }
  }

  /** Jump to a view by id. */
  goToView(viewId, durationMs = 800) {
    const v = this.views[viewId];
    if (!v) { console.warn('[lepton] unknown view', viewId); return; }
    if (durationMs <= 0) this.controls.setView(v);
    else this.controls.tweenToView(v, durationMs);
  }

  /**
   * Run the init script at t=0 — snap all sequences and the initial view.
   */
  applyInit() {
    const id = this.scene.initScript;
    if (!id) return;
    const script = this.scene.scripts[id];
    if (!script) return;
    // Execute every event as-if t=0: set wp immediately, set view without tween.
    const t0events = [...script.events].filter(ev => ev.tag === 'at');
    // sort by t to be safe
    t0events.sort((a, b) => parseFloat(a.t || '0') - parseFloat(b.t || '0'));
    for (const ev of t0events) {
      if (ev.view) this.goToView(ev.view, 0);
      if (ev.sequence) this.setSequenceWp(ev.sequence, parseFloat(ev.wp || '0'));
    }
  }

  /** Start running a script by id. */
  runScript(scriptId) {
    const script = this.scene.scripts[scriptId];
    if (!script) { console.warn('[lepton] unknown script', scriptId); return; }

    // <before script="…"/> prerequisites — run first, immediately, from their final state.
    for (const ev of script.events) {
      if (ev.tag === 'before' && ev.script && ev.script !== scriptId) {
        this._applyScriptFinalState(ev.script);
      }
    }

    // Build a per-sequence schedule: [{t, wp}, ...] plus a flat view schedule.
    const seqSchedules = new Map();
    const viewSchedule = [];
    for (const ev of script.events) {
      if (ev.tag !== 'at') continue;
      const t = parseFloat(ev.t || '0');
      if (ev.sequence) {
        const wp = parseFloat(ev.wp || '0');
        if (!seqSchedules.has(ev.sequence)) seqSchedules.set(ev.sequence, []);
        seqSchedules.get(ev.sequence).push({ t, wp });
      }
      if (ev.view) {
        viewSchedule.push({ t, view: ev.view });
      }
    }
    for (const arr of seqSchedules.values()) arr.sort((a, b) => a.t - b.t);
    viewSchedule.sort((a, b) => a.t - b.t);

    // Seed each schedule with the current wp at t=0 so tweens start from current state.
    for (const [seqId, arr] of seqSchedules) {
      const cur = this.seqState.get(seqId);
      if (!arr.length || arr[0].t > 0) arr.unshift({ t: 0, wp: cur ? cur.currentWp : 0 });
    }

    this.runningScripts.push({
      id: scriptId,
      t0: performance.now(),
      seqSchedules,
      viewSchedule,
      viewCursor: 0,
      totalLen: script.length || 2,
    });
  }

  /** Helper used by `<before script>`: set all sequence wps of a script to their *last* scheduled value. */
  _applyScriptFinalState(scriptId) {
    const s = this.scene.scripts[scriptId];
    if (!s) return;
    const finalWp = new Map();
    for (const ev of s.events) {
      if (ev.tag !== 'at' || !ev.sequence) continue;
      finalWp.set(ev.sequence, parseFloat(ev.wp || '0'));
    }
    for (const [seqId, wp] of finalWp) this.setSequenceWp(seqId, wp);
  }

  /** Called each frame. */
  update(nowMs = performance.now()) {
    if (this.runningScripts.length === 0) return;
    const stillRunning = [];
    for (const inst of this.runningScripts) {
      const t = (nowMs - inst.t0) / 1000;  // seconds
      let active = false;

      // Sequences: linearly interpolate between bracketing (t,wp) pairs.
      for (const [seqId, arr] of inst.seqSchedules) {
        let a = arr[0], b = arr[arr.length - 1];
        if (t <= arr[0].t) { a = b = arr[0]; }
        else if (t >= arr[arr.length - 1].t) { a = b = arr[arr.length - 1]; }
        else {
          for (let i = 0; i < arr.length - 1; ++i) {
            if (t >= arr[i].t && t <= arr[i + 1].t) { a = arr[i]; b = arr[i + 1]; break; }
          }
        }
        let wp;
        if (a === b) wp = a.wp;
        else {
          const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
          wp = a.wp + (b.wp - a.wp) * k;
        }
        const st = this.seqState.get(seqId);
        if (st) st.currentWp = wp;
        this._applySequence(seqId, wp);
        if (t < arr[arr.length - 1].t) active = true;
      }

      // Views: fire each one as the timeline crosses its t.
      while (inst.viewCursor < inst.viewSchedule.length &&
             t >= inst.viewSchedule[inst.viewCursor].t) {
        const v = inst.viewSchedule[inst.viewCursor++];
        // If this is a future view event, tween; otherwise snap.
        this.goToView(v.view, 800);
      }
      if (inst.viewCursor < inst.viewSchedule.length) active = true;

      if (t < inst.totalLen) active = true;
      if (active) stillRunning.push(inst);
    }
    this.runningScripts = stillRunning;
  }
}
