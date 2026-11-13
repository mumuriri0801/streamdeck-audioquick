'use strict';
// Stand-in for the Windows helper: same line protocol, devices held in memory.
// A control file (path in FAKE_HOST_CONTROL) lets the test change the "hardware".
const fs = require('fs');
const readline = require('readline');

let state = {
  devices: [
    { id: 'A1', name: '喇叭 (2- USB DAC)', flow: 'render' },
    { id: 'B1', name: 'Headset Earphone (Wireless Gaming Headset)', flow: 'render' },
    { id: 'C1', name: 'Onboard Digital Output (Onboard(R) Audio)', flow: 'render' },
    { id: 'D1', name: 'Display 27 (HDMI Audio Device)', flow: 'render' },
    { id: 'M1', name: 'Headset Microphone (Wireless Gaming Headset)', flow: 'capture', muted: false },
    { id: 'M2', name: '麥克風 (Onboard(R) Audio)', flow: 'capture', muted: false },
  ],
  defaults: { render: 'A1', renderCommunications: 'A1', capture: 'M1', captureCommunications: 'M1' },
};

let last = '';
function emitState(force) {
  const line = JSON.stringify({ type: 'state', ...state });
  if (force || line !== last) { console.log(line); last = line; }
}

console.log(JSON.stringify({ type: 'hello', version: 'fake' }));
emitState();

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [id, command, a, b] = line.split('\t');
  let ok = true; let error;
  if (command === 'setDefault') {
    const d = state.devices.find((x) => x.id === a);
    if (!d) { ok = false; error = 'device not found'; } else {
      state.defaults[d.flow] = a;
      if (b === '1') state.defaults[d.flow + 'Communications'] = a;
    }
  } else if (command === 'setMute') {
    const d = state.devices.find((x) => x.id === a && x.flow === 'capture');
    if (!d) { ok = false; error = 'device not found'; } else d.muted = b === '1';
  } else if (command !== 'ping' && command !== 'refresh') { ok = false; error = 'unknown command'; }
  console.log(JSON.stringify({ type: 'result', id, ok, error }));
  emitState(command === 'refresh');
}).on('close', () => process.exit(0));

const control = process.env.FAKE_HOST_CONTROL;
let seen = '';
if (control) {
  setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(control, 'utf8'); } catch (_) { return; }
    if (!text || text === seen) return;
    seen = text;
    state = JSON.parse(text);
    emitState();
  }, 30);
}
