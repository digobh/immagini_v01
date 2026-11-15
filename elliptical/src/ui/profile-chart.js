// SVG bar chart of a circuit: bar width = duration, bar height = intensity.

import { totalDuration } from '../workout/circuits.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

export function renderProfile(svg, circuit, { height = 100, gap = 0.6 } = {}) {
  svg.replaceChildren();
  const total = totalDuration(circuit);
  const W = 1000;
  svg.setAttribute('viewBox', `0 0 ${W} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const bars = [];
  let x = 0;
  circuit.segments.forEach((s, i) => {
    const w = (s.duration / total) * W;
    const h = height * (0.12 + 0.88 * (s.pct / 100));
    const r = el('rect', {
      x: x + gap / 2, y: height - h, width: Math.max(0.5, w - gap), height: h,
      class: `bar bar-${s.kind ?? 'work'}`,
    });
    r.dataset.index = i;
    svg.append(r);
    bars.push(r);
    x += w;
  });
  const head = el('rect', { x: 0, y: 0, width: 3, height, class: 'playhead', visibility: 'hidden' });
  svg.append(head);
  return {
    setProgress(elapsed, index) {
      const px = (elapsed / total) * W;
      head.setAttribute('x', Math.min(W - 3, px));
      head.setAttribute('visibility', 'visible');
      bars.forEach((b, i) => {
        b.classList.toggle('done', i < index);
        b.classList.toggle('active', i === index);
      });
    },
  };
}
