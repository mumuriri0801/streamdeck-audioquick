'use strict';
// Runs the real bundled plugin against a pretend Stream Deck (WebSocket server)
// and a pretend audio helper, and checks what ends up on the keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PLUGIN = path.join(__dirname, '..', 'com.diy.audioquick.sdPlugin', 'bin', 'plugin.js');
const SWITCH = 'com.diy.audioquick.switch';
const MUTE = 'com.diy.audioquick.micmute';
const HEADSET = 'Headset Earphone (Wireless Gaming Headset)';

const hardware = () => ({
  devices: [
    { id: 'A1', name: '喇叭 (2- USB DAC)', flow: 'render' },
    { id: 'B1', name: HEADSET, flow: 'render' },
    { id: 'D1', name: 'Display 27 (HDMI Audio Device)', flow: 'render' },
    { id: 'M1', name: 'Headset Microphone (Wireless Gaming Headset)', flow: 'capture', muted: false },
  ],
  defaults: { render: 'A1', renderCommunications: 'A1', capture: 'M1', captureCommunications: 'M1' },
});

async function startRig() {
  const control = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-')), 'control.json');
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const received = [];
  let socket;
  const connected = new Promise((r) => wss.once('connection', (s) => {
    socket = s;
    s.on('message', (d) => received.push(JSON.parse(String(d))));
    r();
  }));
  const child = spawn(process.execPath, [PLUGIN, '-port', String(wss.address().port), '-pluginUUID', 'PLUGIN', '-registerEvent', 'registerPlugin', '-info', '{}'], {
    env: { ...process.env, AUDIOQUICK_HOST_CMD: JSON.stringify([process.execPath, path.join(__dirname, 'fake-host.js')]), FAKE_HOST_CONTROL: control },
    stdio: 'inherit',
  });
  await connected;

  let cursor = 0;
  const rig = {
    received,
    send: (m) => socket.send(JSON.stringify(m)),
    setHardware: (h) => fs.writeFileSync(control, JSON.stringify(h)),
    /** Waits for the next message (after the ones already consumed) that matches. */
    async next(match, label) {
      const deadline = Date.now() + 4000;
      for (;;) {
        for (; cursor < received.length; cursor++) {
          if (match(received[cursor])) return received[cursor++];
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(received.slice(-6).map((m) => ({ ...m, payload: m.payload && { ...m.payload, image: m.payload.image && '<png>' } })))}`);
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    title: (context, title) => rig.next((m) => m.event === 'setTitle' && m.context === context && m.payload.title === title, `title "${title}" on ${context}`),
    state: (context, state) => rig.next((m) => m.event === 'setState' && m.context === context && m.payload.state === state, `state ${state} on ${context}`),
    press(action, context, settings, extra) {
      rig.send({ event: 'keyDown', action, context, payload: { settings, ...extra } });
      rig.send({ event: 'keyUp', action, context, payload: { settings, ...extra } });
    },
    async stop() {
      socket.close();
      await new Promise((r) => child.once('exit', r));
      wss.close();
    },
  };
  return rig;
}

test('plugin end to end', async (t) => {
  const rig = await startRig();
  t.after(() => rig.stop());

  const reg = await rig.next((m) => m.event === 'registerPlugin', 'registration');
  assert.equal(reg.uuid, 'PLUGIN');

  const settings = { devices: [{ name: '喇叭 (USB DAC)', label: 'Desk' }, { name: HEADSET, label: '耳機' }] };

  await t.test('switch key shows the current default device', async () => {
    rig.send({ event: 'willAppear', action: SWITCH, context: 'K1', payload: { settings } });
    const img = await rig.next((m) => m.event === 'setImage' && m.context === 'K1', 'image');
    assert.match(img.payload.image, /^data:image\/png;base64,iVBOR/);
    await rig.title('K1', 'Desk');
  });

  await t.test('pressing toggles there and back', async () => {
    rig.press(SWITCH, 'K1', settings);
    await rig.title('K1', '耳機');
    rig.press(SWITCH, 'K1', settings);
    await rig.title('K1', 'Desk');
  });

  await t.test('still works after Windows re-installs the headset under a new ID and name', async () => {
    const h = hardware();
    h.devices[1] = { id: 'B2-NEW', name: 'Headset Earphone (3- Wireless Gaming Headset)', flow: 'render' };
    rig.setHardware(h);
    await new Promise((r) => setTimeout(r, 150));
    rig.press(SWITCH, 'K1', settings);
    await rig.title('K1', '耳機');
    rig.press(SWITCH, 'K1', settings);
    await rig.title('K1', 'Desk');
  });

  await t.test('settings page gets a clean device list (no ghosts, no counters)', async () => {
    rig.send({ event: 'sendToPlugin', action: SWITCH, context: 'K1', payload: { type: 'getDevices' } });
    const msg = await rig.next((m) => m.event === 'sendToPropertyInspector' && m.context === 'K1', 'device list');
    assert.equal(msg.action, SWITCH);
    assert.equal(msg.payload.error, null);
    assert.deepEqual(msg.payload.render, [
      { name: '喇叭 (USB DAC)', label: 'USB DAC' },
      { name: HEADSET, label: 'Wireless Gaming Headset' },
      { name: 'Display 27 (HDMI Audio Device)', label: 'Display 27' },
    ]);
    assert.equal(msg.payload.capture.length, 1);
  });

  await t.test('unplugged target: alert, key follows whatever the system is on', async () => {
    const h = hardware();
    h.devices = h.devices.filter((d) => d.id !== 'B1');
    h.defaults.render = 'D1';
    h.defaults.renderCommunications = 'D1';
    rig.setHardware(h);
    await rig.title('K1', 'Display 27');
    const only = { devices: [{ name: HEADSET }] };
    rig.send({ event: 'willAppear', action: SWITCH, context: 'K2', payload: { settings: only } });
    rig.press(SWITCH, 'K2', only);
    await rig.next((m) => m.event === 'showAlert' && m.context === 'K2', 'alert');
    // The two-device key still works with what is left.
    rig.press(SWITCH, 'K1', settings);
    await rig.title('K1', 'Desk');
  });

  await t.test('new settings are applied immediately', async () => {
    rig.send({ event: 'didReceiveSettings', action: SWITCH, context: 'K1', payload: { settings: { devices: settings.devices, showTitle: false } } });
    await rig.title('K1', '');
  });

  await t.test('mic key toggles mute and follows outside changes', async () => {
    rig.setHardware(hardware());
    rig.send({ event: 'willAppear', action: MUTE, context: 'M', payload: { settings: {} } });
    await rig.state('M', 0);
    rig.press(MUTE, 'M', {});
    await rig.state('M', 1);
    rig.press(MUTE, 'M', {});
    await rig.state('M', 0);
    const h = hardware();
    h.devices[3].muted = true; // muted from somewhere else
    rig.setHardware(h);
    await rig.state('M', 1);
    // In a multi-action the requested state wins: "mute" while muted must stay muted.
    rig.press(MUTE, 'M', {}, { isInMultiAction: true, userDesiredState: 1 });
    await new Promise((r) => setTimeout(r, 400));
    rig.press(MUTE, 'M', {}, { isInMultiAction: true, userDesiredState: 0 });
    await rig.state('M', 0);
  });

  await t.test('no microphone at all', async () => {
    const h = hardware();
    h.devices = h.devices.filter((d) => d.flow !== 'capture');
    h.defaults.capture = null;
    h.defaults.captureCommunications = null;
    rig.setHardware(h);
    await rig.title('M', '無裝置');
    rig.press(MUTE, 'M', {});
    await rig.next((m) => m.event === 'showAlert' && m.context === 'M', 'alert');
  });
});
