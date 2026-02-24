// Simple procedural SFX (no external assets) using WebAudio.
export class SoundManager {
  constructor() {
    this.enabled = true;
    this.master = 0.65;
    this._ctx = null;
    this._noiseBuf = null;
  }

  get ctx() {
    if (this._ctx) return this._ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this._ctx = new AC();
    return this._ctx;
  }

  unlock() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      // Resume must be inside a user gesture.
      ctx.resume().catch(() => {});
    }
  }

  _ensureNoise() {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (this._noiseBuf) return this._noiseBuf;
    const len = Math.floor(ctx.sampleRate * 0.35);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i=0;i<len;i++) d[i] = (Math.random()*2-1);
    this._noiseBuf = buf;
    return buf;
  }

  _gain(v=1) {
    const ctx = this.ctx;
    if (!ctx) return null;
    const g = ctx.createGain();
    g.gain.value = Math.max(0, v) * this.master;
    return g;
  }

  _env(gainNode, t0, a, d) {
    const g = gainNode.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(1.0, t0 + a);
    g.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }

  _tone(freq, dur=0.12, type='sine', vol=1.0) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;

    const g = this._gain(vol);
    o.connect(g);
    g.connect(ctx.destination);

    const t0 = ctx.currentTime;
    this._env(g, t0, 0.005, Math.max(0.02, dur));
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  _thud(vol=1.0) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    // low pitch + noise burst
    this._tone(90, 0.08, 'triangle', 0.9*vol);

    const buf = this._ensureNoise();
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = 420;

    const g = this._gain(0.55*vol);
    src.connect(bp);
    bp.connect(g);
    g.connect(ctx.destination);

    const t0 = ctx.currentTime;
    this._env(g, t0, 0.001, 0.08);
    src.start(t0);
    src.stop(t0 + 0.12);
  }

  _dust(vol=1.0) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const buf = this._ensureNoise();
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900;
    bp.Q.value = 0.6;

    const g = this._gain(0.35*vol);
    src.connect(bp);
    bp.connect(g);
    g.connect(ctx.destination);

    const t0 = ctx.currentTime;
    this._env(g, t0, 0.001, 0.12);
    src.start(t0);
    src.stop(t0 + 0.18);
  }

  play(name, vol=1.0) {
    if (!this.enabled) return;
    // If audio is still locked, ignore (no console spam)
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running') return;

    switch (name) {
      case 'punchWall':
        this._thud(0.95*vol);
        this._dust(0.9*vol);
        break;
      case 'punchFlesh':
        this._thud(0.75*vol);
        this._tone(170, 0.06, 'sawtooth', 0.25*vol);
        break;
      case 'pickup':
        this._tone(420, 0.05, 'square', 0.22*vol);
        this._tone(520, 0.05, 'square', 0.18*vol);
        break;
      case 'throw':
        this._tone(260, 0.06, 'triangle', 0.22*vol);
        break;
      case 'saved':
        this._tone(660, 0.07, 'sine', 0.22*vol);
        this._tone(880, 0.09, 'sine', 0.22*vol);
        break;
      case 'patientDown':
        this._tone(220, 0.10, 'sawtooth', 0.18*vol);
        this._tone(140, 0.14, 'triangle', 0.18*vol);
        break;
      case 'noPower':
        // short "error" chirp
        this._tone(120, 0.06, 'square', 0.12*vol);
        this._tone(90,  0.08, 'square', 0.10*vol);
        break;
      default:
        // no-op
        break;
    }
  }
}
