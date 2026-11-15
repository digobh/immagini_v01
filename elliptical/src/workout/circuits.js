// Circuit definitions.
//
// Resistance is written as an intensity percentage (0–100) of the machine's
// resistance range instead of a fixed level, so the same circuit works on a
// ProForm with levels 1–22, 1–24 or 1–26. The engine converts % → machine level.
//
// Segment fields:
//   label     shown on screen
//   duration  seconds
//   pct       intensity 0–100 (0 = lowest level, 100 = highest)
//   cadence   optional target strides/min shown as a guide
//   kind      'warmup' | 'work' | 'recover' | 'cooldown' (colour + future 3D terrain)

const seg = (label, duration, pct, kind, cadence) => ({ label, duration, pct, kind, cadence });

const repeat = (n, segments) => Array.from({ length: n }, () => segments.map((s) => ({ ...s }))).flat();

export const CIRCUITS = [
  {
    id: 'quick-test',
    name: 'Quick Sync Test',
    description: '2 minutes stepping through low → high → low. Use it to verify resistance control works.',
    segments: [
      seg('Low', 20, 10, 'warmup', 120),
      seg('Medium', 20, 40, 'work', 120),
      seg('High', 20, 70, 'work', 110),
      seg('Max', 20, 90, 'work', 100),
      seg('Medium', 20, 40, 'recover', 120),
      seg('Low', 20, 10, 'cooldown', 120),
    ],
  },
  {
    id: 'rolling-hills',
    name: 'Rolling Hills',
    description: 'Steady effort over gentle climbs and descents. Good everyday workout.',
    segments: [
      seg('Warm-up', 180, 15, 'warmup', 120),
      ...repeat(4, [
        seg('Climb', 90, 45, 'work', 125),
        seg('Crest', 60, 60, 'work', 120),
        seg('Descent', 90, 25, 'recover', 130),
      ]),
      seg('Cool-down', 180, 10, 'cooldown', 110),
    ],
  },
  {
    id: 'hiit-30-30',
    name: 'HIIT 30/30',
    description: '10 rounds of 30 s hard / 30 s easy. Short and intense.',
    segments: [
      seg('Warm-up', 240, 20, 'warmup', 120),
      ...repeat(10, [
        seg('Sprint', 30, 75, 'work', 150),
        seg('Recover', 30, 15, 'recover', 110),
      ]),
      seg('Cool-down', 180, 10, 'cooldown', 110),
    ],
  },
  {
    id: 'pyramid',
    name: 'Pyramid',
    description: 'Resistance builds step by step to a peak, then comes back down.',
    segments: [
      seg('Warm-up', 180, 15, 'warmup', 120),
      ...[25, 35, 45, 55, 65, 75].map((p, i) => seg(`Step ${i + 1}`, 90, p, 'work', 125 - i * 3)),
      seg('Peak', 60, 85, 'work', 100),
      ...[75, 65, 55, 45, 35, 25].map((p, i) => seg(`Step ${6 - i}`, 90, p, 'work', 110 + i * 3)),
      seg('Cool-down', 180, 10, 'cooldown', 110),
    ],
  },
  {
    id: 'tabata',
    name: 'Tabata',
    description: '2 blocks of 8 × (20 s all-out / 10 s rest).',
    segments: [
      seg('Warm-up', 240, 20, 'warmup', 120),
      ...repeat(8, [seg('All-out', 20, 80, 'work', 160), seg('Rest', 10, 10, 'recover', 100)]),
      seg('Break', 120, 15, 'recover', 110),
      ...repeat(8, [seg('All-out', 20, 80, 'work', 160), seg('Rest', 10, 10, 'recover', 100)]),
      seg('Cool-down', 180, 10, 'cooldown', 110),
    ],
  },
  {
    id: 'endurance-climb',
    name: 'Endurance Climb',
    description: 'A long, slowly steepening mountain climb. Hold a steady cadence.',
    segments: [
      seg('Warm-up', 240, 15, 'warmup', 120),
      ...Array.from({ length: 10 }, (_, i) => seg(`Km ${i + 1}`, 120, 30 + i * 5, 'work', 120)),
      seg('Summit', 60, 85, 'work', 110),
      seg('Descent', 240, 10, 'cooldown', 110),
    ],
  },
];

export const totalDuration = (circuit) => circuit.segments.reduce((t, s) => t + s.duration, 0);

/** Convert an intensity % into a level on the machine's range, snapped to its step. */
export function pctToLevel(pct, range, scale = 1) {
  const p = Math.max(0, Math.min(100, pct * scale)) / 100;
  const raw = range.min + (range.max - range.min) * p;
  const step = range.step || 1;
  const snapped = range.min + Math.round((raw - range.min) / step) * step;
  return Math.round(Math.min(range.max, Math.max(range.min, snapped)) * 10) / 10;
}
