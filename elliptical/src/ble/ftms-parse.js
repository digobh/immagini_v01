// Pure parsing / encoding helpers for the Bluetooth FTMS (Fitness Machine Service) spec.
// No browser APIs in here so it can be unit-tested in Node.

export const UUID = {
  FTMS_SERVICE: 0x1826,
  FEATURE: 0x2acc,
  CROSS_TRAINER_DATA: 0x2ace,
  INDOOR_BIKE_DATA: 0x2ad2,
  RESISTANCE_RANGE: 0x2ad6,
  CONTROL_POINT: 0x2ad9,
  MACHINE_STATUS: 0x2ada,
};

export const OP = {
  REQUEST_CONTROL: 0x00,
  RESET: 0x01,
  SET_TARGET_RESISTANCE: 0x04,
  START_RESUME: 0x07,
  STOP_PAUSE: 0x08,
  RESPONSE: 0x80,
};

export const RESULT = {
  0x01: 'success',
  0x02: 'op code not supported',
  0x03: 'invalid parameter',
  0x04: 'operation failed',
  0x05: 'control not permitted',
};

/** Small cursor over a DataView that reads little-endian fields in order. */
class Reader {
  constructor(dv) { this.dv = dv; this.o = 0; }
  has(n) { return this.o + n <= this.dv.byteLength; }
  u8() { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  s16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u24() { const v = this.dv.getUint16(this.o, true) | (this.dv.getUint8(this.o + 2) << 16); this.o += 3; return v; }
}

const toView = (data) =>
  data instanceof DataView ? data : new DataView(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);

/**
 * Cross Trainer Data (0x2ACE) – what FTMS ellipticals broadcast.
 * Flags are 24 bits. Bit 0 is inverted ("More Data"): speed is present when it is 0.
 */
export function parseCrossTrainerData(data) {
  const r = new Reader(toView(data));
  const flags = r.u24();
  const bit = (n) => (flags >> n) & 1;
  const out = {};
  try {
    if (!bit(0)) out.speedKmh = r.u16() / 100;
    if (bit(1)) out.avgSpeedKmh = r.u16() / 100;
    if (bit(2)) out.distanceM = r.u24();
    if (bit(3)) { out.cadence = r.u16(); out.avgCadence = r.u16(); } // steps per minute
    if (bit(4)) out.strideCount = r.u16() / 10;
    if (bit(5)) { out.elevationGainM = r.u16(); out.elevationLossM = r.u16(); }
    if (bit(6)) { out.inclinePct = r.s16() / 10; out.rampAngle = r.s16() / 10; }
    if (bit(7)) out.resistance = r.s16() / 10;
    if (bit(8)) out.powerW = r.s16();
    if (bit(9)) out.avgPowerW = r.s16();
    if (bit(10)) { out.kcal = r.u16(); out.kcalPerHour = r.u16(); out.kcalPerMin = r.u8(); }
    if (bit(11)) out.heartRate = r.u8();
    if (bit(12)) out.met = r.u8() / 10;
    if (bit(13)) out.elapsedS = r.u16();
    if (bit(14)) out.remainingS = r.u16();
  } catch {
    // Truncated packet: keep what we managed to read.
  }
  return out;
}

/** Indoor Bike Data (0x2AD2) – some ellipticals / bridges (e.g. QZ) expose this instead. */
export function parseIndoorBikeData(data) {
  const r = new Reader(toView(data));
  const flags = r.u16();
  const bit = (n) => (flags >> n) & 1;
  const out = {};
  try {
    if (!bit(0)) out.speedKmh = r.u16() / 100;
    if (bit(1)) out.avgSpeedKmh = r.u16() / 100;
    if (bit(2)) out.cadence = r.u16() / 2;
    if (bit(3)) out.avgCadence = r.u16() / 2;
    if (bit(4)) out.distanceM = r.u24();
    if (bit(5)) out.resistance = r.s16();
    if (bit(6)) out.powerW = r.s16();
    if (bit(7)) out.avgPowerW = r.s16();
    if (bit(8)) { out.kcal = r.u16(); out.kcalPerHour = r.u16(); out.kcalPerMin = r.u8(); }
    if (bit(9)) out.heartRate = r.u8();
    if (bit(10)) out.met = r.u8() / 10;
    if (bit(11)) out.elapsedS = r.u16();
    if (bit(12)) out.remainingS = r.u16();
  } catch {
    // Truncated packet.
  }
  return out;
}

/** Supported Resistance Level Range (0x2AD6): sint16 min, max, increment, resolution 0.1. */
export function parseResistanceRange(data) {
  const dv = toView(data);
  return {
    min: dv.getInt16(0, true) / 10,
    max: dv.getInt16(2, true) / 10,
    step: dv.getUint16(4, true) / 10 || 1,
  };
}

/** Fitness Machine Feature (0x2ACC): two uint32 bitfields. */
export function parseFeatures(data) {
  const dv = toView(data);
  const machine = dv.getUint32(0, true);
  const target = dv.byteLength >= 8 ? dv.getUint32(4, true) : 0;
  return {
    machine,
    target,
    resistanceTarget: Boolean(target & (1 << 2)),
    powerTarget: Boolean(target & (1 << 3)),
  };
}

/**
 * Encode "Set Target Resistance Level". The FTMS 1.0 spec defines the parameter as
 * uint8 with 0.1 resolution (max 25.5); newer revisions and many machines use sint16.
 * `encoding` lets the user pick if their machine only accepts one form.
 */
export function encodeSetResistance(level, encoding = 'auto') {
  const raw = Math.round(level * 10);
  const useU8 = encoding === 'u8' || (encoding === 'auto' && raw <= 0xff && raw >= 0);
  if (useU8) return new Uint8Array([OP.SET_TARGET_RESISTANCE, raw & 0xff]);
  const buf = new Uint8Array(3);
  new DataView(buf.buffer).setInt16(1, raw, true);
  buf[0] = OP.SET_TARGET_RESISTANCE;
  return buf;
}

/** Control point indication: [0x80, requestOpCode, resultCode]. */
export function parseControlResponse(data) {
  const dv = toView(data);
  if (dv.byteLength < 3 || dv.getUint8(0) !== OP.RESPONSE) return null;
  const code = dv.getUint8(2);
  return { opCode: dv.getUint8(1), code, ok: code === 0x01, message: RESULT[code] ?? `code ${code}` };
}
