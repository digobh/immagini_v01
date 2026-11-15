// Bluetooth inspector: connects to ANY nearby device and lists its services and
// characteristics, so we can see whether a machine speaks standard FTMS or a
// proprietary protocol (e.g. older iFit consoles like the ProForm Endurance 420E).
//
// Web Bluetooth only exposes services listed in optionalServices, so we list the
// standard fitness ones plus the known iFit/ICON custom service.

const KNOWN = {
  0x1826: 'Fitness Machine (FTMS) ✅ standard – resistance control possible',
  0x180d: 'Heart Rate',
  0x180a: 'Device Information',
  0x180f: 'Battery',
  0x1816: 'Cycling Speed & Cadence',
  0x1818: 'Cycling Power',
  0x1814: 'Running Speed & Cadence',
  '00001533-1412-efde-1523-785feabcd123': 'iFit / ICON proprietary ⚠️ needs custom driver or QZ bridge',
};

const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
const OPTIONAL = Object.keys(KNOWN).map((k) => (/^\d+$/.test(k) ? Number(k) : k));
const label = (u) => {
  for (const [k, v] of Object.entries(KNOWN)) {
    const full = /^\d+$/.test(k) ? uuid16(Number(k)) : k;
    if (full === u) return v;
  }
  return '';
};
const props = (p) => ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => p[k]).join(', ');
const hex = (dv) => [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const ascii = (dv) => [...new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');

/** Returns a plain-text report. `onLine` streams progress. */
export async function inspectDevice(onLine = () => {}) {
  const lines = [];
  const out = (s) => { lines.push(s); onLine(s); };

  const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: OPTIONAL });
  out(`Device: ${device.name || '(no name)'}  id=${device.id}`);
  const server = await device.gatt.connect();
  try {
    const services = await server.getPrimaryServices();
    if (!services.length) out('No accessible services.');
    for (const s of services) {
      out(`\nSERVICE ${s.uuid}  ${label(s.uuid)}`);
      let chars = [];
      try { chars = await s.getCharacteristics(); } catch (e) { out(`  (cannot list characteristics: ${e.message})`); }
      for (const c of chars) {
        let value = '';
        if (c.properties.read) {
          try { const v = await c.readValue(); value = `  = ${hex(v)}  "${ascii(v)}"`; } catch { value = '  (read failed)'; }
        }
        out(`  CHAR ${c.uuid}  [${props(c.properties)}]${value}`);
      }
    }
    const uuids = services.map((s) => s.uuid);
    out('\nVERDICT:');
    if (uuids.includes(uuid16(0x1826))) out('  Standard FTMS found → use "Connect via Bluetooth".');
    else if (uuids.includes('00001533-1412-efde-1523-785feabcd123')) out('  iFit proprietary protocol → needs the QZ bridge (or a custom driver).');
    else out('  No known fitness service visible. Copy this report and share it.');
  } finally {
    server.disconnect();
  }
  return lines.join('\n');
}
