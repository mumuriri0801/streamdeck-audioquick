'use strict';
// AudioQuick - Stream Deck plugin entry point.
// Speaks the Stream Deck WebSocket protocol directly (no SDK wrapper) and delegates all
// Windows audio work to the helper process managed by ./host.js.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const logic = require('./logic');
const { AudioHost } = require('./host');

const PLUGIN_UUID = 'com.diy.audioquick';
const ACTION_SWITCH = `${PLUGIN_UUID}.switch`;
const ACTION_MUTE = `${PLUGIN_UUID}.micmute`;

const pluginDir = path.resolve(__dirname, '..');

// ---- logging ---------------------------------------------------------------

const logDir = path.join(pluginDir, 'logs');
const logFile = path.join(logDir, 'audioquick.log');
try {
  fs.mkdirSync(logDir, { recursive: true });
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, logFile + '.old');
} catch (_) { /* logging is best-effort */ }

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try { fs.appendFileSync(logFile, line, 'utf8'); } catch (_) { /* ignore */ }
}

process.on('uncaughtException', (err) => log(`uncaughtException: ${err && err.stack}`));
process.on('unhandledRejection', (err) => log(`unhandledRejection: ${err && err.stack}`));

// ---- arguments from Stream Deck --------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i].startsWith('-')) out[argv[i].slice(1)] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.port || !args.pluginUUID || !args.registerEvent) {
  log(`missing launch arguments: ${JSON.stringify(process.argv.slice(2))}`);
  process.exit(1);
}

// ---- key images ------------------------------------------------------------

const images = {};
function image(name) {
  if (!(name in images)) {
    try {
      const data = fs.readFileSync(path.join(pluginDir, 'imgs', 'keys', `${name}@2x.png`));
      images[name] = `data:image/png;base64,${data.toString('base64')}`;
    } catch (err) {
      log(`missing image ${name}: ${err.message}`);
      images[name] = null;
    }
  }
  return images[name];
}

// ---- Stream Deck connection ------------------------------------------------

const contexts = new Map(); // context -> { action, settings, last: { image, title, state } }
const inspectors = new Map(); // context -> action, for visible settings pages
const host = new AudioHost({ hostDir: path.join(pluginDir, 'host'), log });

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);

function send(message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

ws.on('open', () => {
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  log('connected to Stream Deck');
  host.start();
});
ws.on('close', () => {
  host.stop();
  process.exit(0);
});
ws.on('error', (err) => log(`websocket error: ${err.message}`));
ws.on('message', (data) => {
  let message;
  try { message = JSON.parse(String(data)); } catch (_) { return; }
  try { onEvent(message); } catch (err) { log(`error handling ${message && message.event}: ${err.stack}`); }
});

host.on('change', () => {
  for (const context of contexts.keys()) render(context);
  for (const [context, action] of inspectors) sendDevices(context, action);
});

// ---- rendering -------------------------------------------------------------

function render(context, force) {
  const item = contexts.get(context);
  if (!item) return;
  if (force) item.last = {};

  if (item.action === ACTION_SWITCH) {
    const view = logic.describeSwitch(host.snapshot, item.settings);
    const name = view.icon === 'unset' || view.icon === 'error' ? view.icon : `${view.icon}-${view.lit ? 'on' : 'off'}`;
    if (item.last.image !== name) {
      const data = image(name);
      if (data) send({ event: 'setImage', context, payload: { image: data, target: 0 } });
      item.last.image = name;
    }
    setTitle(context, item, view.title);
  } else if (item.action === ACTION_MUTE) {
    const view = logic.describeMute(host.snapshot, item.settings);
    const state = view.available && !view.muted ? 0 : 1; // 0 = live, 1 = muted
    if (item.last.state !== state) {
      send({ event: 'setState', context, payload: { state } });
      item.last.state = state;
    }
    setTitle(context, item, view.available ? '' : host.snapshot ? '無裝置' : '未就緒');
  }
}

function setTitle(context, item, title) {
  if (item.last.title === title) return;
  send({ event: 'setTitle', context, payload: { title, target: 0 } });
  item.last.title = title;
}

function describeDevices(flow) {
  return logic.deviceNames(host.snapshot, flow).map((name) => ({ name, label: logic.autoLabel(name) }));
}

function sendDevices(context, action) {
  send({
    event: 'sendToPropertyInspector',
    action,
    context,
    payload: {
      type: 'devices',
      render: describeDevices('render'),
      capture: describeDevices('capture'),
      error: host.snapshot ? null : host.error || '音訊服務未就緒',
    },
  });
}

// ---- events ----------------------------------------------------------------

function onEvent(message) {
  const { event, context, action } = message;
  const payload = message.payload || {};

  switch (event) {
    case 'willAppear':
      contexts.set(context, { action, settings: payload.settings || {}, last: {} });
      render(context);
      break;

    case 'willDisappear':
      contexts.delete(context);
      break;

    case 'didReceiveSettings': {
      const item = contexts.get(context);
      if (item) {
        item.settings = payload.settings || {};
        render(context, true);
      }
      break;
    }

    case 'keyDown': {
      const settings = payload.settings || (contexts.get(context) || {}).settings || {};
      if (action === ACTION_SWITCH) pressSwitch(context, settings);
      else if (action === ACTION_MUTE) pressMute(context, settings, payload);
      break;
    }

    case 'keyUp':
      // Stream Deck may flip a two-state key by itself on release; put the real state back.
      if (action === ACTION_MUTE) {
        render(context, true);
        setTimeout(() => render(context, true), 250);
      }
      break;

    case 'propertyInspectorDidAppear':
      inspectors.set(context, action);
      sendDevices(context, action);
      break;

    case 'propertyInspectorDidDisappear':
      inspectors.delete(context);
      break;

    case 'sendToPlugin':
      if (payload.type === 'getDevices') {
        inspectors.set(context, action);
        sendDevices(context, action);
        host.send('refresh').catch(() => {});
      }
      break;

    case 'systemDidWakeUp':
      host.send('refresh').catch(() => {});
      break;

    default:
      break;
  }
}

function alert(context, reason) {
  log(`alert: ${reason}`);
  send({ event: 'showAlert', context });
}

function pressSwitch(context, settings) {
  const plan = logic.planSwitch(host.snapshot, settings);
  if (plan.error) {
    alert(context, `switch: ${plan.error}${host.error ? ` (${host.error})` : ''}`);
    return;
  }
  if (plan.noop) return;
  const alsoCommunications = settings.setComm === false ? 0 : 1;
  host.send('setDefault', plan.device.id, alsoCommunications)
    .then(() => log(`default ${logic.switchFlow(settings)} -> ${plan.device.name}`))
    .catch((err) => alert(context, `setDefault failed: ${err.message}`));
}

function pressMute(context, settings, payload) {
  const targets = logic.muteTargets(host.snapshot, settings);
  if (targets.length === 0) {
    alert(context, `mute: no target device${host.error ? ` (${host.error})` : ''}`);
    return;
  }
  let mute = !targets.every((d) => d.muted);
  // Inside a multi-action the user picks the wanted state explicitly.
  if (payload.isInMultiAction && typeof payload.userDesiredState === 'number') mute = payload.userDesiredState === 1;
  Promise.all(targets.map((d) => host.send('setMute', d.id, mute ? 1 : 0)))
    .then(() => log(`${mute ? 'muted' : 'unmuted'}: ${targets.map((d) => d.name).join(', ')}`))
    .catch((err) => alert(context, `setMute failed: ${err.message}`));
}
