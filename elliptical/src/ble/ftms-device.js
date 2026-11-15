// Real machine connection over Web Bluetooth using the FTMS profile.
// Works in Chrome / Edge (desktop + Android) on https:// or http://localhost.
// iOS Safari has no Web Bluetooth – use the "Bluefy" browser on iPhone/iPad.

import {
  UUID, OP,
  parseCrossTrainerData, parseIndoorBikeData, parseResistanceRange,
  parseFeatures, encodeSetResistance, parseControlResponse,
} from './ftms-parse.js';

const DEFAULT_RANGE = { min: 1, max: 24, step: 1 };

export class FtmsMachine extends EventTarget {
  constructor({ encoding = 'auto' } = {}) {
    super();
    this.kind = 'ftms';
    this.encoding = encoding;
    this.name = 'FTMS machine';
    this.range = { ...DEFAULT_RANGE };
    this.features = null;
    this.connected = false;
    this._device = null;
    this._cp = null;
    this._queue = Promise.resolve(); // GATT ops must not overlap
    this._pending = new Map(); // opCode -> resolver for control point indications
    this._lastSentLevel = null;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  log(msg) { this.dispatchEvent(new CustomEvent('log', { detail: msg })); }

  async connect() {
    if (!FtmsMachine.isSupported()) {
      throw new Error('Web Bluetooth is not available in this browser. Use Chrome/Edge (or Bluefy on iOS).');
    }
    this._device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UUID.FTMS_SERVICE] }],
      optionalServices: [UUID.FTMS_SERVICE],
    });
    this.name = this._device.name || 'FTMS machine';
    this._device.addEventListener('gattserverdisconnected', () => {
      this.connected = false;
      this.log('Disconnected');
      this.dispatchEvent(new Event('disconnect'));
    });

    this.log(`Connecting to ${this.name}…`);
    const server = await this._device.gatt.connect();
    const svc = await server.getPrimaryService(UUID.FTMS_SERVICE);

    // Optional characteristics: read what the machine tells us about itself.
    try {
      this.features = parseFeatures(await (await svc.getCharacteristic(UUID.FEATURE)).readValue());
      this.log(`Resistance control supported: ${this.features.resistanceTarget ? 'yes' : 'not advertised'}`);
    } catch { this.log('Feature characteristic not available'); }

    try {
      this.range = parseResistanceRange(await (await svc.getCharacteristic(UUID.RESISTANCE_RANGE)).readValue());
      this.log(`Resistance range ${this.range.min}–${this.range.max} (step ${this.range.step})`);
    } catch { this.log(`Resistance range unknown, assuming ${this.range.min}–${this.range.max}`); }

    // Live data: ellipticals use Cross Trainer Data; fall back to Indoor Bike Data.
    let dataChar = null, parser = null;
    for (const [uuid, fn] of [[UUID.CROSS_TRAINER_DATA, parseCrossTrainerData], [UUID.INDOOR_BIKE_DATA, parseIndoorBikeData]]) {
      try { dataChar = await svc.getCharacteristic(uuid); parser = fn; break; } catch { /* try next */ }
    }
    if (dataChar) {
      dataChar.addEventListener('characteristicvaluechanged', (e) => {
        this.dispatchEvent(new CustomEvent('data', { detail: parser(e.target.value) }));
      });
      await dataChar.startNotifications();
      this.log(parser === parseCrossTrainerData ? 'Streaming cross-trainer data' : 'Streaming indoor-bike data');
    } else {
      this.log('No live-data characteristic found');
    }

    // Control point: subscribe to indications BEFORE writing, then request control.
    this._cp = await svc.getCharacteristic(UUID.CONTROL_POINT);
    this._cp.addEventListener('characteristicvaluechanged', (e) => {
      const res = parseControlResponse(e.target.value);
      if (!res) return;
      const resolve = this._pending.get(res.opCode);
      this._pending.delete(res.opCode);
      resolve?.(res);
    });
    await this._cp.startNotifications();

    const ctl = await this._command(new Uint8Array([OP.REQUEST_CONTROL]));
    if (!ctl.ok) throw new Error(`Machine refused control: ${ctl.message}`);
    this.log('Control granted');
    await this._command(new Uint8Array([OP.START_RESUME])).catch(() => {});

    this.connected = true;
    return this;
  }

  /** Write to the control point and wait for its indication (with timeout). */
  _command(bytes) {
    const run = async () => {
      if (!this._cp) throw new Error('Not connected');
      const op = bytes[0];
      const answer = new Promise((resolve) => {
        this._pending.set(op, resolve);
        setTimeout(() => {
          if (this._pending.get(op) === resolve) {
            this._pending.delete(op);
            resolve({ opCode: op, ok: false, message: 'timeout' });
          }
        }, 3000);
      });
      const write = this._cp.writeValueWithResponse
        ? this._cp.writeValueWithResponse(bytes)
        : this._cp.writeValue(bytes);
      await write;
      return answer;
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  async setResistance(level) {
    const clamped = Math.min(this.range.max, Math.max(this.range.min, level));
    if (clamped === this._lastSentLevel) return { ok: true, message: 'unchanged' };
    const res = await this._command(encodeSetResistance(clamped, this.encoding));
    if (res.ok) this._lastSentLevel = clamped;
    this.log(`Set resistance ${clamped}: ${res.message}`);
    return res;
  }

  async disconnect() {
    try { await this._command(new Uint8Array([OP.STOP_PAUSE, 0x02])); } catch { /* ignore */ }
    this._device?.gatt?.disconnect();
    this.connected = false;
  }
}
