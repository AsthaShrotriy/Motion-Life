/*
 * flow.js — Lucas-Kanade optical flow on a coarse grid.
 * (Carried from v1 — used by capture.js for video-upload analysis)
 */

const FLOW_W = 160;
const FLOW_H = 120;
const GRID_X = 16;
const GRID_Y = 12;
const WIN = 3;
const MIN_EIG = 40;
const MAX_V = 6;

class FlowTracker {
  constructor() {
    this.prev = null;
    this.canvas = document.createElement('canvas');
    this.canvas.width = FLOW_W;
    this.canvas.height = FLOW_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.points = [];
    for (let gy = 0; gy < GRID_Y; gy++) {
      for (let gx = 0; gx < GRID_X; gx++) {
        this.points.push({
          x: Math.round((gx + 0.5) * FLOW_W / GRID_X),
          y: Math.round((gy + 0.5) * FLOW_H / GRID_Y),
        });
      }
    }
  }

  reset() { this.prev = null; }

  grayFrame(source) {
    this.ctx.drawImage(source, 0, 0, FLOW_W, FLOW_H);
    const img = this.ctx.getImageData(0, 0, FLOW_W, FLOW_H).data;
    const g = new Float32Array(FLOW_W * FLOW_H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      g[i] = 0.299 * img[j] + 0.587 * img[j + 1] + 0.114 * img[j + 2];
    }
    return g;
  }

  step(source) {
    const cur = this.grayFrame(source);
    if (!this.prev) { this.prev = cur; return null; }
    const prev = this.prev;
    const W = FLOW_W;

    const out = this.points.map(p => {
      let sxx = 0, sxy = 0, syy = 0, sxt = 0, syt = 0;
      for (let dy = -WIN; dy <= WIN; dy++) {
        for (let dx = -WIN; dx <= WIN; dx++) {
          const x = p.x + dx, y = p.y + dy;
          if (x < 1 || x >= W - 1 || y < 1 || y >= FLOW_H - 1) continue;
          const i = y * W + x;
          const ix = (prev[i + 1] - prev[i - 1]) * 0.5;
          const iy = (prev[i + W] - prev[i - W]) * 0.5;
          const it = cur[i] - prev[i];
          sxx += ix * ix; sxy += ix * iy; syy += iy * iy;
          sxt += ix * it; syt += iy * it;
        }
      }
      const tr = sxx + syy;
      const det = sxx * syy - sxy * sxy;
      const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const minEig = tr / 2 - disc;
      if (minEig < MIN_EIG || det === 0) {
        return { x: p.x, y: p.y, vx: 0, vy: 0, valid: false };
      }
      let vx = (-syy * sxt + sxy * syt) / det;
      let vy = (sxy * sxt - sxx * syt) / det;
      vx = Math.max(-MAX_V, Math.min(MAX_V, vx));
      vy = Math.max(-MAX_V, Math.min(MAX_V, vy));
      return { x: p.x, y: p.y, vx, vy, valid: true };
    });

    this.prev = cur;
    return out;
  }
}

window.FlowTracker = FlowTracker;
window.FLOW_DIMS = { FLOW_W, FLOW_H, GRID_X, GRID_Y };
