'use strict';
// Shared plumbing for the settings pages: the Stream Deck connection and a few helpers.
// Each page defines  init(settings)  and  onDevices(payload).

var sdSocket = null;
var sdContext = null;
var sdAction = null;

// Stream Deck calls this function by name once the page has loaded.
// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(port, uuid, registerEvent, info, actionInfo) {
  var parsed = JSON.parse(actionInfo);
  sdContext = uuid;
  sdAction = parsed.action;
  var settings = (parsed.payload && parsed.payload.settings) || {};

  sdSocket = new WebSocket('ws://127.0.0.1:' + port);
  sdSocket.onopen = function () {
    sdSocket.send(JSON.stringify({ event: registerEvent, uuid: uuid }));
    init(settings);
    sendToPlugin({ type: 'getDevices' });
  };
  sdSocket.onmessage = function (event) {
    var message = JSON.parse(event.data);
    if (message.event === 'sendToPropertyInspector' && message.payload && message.payload.type === 'devices') {
      showStatus(message.payload.error);
      onDevices(message.payload);
    }
  };
}

function saveSettings(settings) {
  if (sdSocket && sdSocket.readyState === 1) {
    sdSocket.send(JSON.stringify({ event: 'setSettings', context: sdContext, payload: settings }));
  }
}

function sendToPlugin(payload) {
  if (sdSocket && sdSocket.readyState === 1) {
    sdSocket.send(JSON.stringify({ action: sdAction, event: 'sendToPlugin', context: sdContext, payload: payload }));
  }
}

function showStatus(error) {
  var box = document.getElementById('status');
  if (!box) return;
  box.textContent = error ? '⚠ ' + error + '（詳細記錄在插件資料夾的 logs\\audioquick.log）' : '';
  box.classList.toggle('show', !!error);
}

// Same rule the plugin uses: ignore the "2- " counter Windows adds, compare case-insensitively.
function nameKey(name) {
  return String(name || '').replace(/\(\d+- /, '(').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Fills a <select> with the connected devices. A saved device that is not connected right now
 * stays selectable (and selected), marked as not connected - it is never silently dropped.
 */
function fillDeviceSelect(select, devices, selectedName) {
  var wanted = nameKey(selectedName);
  var found = false;
  select.textContent = '';

  var blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '— 請選擇裝置 —';
  select.appendChild(blank);

  devices.forEach(function (device) {
    var option = document.createElement('option');
    option.value = device.name;
    option.textContent = device.name;
    if (wanted && nameKey(device.name) === wanted) {
      option.selected = true;
      found = true;
    }
    select.appendChild(option);
  });

  if (wanted && !found) {
    var missing = document.createElement('option');
    missing.value = selectedName;
    missing.textContent = selectedName + '（目前未連接）';
    missing.selected = true;
    select.appendChild(missing);
  }
  select.classList.toggle('missing', !!wanted && !found);
}
