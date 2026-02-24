import * as THREE from 'three';

// Lightweight mobile touch controls:
// - Left thumb: virtual joystick (move)
// - Right thumb drag: look (yaw/pitch)
// - Buttons: punch / grab-throw / sprint
//
// The Player reads movement axes from game.mobile when present.

export class MobileControls {
  constructor({ game, canvas, ui }) {
    this.game = game;
    this.canvas = canvas;
    this.ui = ui;

    // Shared state read by Player.update()
    game.mobile = game.mobile || { active: true, forward: 0, strafe: 0, run: false };
    game.mobile.active = true;

    // Sensitivity tuning
    this.lookSensitivity = 0.0045; // radians per px
    this.pitchMin = -Math.PI / 2 + 0.08;
    this.pitchMax = Math.PI / 2 - 0.08;

    // Internal joystick state
    this._joyId = null;
    this._joyCenter = { x: 0, y: 0 };
    this._joyVec = { x: 0, y: 0 };
    this._lookId = null;
    this._lookLast = { x: 0, y: 0 };

    this._bind();
    this._updateUI(0, 0);
  }

  dispose() {
    const { joystick, look } = this.ui;
    joystick?.removeEventListener('pointerdown', this._onJoyDown);
    look?.removeEventListener('pointerdown', this._onLookDown);
    window.removeEventListener('pointermove', this._onPtrMove);
    window.removeEventListener('pointerup', this._onPtrUp);
    window.removeEventListener('pointercancel', this._onPtrUp);
  }

