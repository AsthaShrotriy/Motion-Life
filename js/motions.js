/*
 * motions.js — motion preset library.
 *
 * Each motion is a set of parameters that drive the animation formula.
 * The same structure is produced by capture.js when user uploads a video.
 */

const MOTION_PRESETS = [
  {
    id: 'waterfall-flow',
    name: 'Waterfall Flow',
    desc: 'Fast downward stream with splashing turbulence',
    color: '#4cc9ff',
    params: { frequency: 2.8, amplitude: 0.6, direction: 90, turbulence: 0.55, damping: 0.1, phaseSpread: 0.7 },
  },
  {
    id: 'cloud-drift',
    name: 'Cloud Drift',
    desc: 'Slow horizontal glide',
    color: '#b8b8cc',
    params: { frequency: 0.35, amplitude: 0.9, direction: 0, turbulence: 0.03, damping: 0.0, phaseSpread: 0.1 },
  },
  {
    id: 'flag-flutter',
    name: 'Flag Flutter',
    desc: 'Brisk horizontal wave with ripple',
    color: '#ff5c5c',
    params: { frequency: 3.5, amplitude: 0.4, direction: 10, turbulence: 0.35, damping: 0.2, phaseSpread: 0.85 },
  },
  {
    id: 'gentle-sway',
    name: 'Gentle Sway',
    desc: 'Slow side-to-side breeze for trees/plants',
    color: '#3ddc84',
    params: { frequency: 0.4, amplitude: 0.45, direction: 0, turbulence: 0.08, damping: 0.12, phaseSpread: 0.5 },
  },
  {
    id: 'water-ripple',
    name: 'Water Ripple',
    desc: 'Gentle surface undulation',
    color: '#3a7abf',
    params: { frequency: 1.0, amplitude: 0.2, direction: 0, turbulence: 0.25, damping: 0.15, phaseSpread: 0.9 },
  },
  {
    id: 'sun-pulse',
    name: 'Sun Pulse',
    desc: 'Gentle radial breathing/glow',
    color: '#ffd93d',
    params: { frequency: 0.6, amplitude: 0.4, direction: 90, turbulence: 0.0, damping: 0.0, phaseSpread: 0.0 },
  },
  {
    id: 'falling-leaves',
    name: 'Falling Leaves',
    desc: 'Downward drift with lazy tumble',
    color: '#e8a33d',
    params: { frequency: 0.5, amplitude: 0.3, direction: 0, turbulence: 0.25, damping: 0.3, phaseSpread: 0.8, driftX: 0, driftY: 0.5 },
  },
  {
    id: 'autumn-fall',
    name: 'Autumn Fall',
    desc: 'Lazy downward drift with sideways sway — tuned for autumn poster leaves',
    color: '#d97a2b',
    params: { frequency: 0.38, amplitude: 0.42, direction: 270, turbulence: 0.32, damping: 0.08, phaseSpread: 0.85, driftX: -0.05, driftY: 0.9, leafFall: true },
  },
  {
    id: 'rising-smoke',
    name: 'Rising Smoke',
    desc: 'Slow upward drift with waver',
    color: '#c9c4d4',
    params: { frequency: 0.3, amplitude: 0.25, direction: 0, turbulence: 0.3, damping: 0.2, phaseSpread: 0.6, driftX: 0.05, driftY: -0.55 },
  },
];

class MotionLibrary {
  constructor() {
    this.motions = [...MOTION_PRESETS];
    this.selectedId = null;
  }

  getAll() { return this.motions; }
  getById(id) { return this.motions.find(m => m.id === id); }

  add(motion) {
    this.motions.push(motion);
    return motion;
  }

  select(id) { this.selectedId = id; }
  getSelected() { return this.motions.find(m => m.id === this.selectedId) || null; }
}

window.MotionLibrary = MotionLibrary;
window.MOTION_PRESETS = MOTION_PRESETS;
