// A fake elliptical with the same interface as FtmsMachine, so the whole app
// (and later the 3D world) can be developed and demoed without the hardware.

export class SimulatedMachine extends EventTarget {
  constructor({ range = { min: 1, max: 24, step: 1 } } = {}) {
    super();
    this.kind = 'sim';
    this.name = 'Simulator';
    this.range = range;
    this.connected = false;
    this.resistance = range.min;
    this.targetCadence = 0; // what the "user" is pedaling; set from the UI
    this.cadence = 0;
    this.distanceM = 0;
    this.kcal = 0;
    this.heartRate = 70;
    this._timer = null;
    this._last = 0;
  }

  log(msg) { this.dispatchEvent(new CustomEvent('log', { detail: msg })); }

  async connect() {
    this.connected = true;
    this._last = performance.now();
    this._timer = setInterval(() => this._step(), 250);
    this.log('Simulator ready – use the cadence slider (or ↑/↓ keys) to "pedal"');
    return this;
  }

  setCadence(spm) { this.targetCadence = Math.max(0, Math.min(200, spm)); }

  async setResistance(level) {
    this.resistance = Math.min(this.range.max, Math.max(this.range.min, level));
    this.log(`Set resistance ${this.resistance}: success`);
    return { ok: true, message: 'success' };
  }

  _step() {
    const now = performance.now();
    const dt = (now - this._last) / 1000;
    this._last = now;
    // Cadence eases toward the target, and drops a bit with higher resistance.
    const effortDrag = 1 - (this.resistance - this.range.min) / (this.range.max - this.range.min + 1) * 0.15;
    const goal = this.targetCadence * effortDrag;
    this.cadence += (goal - this.cadence) * Math.min(1, dt * 2);
    const powerW = Math.max(0, this.cadence * (0.4 + this.resistance * 0.12));
    const speedKmh = this.cadence * 0.1;
    this.distanceM += (speedKmh / 3.6) * dt;
    this.kcal += (powerW * dt) / 1000 / 0.24 / 4.184; // ~24% efficiency
    const hrGoal = 70 + powerW * 0.45;
    this.heartRate += (hrGoal - this.heartRate) * Math.min(1, dt * 0.15);

    this.dispatchEvent(new CustomEvent('data', {
      detail: {
        speedKmh,
        cadence: Math.round(this.cadence),
        powerW: Math.round(powerW),
        resistance: this.resistance,
        heartRate: Math.round(this.heartRate),
        distanceM: Math.round(this.distanceM),
        kcal: Math.round(this.kcal),
      },
    }));
  }

  async disconnect() {
    clearInterval(this._timer);
    this.connected = false;
    this.dispatchEvent(new Event('disconnect'));
  }
}
