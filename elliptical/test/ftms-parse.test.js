import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCrossTrainerData, parseIndoorBikeData, parseResistanceRange,
  parseFeatures, encodeSetResistance, parseControlResponse,
} from '../src/ble/ftms-parse.js';

const bytes = (...b) => new DataView(new Uint8Array(b).buffer);

test('cross trainer: speed + cadence + resistance + power + HR', () => {
  // flags: bit3 (steps), bit7 (resistance), bit8 (power), bit11 (HR); bit0=0 => speed present
  const flags = (1 << 3) | (1 << 7) | (1 << 8) | (1 << 11);
  const dv = bytes(
    flags & 0xff, (flags >> 8) & 0xff, (flags >> 16) & 0xff,
    0xd0, 0x07,       // speed 2000 => 20.00 km/h
    0x78, 0x00,       // 120 spm
    0x74, 0x00,       // avg 116
    0x78, 0x00,       // resistance 120 => 12.0
    0xc8, 0x00,       // 200 W
    0x8c,             // 140 bpm
  );
  assert.deepEqual(parseCrossTrainerData(dv), {
    speedKmh: 20, cadence: 120, avgCadence: 116, resistance: 12, powerW: 200, heartRate: 140,
  });
});

test('cross trainer: More Data bit set means no speed field; truncated packet is tolerated', () => {
  const dv = bytes(0x01 | (1 << 2), 0, 0, 0x10, 0x27, 0x00, /* truncated */);
  assert.deepEqual(parseCrossTrainerData(dv), { distanceM: 10000 });
  assert.deepEqual(parseCrossTrainerData(bytes(0x00, 0x00, 0x00, 0x01)), {});
});

test('indoor bike: cadence has 0.5 resolution', () => {
  const flags = (1 << 2) | (1 << 6);
  const dv = bytes(flags, 0, 0x00, 0x00, 0xb4, 0x00, 0x96, 0x00);
  assert.deepEqual(parseIndoorBikeData(dv), { speedKmh: 0, cadence: 90, powerW: 150 });
});

test('resistance range and features', () => {
  assert.deepEqual(parseResistanceRange(bytes(10, 0, 240, 0, 10, 0)), { min: 1, max: 24, step: 1 });
  const f = parseFeatures(bytes(0, 0, 0, 0, 0b100, 0, 0, 0));
  assert.equal(f.resistanceTarget, true);
  assert.equal(f.powerTarget, false);
});

test('encode set resistance', () => {
  assert.deepEqual([...encodeSetResistance(12)], [0x04, 120]);
  assert.deepEqual([...encodeSetResistance(26)], [0x04, 0x04, 0x01]); // 260 > 255 -> sint16
  assert.deepEqual([...encodeSetResistance(5, 's16')], [0x04, 50, 0]);
});

test('control point response', () => {
  assert.deepEqual(parseControlResponse(bytes(0x80, 0x04, 0x01)), { opCode: 4, code: 1, ok: true, message: 'success' });
  assert.equal(parseControlResponse(bytes(0x80, 0x00, 0x05)).message, 'control not permitted');
  assert.equal(parseControlResponse(bytes(0x01)), null);
});
