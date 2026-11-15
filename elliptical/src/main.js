import { FtmsMachine } from './ble/ftms-device.js';
import { SimulatedMachine } from './ble/simulator.js';
import { inspectDevice } from './ble/inspector.js';
import { CIRCUITS, totalDuration, pctToLevel } from './workout/circuits.js';
import { WorkoutEngine } from './workout/engine.js';
import { renderProfile } from './ui/profile-chart.js';

const $ = (id) => document.getElementById(id);
const fmt = (s) => {
  s = Math.max(0, Math.ceil(s));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Telemetry bus – the hook for the future 3D world.
 * 'telemetry' detail: { speedKmh, cadence, powerW, resistance, heartRate, … }
 * 'workout'   detail: { state, segment, level, elapsed, total }
 */
export const bus = new EventTarget();
window.ellipticalBus = bus;

let machine = null;
let engine = null;
let chart = null;
let ticker = null;
let wakeLock = null;

// ---------- Logging ----------
function log(msg) {
  const t = new Date().toLocaleTimeString();
  $('log').textContent = `[${t}] ${msg}\n` + $('log').textContent;
}

// ---------- Connection ----------
if (!FtmsMachine.isSupported()) {
  $('ble-warning').hidden = false;
  $('ble-warning').textContent =
    'This browser has no Web Bluetooth. Use Chrome or Edge on Android / Windows / macOS, or the Bluefy browser on iPhone/iPad. The simulator works everywhere.';
  $('btn-ble').disabled = true;
  $('btn-inspect').disabled = true;
}

$('btn-inspect').onclick = async () => {
  const pre = $('inspect-out');
  pre.hidden = false;
  pre.textContent = 'Pick your machine in the browser dialog…\n';
  try {
    const report = await inspectDevice((line) => { pre.textContent += line + '\n'; });
    $('btn-copy-report').hidden = false;
    $('btn-copy-report').onclick = () => navigator.clipboard.writeText(report);
  } catch (e) {
    pre.textContent += `Error: ${e.message}\n`;
  }
};

async function useMachine(m) {
  m.addEventListener('log', (e) => log(e.detail));
  m.addEventListener('data', (e) => onData(e.detail));
  m.addEventListener('disconnect', () => {
    setStatus('Disconnected', 'pill-off');
    if (engine?.state === 'running') engine.pause();
  });
  await m.connect();
  machine = m;
  setStatus(m.kind === 'sim' ? 'Simulator' : `Connected: ${m.name}`, m.kind === 'sim' ? 'pill-sim' : 'pill-on');
  $('connect').hidden = true;
  $('picker').hidden = false;
  $('sim-panel').hidden = m.kind !== 'sim';
  renderPicker();
}

$('btn-ble').onclick = async () => {
  try {
    await useMachine(new FtmsMachine({ encoding: $('encoding').value }));
  } catch (e) {
    log(`Bluetooth error: ${e.message}`);
    $('ble-warning').hidden = false;
    $('ble-warning').textContent = e.name === 'NotFoundError'
      ? 'No machine selected. If your elliptical is not in the list, it may not support FTMS — see README for the QZ bridge option.'
      : e.message;
  }
};
$('btn-sim').onclick = () => useMachine(new SimulatedMachine());

function setStatus(text, cls) {
  $('status').textContent = text;
  $('status').className = `pill ${cls}`;
}

// ---------- Circuit picker ----------
function renderPicker() {
  const list = $('circuit-list');
  list.replaceChildren();
  for (const c of CIRCUITS) {
    const card = document.createElement('button');
    card.className = 'circuit';
    const levels = c.segments.map((s) => pctToLevel(s.pct, machine.range));
    card.innerHTML = `
      <h3></h3>
      <svg class="profile"></svg>
      <p></p>
      <div class="meta">${fmt(totalDuration(c))} · levels ${Math.min(...levels)}–${Math.max(...levels)}</div>`;
    card.querySelector('h3').textContent = c.name;
    card.querySelector('p').textContent = c.description;
    renderProfile(card.querySelector('svg'), c, { height: 50 });
    card.onclick = () => openWorkout(c);
    list.append(card);
  }
}

// ---------- Workout ----------
function openWorkout(circuit) {
  engine = new WorkoutEngine(machine);
  engine.setScale(Number($('scale').value) / 100);
  engine.load(circuit);
  chart = renderProfile($('w-profile'), circuit, { height: 100 });

  $('w-name').textContent = circuit.name;
  $('w-total').textContent = fmt(engine.total);
  $('w-seg').textContent = 'Ready';
  $('w-countdown').textContent = fmt(circuit.segments[0].duration);
  $('w-next').textContent = circuit.segments[0].label;
  $('w-level').textContent = engine.levelFor(0);
  $('btn-start').textContent = 'Start';

  engine.addEventListener('segment', (e) => {
    const { index, segment, level } = e.detail;
    $('w-seg').textContent = segment.label;
    const next = circuit.segments[index + 1];
    $('w-next').textContent = next ? `${next.label} (lvl ${engine.levelFor(index + 1)})` : 'Finish';
    $('m-target').textContent = segment.cadence ? `· target ${segment.cadence}` : '';
    const lv = $('w-level');
    lv.textContent = level;
    lv.classList.remove('flash'); void lv.offsetWidth; lv.classList.add('flash');
    beep(880, 0.15);
    bus.dispatchEvent(new CustomEvent('workout', { detail: { state: engine.state, segment, level, index } }));
  });

  let lastBeepSecond = null;
  engine.addEventListener('tick', (e) => {
    const d = e.detail;
    chart.setProgress(d.elapsed, d.index);
    $('w-countdown').textContent = fmt(d.segmentRemaining);
    $('m-elapsed').textContent = fmt(d.elapsed);
    // 3-2-1 beeps before a segment change
    const sec = Math.ceil(d.segmentRemaining);
    if (engine.state === 'running' && sec <= 3 && sec >= 1 && sec !== lastBeepSecond) beep(440, 0.08);
    lastBeepSecond = sec;
  });

  engine.addEventListener('state', (e) => {
    const s = e.detail.state;
    $('btn-start').textContent = s === 'running' ? 'Pause' : s === 'paused' ? 'Resume' : s === 'finished' ? 'Restart' : 'Start';
    if (s === 'finished') { $('w-seg').textContent = 'Done! 🎉'; $('w-countdown').textContent = '0:00'; beep(660, 0.4); }
    if (s === 'running') keepAwake(); else releaseWake();
    bus.dispatchEvent(new CustomEvent('workout', { detail: { state: s } }));
  });

  engine.addEventListener('error', (e) => log(`Resistance error: ${e.detail.message ?? e.detail}`));

  clearInterval(ticker);
  ticker = setInterval(() => engine.update(), 250);

  $('picker').hidden = true;
  $('workout').hidden = false;
  window.scrollTo(0, 0);
}

$('btn-start').onclick = () => {
  unlockAudio();
  engine.state === 'running' ? engine.pause() : engine.start();
};
$('btn-skip').onclick = () => engine?.skip();
$('btn-stop').onclick = () => engine?.stop();
$('btn-plus').onclick = () => { engine?.nudge(+1); $('w-level').textContent = engine.levelFor(Math.max(0, engine.index)); };
$('btn-minus').onclick = () => { engine?.nudge(-1); $('w-level').textContent = engine.levelFor(Math.max(0, engine.index)); };
$('btn-back').onclick = () => {
  if (engine?.state === 'running' && !confirm('Leave this workout?')) return;
  engine?.stop();
  clearInterval(ticker);
  $('workout').hidden = true;
  $('picker').hidden = false;
};
$('scale').oninput = (e) => {
  $('scale-val').textContent = `${e.target.value}%`;
  engine?.setScale(Number(e.target.value) / 100);
  if (engine && engine.index < 0) $('w-level').textContent = engine.levelFor(0);
};

// ---------- Live data ----------
function onData(d) {
  if (d.cadence != null) $('m-cadence').textContent = Math.round(d.cadence);
  if (d.powerW != null) $('m-power').textContent = d.powerW;
  if (d.speedKmh != null) $('m-speed').textContent = d.speedKmh.toFixed(1);
  if (d.heartRate) $('m-hr').textContent = d.heartRate;
  if (d.distanceM != null) $('m-dist').textContent = d.distanceM >= 1000 ? `${(d.distanceM / 1000).toFixed(2)} km` : `${d.distanceM} m`;
  if (d.kcal != null) $('m-kcal').textContent = d.kcal;
  if (d.resistance != null) $('w-mlevel').textContent = d.resistance;
  bus.dispatchEvent(new CustomEvent('telemetry', { detail: d }));
}

// ---------- Simulator controls ----------
$('sim-cadence').oninput = (e) => {
  $('sim-val').textContent = e.target.value;
  machine?.setCadence?.(Number(e.target.value));
};
window.addEventListener('keydown', (e) => {
  if (machine?.kind !== 'sim' || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const s = $('sim-cadence');
  s.value = Number(s.value) + (e.key === 'ArrowUp' ? 5 : -5);
  s.dispatchEvent(new Event('input'));
});

// ---------- Audio cues + screen wake lock ----------
let audio = null;
function unlockAudio() { audio ??= new (window.AudioContext || window.webkitAudioContext)(); audio.resume?.(); }
function beep(freq, dur) {
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.15, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + dur);
  o.connect(g).connect(audio.destination);
  o.start(); o.stop(audio.currentTime + dur);
}
async function keepAwake() {
  try { wakeLock ??= await navigator.wakeLock?.request('screen'); } catch { /* not critical */ }
}
function releaseWake() { wakeLock?.release?.(); wakeLock = null; }