  _bind() {
    const { joystick, look, punchBtn, grabBtn, sprintBtn } = this.ui;

    if (look) look.style.pointerEvents = 'auto';
    if (joystick) joystick.style.pointerEvents = 'auto';

    // prevent browser gestures while playing
    [joystick, look, punchBtn, grabBtn, sprintBtn, this.canvas]
      .filter(Boolean)
      .forEach((el) => {
        el.style.touchAction = 'none';
      });

    // Joystick
    this._onJoyDown = (e) => {
      e.preventDefault?.();
      if (this._joyId !== null) return;
      this._joyId = e.pointerId;
      joystick.setPointerCapture?.(e.pointerId);
      const r = joystick.getBoundingClientRect();
      this._joyCenter.x = r.left + r.width / 2;
      this._joyCenter.y = r.top + r.height / 2;
      this._joyVec.x = 0;
      this._joyVec.y = 0;
      this._applyMove();
    };
    joystick?.addEventListener('pointerdown', this._onJoyDown);

    // Look area
    this._onLookDown = (e) => {
      e.preventDefault?.();
      if (this._lookId !== null) return;
      this._lookId = e.pointerId;
      look.setPointerCapture?.(e.pointerId);
      this._lookLast.x = e.clientX;
      this._lookLast.y = e.clientY;
    };
    look?.addEventListener('pointerdown', this._onLookDown);

    // Global pointer move/up so we don't lose tracking
    this._onPtrMove = (e) => {
      if (e.pointerId === this._joyId || e.pointerId === this._lookId) { e.preventDefault?.(); }
      if (e.pointerId === this._joyId) {
        const dx = e.clientX - this._joyCenter.x;
        const dy = e.clientY - this._joyCenter.y;
        const max = 48;
        const len = Math.hypot(dx, dy);
        const k = len > max ? (max / (len || 1)) : 1;
        this._joyVec.x = dx * k;
        this._joyVec.y = dy * k;
        this._applyMove();
      }
      if (e.pointerId === this._lookId) {
        const dx = e.clientX - this._lookLast.x;
        const dy = e.clientY - this._lookLast.y;
        this._lookLast.x = e.clientX;
        this._lookLast.y = e.clientY;
        this._applyLook(dx, dy);
      }
    };
    this._onPtrUp = (e) => {
      if (e.pointerId === this._joyId) {
        this._joyId = null;
        this._joyVec.x = 0;
        this._joyVec.y = 0;
        this._applyMove();
      }
      if (e.pointerId === this._lookId) {
        this._lookId = null;
      }
    };
    window.addEventListener('pointermove', this._onPtrMove, { passive: false });
    window.addEventListener('pointerup', this._onPtrUp, { passive: false });
    window.addEventListener('pointercancel', this._onPtrUp, { passive: false });

    // Buttons
    const punch = () => this.game?.player?.punch?.();
    const grabToggle = () => this.game?.player?.toggleGrab?.();

    const stop = (e) => { try { e.preventDefault(); } catch {} try { e.stopPropagation(); } catch {} };
    const dedupe = (e) => {
      const now = performance.now ? performance.now() : Date.now();
      if (this._btnLast && (now - this._btnLast) < 250) return true;
      // If a pointer event fires, ignore the follow-up synthetic touch (or vice versa)
      this._btnLast = now;
      return false;
    };

    const bindTap = (el, fn) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => { stop(e); if (dedupe(e)) return; fn(); }, { passive:false });
      el.addEventListener('touchstart', (e) => { stop(e); if (dedupe(e)) return; fn(); }, { passive:false });
    };

    bindTap(punchBtn, punch);
    bindTap(grabBtn, grabToggle);

    // Sprint is hold-to-run
    const setRun = (v) => {
      this.game.mobile.run = !!v;
      if (sprintBtn) sprintBtn.classList.toggle('active', !!v);
    };

    const runStart = (e) => { stop(e); if (dedupe(e)) return; setRun(true); };
    const runEnd = (e) => { stop(e); setRun(false); };

    sprintBtn?.addEventListener('pointerdown', runStart, { passive:false });
    sprintBtn?.addEventListener('pointerup', runEnd, { passive:false });
    sprintBtn?.addEventListener('pointercancel', runEnd, { passive:false });
    sprintBtn?.addEventListener('pointerleave', runEnd, { passive:false });

    sprintBtn?.addEventListener('touchstart', runStart, { passive:false });
    sprintBtn?.addEventListener('touchend', runEnd, { passive:false });
    sprintBtn?.addEventListener('touchcancel', runEnd, { passive:false });
    // Touch fallback (iOS Safari can be flaky with Pointer Events depending on settings)
    // We mirror the pointer logic using touch identifiers.
    this._tJoyId = null;
    this._tLookId = null;

    const getTouchById = (touches, id) => {
      for (let i = 0; i < touches.length; i++) {
        if (touches[i].identifier === id) return touches[i];
      }
      return null;
    };

    // Joystick touch
    joystick?.addEventListener('touchstart', (e) => {
      if (this._tJoyId !== null) return;
      const t = e.changedTouches[0];
      if (!t) return;
      this._tJoyId = t.identifier;
      const r = joystick.getBoundingClientRect();
      this._joyCenter.x = r.left + r.width / 2;
      this._joyCenter.y = r.top + r.height / 2;
      this._joyVec.x = 0;
      this._joyVec.y = 0;
      this._applyMove();
      e.preventDefault();
    }, { passive: false });

    joystick?.addEventListener('touchmove', (e) => {
      if (this._tJoyId === null) return;
      const t = getTouchById(e.touches, this._tJoyId);
      if (!t) return;
      const dx = t.clientX - this._joyCenter.x;
      const dy = t.clientY - this._joyCenter.y;
      const max = 48;
      const len = Math.hypot(dx, dy);
      const k = len > max ? (max / (len || 1)) : 1;
      this._joyVec.x = dx * k;
      this._joyVec.y = dy * k;
      this._applyMove();
      e.preventDefault();
    }, { passive: false });

    joystick?.addEventListener('touchend', (e) => {
      if (this._tJoyId === null) return;
      const t = getTouchById(e.changedTouches, this._tJoyId);
      if (!t) return;
      this._tJoyId = null;
      this._joyVec.x = 0;
      this._joyVec.y = 0;
      this._applyMove();
      e.preventDefault();
    }, { passive: false });

    joystick?.addEventListener('touchcancel', () => {
      this._tJoyId = null;
      this._joyVec.x = 0;
      this._joyVec.y = 0;
      this._applyMove();
    }, { passive: false });

    // Look touch
    look?.addEventListener('touchstart', (e) => {
      if (this._tLookId !== null) return;
      const t = e.changedTouches[0];
      if (!t) return;
      this._tLookId = t.identifier;
      this._lookLast.x = t.clientX;
      this._lookLast.y = t.clientY;
      e.preventDefault();
    }, { passive: false });

    look?.addEventListener('touchmove', (e) => {
      if (this._tLookId === null) return;
      const t = getTouchById(e.touches, this._tLookId);
      if (!t) return;
      const dx = t.clientX - this._lookLast.x;
      const dy = t.clientY - this._lookLast.y;
      this._lookLast.x = t.clientX;
      this._lookLast.y = t.clientY;
      this._applyLook(dx, dy);
      e.preventDefault();
    }, { passive: false });

    look?.addEventListener('touchend', (e) => {
      if (this._tLookId === null) return;
      const t = getTouchById(e.changedTouches, this._tLookId);
      if (!t) return;
      this._tLookId = null;
      e.preventDefault();
    }, { passive: false });

    look?.addEventListener('touchcancel', () => {
      this._tLookId = null;
    }, { passive: false });

  }

  _applyMove() {
    // Convert joystick pixels into normalized movement axes.
    // Y is forward/back; X is strafe.
    const max = 48;
    const x = this._joyVec.x / max;
    const y = this._joyVec.y / max;

    // deadzone
    const dz = 0.12;
    const nx = Math.abs(x) < dz ? 0 : x;
    const ny = Math.abs(y) < dz ? 0 : y;

    this.game.mobile.strafe = THREE.MathUtils.clamp(nx, -1, 1);
    // Up on screen is negative dy, so forward is -ny
    this.game.mobile.forward = THREE.MathUtils.clamp(-ny, -1, 1);

    this._updateUI(this._joyVec.x, this._joyVec.y);
  }

  _updateUI(px, py) {
    const { stick } = this.ui;
    if (!stick) return;
    stick.style.transform = `translate(${px}px, ${py}px)`;
  }
  _applyLook(dx, dy) {
    const g = this.game;
    if (!g || !g.controls || !g.camera) return;

    const yawObj = g.controls.getObject?.();
    if (!yawObj) return;

    // Yaw (left/right) on yaw object
    yawObj.rotation.y -= dx * this.lookSensitivity;

    // Pitch (up/down) directly on the camera.
    // This is the most reliable path across browsers/builds.
    const cam = g.camera;
    cam.rotation.order = 'YXZ';
    cam.rotation.z = 0; // no roll
    const next = THREE.MathUtils.clamp(
      cam.rotation.x - dy * this.lookSensitivity,
      this.pitchMin,
      this.pitchMax
    );
    cam.rotation.x = next;
  }


    if (pitchObj) {
      pitchObj.rotation.order = 'YXZ';
      pitchObj.rotation.z = 0; // no roll
      pitchObj.rotation.x -= dy * this.lookSensitivity;
      pitchObj.rotation.x = THREE.MathUtils.clamp(pitchObj.rotation.x, this.pitchMin, this.pitchMax);
    }
  }
