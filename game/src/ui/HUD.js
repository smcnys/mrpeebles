
export class HUD {
  constructor() {
    this.savedEl = document.getElementById('hud-saved') || document.getElementById('saved');
    this.quotaEl = document.getElementById('hud-quota') || document.getElementById('quota');
    this.timeEl  = document.getElementById('hud-time')  || document.getElementById('time');
    // Prefer the actual <canvas> (mm). If it's missing, fall back to a host element.
    this.canvas = document.getElementById('mm') || document.getElementById('minimap');
    // If minimap element isn't a <canvas>, replace it with one.
    if (this.canvas && typeof this.canvas.getContext !== 'function') {
      const host = this.canvas;
      const c = document.createElement('canvas');
      c.id = 'minimap';
      c.width = 160; c.height = 160;
      c.style.width = '160px';
      c.style.height = '160px';
      c.style.border = '1px solid rgba(255,255,255,0.15)';
      c.style.borderRadius = '10px';
      c.style.background = '#111';
      host.replaceWith(c);
      this.canvas = c;
    }
    if (this.canvas && !this.canvas.width) this.canvas.width = 160;
    if (this.canvas && !this.canvas.height) this.canvas.height = 160;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;

    // Power meter
    this.powerWrap = document.getElementById('power');
    this.powerFill = document.getElementById('powerFill');
    this.powerText = document.getElementById('powerText');
  }

  setSaved(n) {
    if (this.savedEl) this.savedEl.textContent = n;
  }

  setQuota(n) {
    if (this.quotaEl) this.quotaEl.textContent = n;
  }

  setTime(seconds) {
    if (!this.timeEl) return;
    const s = Math.max(0, seconds|0);
    const mm = String(Math.floor(s/60)).padStart(2,'0');
    const ss = String(s%60).padStart(2,'0');
    this.timeEl.textContent = `${mm}:${ss}`;
  }

  setPower(cur, max) {
    if (!this.powerFill || !this.powerText) return;
    const m = Math.max(1, Number(max) || 100);
    const c = Math.max(0, Math.min(m, Number(cur) || 0));
    const pct = c / m;
    this.powerFill.style.transform = `scaleX(${pct.toFixed(4)})`;
    this.powerText.textContent = String(Math.round(c));
    if (this.powerWrap) {
      if (pct <= 0.15) this.powerWrap.classList.add('low');
      else this.powerWrap.classList.remove('low');
    }
  }

  updateMinimap(playerPos, floor=null) {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const size = this.canvas.width || 160;
    const pad = 6;
    ctx.clearRect(0,0,size,size);
    ctx.fillStyle = '#0b0b0b';
    ctx.fillRect(0,0,size,size);

    // Draw floor walkable map if provided: floor = {w,h,grid,spawn}
    if (floor && floor.grid && floor.w && floor.h) {
      const w = floor.w, h = floor.h;
      const inner = size - pad*2;
      const sx = inner / w;
      const sy = inner / h;
      // walls/background
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      for (let y=0;y<h;y++) {
        for (let x=0;x<w;x++) {
          if (floor.grid[y*w + x]===1) continue; // wall
          const px = pad + x*sx;
          const py = pad + y*sy;
          ctx.fillRect(px, py, Math.ceil(sx), Math.ceil(sy));
        }
      }
      // border
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(pad, pad, inner, inner);
      // player
      const nx = playerPos.x / w;
      const nz = playerPos.z / h;
      const px = pad + nx*inner;
      const py = pad + nz*inner;
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.arc(px, py, 3.8, 0, Math.PI*2);
      ctx.fill();
      return;
    }

    // Fallback: border + centered player
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(pad, pad, size-pad*2, size-pad*2);
    ctx.beginPath();
    ctx.fillStyle = '#ffffff';
    ctx.arc(size/2, size/2, 4, 0, Math.PI*2);
    ctx.fill();
  }
}
