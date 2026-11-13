'use strict';
// Loads the settings pages in headless Chrome against a pretend Stream Deck and
// checks that they render the device list and save the right settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');
const { WebSocketServer } = require('ws');

const UI = path.join(__dirname, '..', 'com.diy.audioquick.sdPlugin', 'ui');
const SHOTS = path.join(__dirname, '..', 'build');

/** Chrome (or Edge) to drive: CHROME_PATH wins, otherwise the usual install locations. */
function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const env = process.env;
  const candidates = {
    win32: [
      [env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'],
      [env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'],
      [env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'],
      [env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'], // ships with Windows 10/11
      [env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ],
    darwin: [
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ],
  }[process.platform] || [
    ['/usr/bin/google-chrome'], ['/usr/bin/google-chrome-stable'], ['/usr/bin/chromium'], ['/usr/bin/chromium-browser'],
  ];
  return candidates
    .filter((parts) => parts[0])
    .map((parts) => path.join(...parts))
    .find((file) => fs.existsSync(file)) || null;
}
const BROWSER = findBrowser();
const HEADSET = 'Headset Earphone (Wireless Gaming Headset)';
const DEVICES = {
  type: 'devices',
  error: null,
  render: [
    { name: '喇叭 (USB DAC)', label: 'USB DAC' },
    { name: HEADSET, label: 'Wireless Gaming Headset' },
    { name: 'Onboard Digital Output (Onboard(R) Audio)', label: 'Onboard Digital Output' },
    { name: 'Display 27 (HDMI Audio Device)', label: 'Display 27' },
  ],
  capture: [{ name: 'Headset Microphone (Wireless Gaming Headset)', label: 'Wireless Gaming Headset' }],
};

async function open(browser, wss, file, action, settings, devices) {
  const messages = [];
  wss.removeAllListeners('connection');
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const m = JSON.parse(String(data));
      messages.push(m);
      if (m.event === 'sendToPlugin' && m.payload.type === 'getDevices') {
        socket.send(JSON.stringify({ event: 'sendToPropertyInspector', action, context: 'CTX', payload: devices }));
      }
    });
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: 460, height: 560, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(path.join(UI, file)).href);
  await page.evaluate((port, info) => connectElgatoStreamDeckSocket(port, 'CTX', 'registerPropertyInspector', '{}', info),
    wss.address().port, JSON.stringify({ action, context: 'KEY', payload: { settings } }));
  await new Promise((r) => setTimeout(r, 300));
  return { page, messages, errors, saved: () => messages.filter((m) => m.event === 'setSettings').map((m) => m.payload) };
}

test('settings pages', { skip: !BROWSER && '找不到 Chrome 或 Edge；可用環境變數 CHROME_PATH 指定執行檔' }, async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const browser = await puppeteer.launch({ executablePath: BROWSER, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  t.after(async () => { await browser.close(); wss.close(); });

  await t.test('switch page: fresh key', async () => {
    const ui = await open(browser, wss, 'switch.html', 'com.diy.audioquick.switch', {}, DEVICES);
    assert.deepEqual(ui.errors, []);
    assert.equal(ui.messages[0].event, 'registerPropertyInspector');
    assert.equal(await ui.page.$$eval('.device', (n) => n.length), 2);
    const options = await ui.page.$$eval('.device:first-child .top select option', (n) => n.map((o) => o.textContent));
    assert.deepEqual(options, ['— 請選擇裝置 —', ...DEVICES.render.map((d) => d.name)]);

    await ui.page.select('.device:nth-child(1) .top select', '喇叭 (USB DAC)');
    await ui.page.select('.device:nth-child(2) .top select', HEADSET);
    await ui.page.type('.device:nth-child(2) .bottom input', '耳機');
    await ui.page.select('.device:nth-child(1) .bottom select', 'speaker');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(ui.saved().pop(), {
      flow: 'render', setComm: true, showTitle: true,
      devices: [{ name: '喇叭 (USB DAC)', label: '', icon: 'speaker' }, { name: HEADSET, label: '耳機', icon: '' }],
    });
    const placeholder = await ui.page.$eval('.device:nth-child(1) .bottom input', (n) => n.placeholder);
    assert.match(placeholder, /USB DAC/);
    await ui.page.screenshot({ path: path.join(SHOTS, 'ui-switch.png'), fullPage: true });

    // Reorder, remove, toggle options.
    await ui.page.click('.device:nth-child(2) .top button:nth-of-type(1)');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ui.saved().pop().devices.map((d) => d.name), [HEADSET, '喇叭 (USB DAC)']);
    await ui.page.click('#setComm');
    assert.equal((await new Promise((r) => setTimeout(() => r(ui.saved().pop()), 50))).setComm, false);
    await ui.page.click('.device:nth-child(1) .top button:nth-of-type(2)');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ui.saved().pop().devices.map((d) => d.name), ['喇叭 (USB DAC)']);
    await ui.page.close();
  });

  await t.test('switch page: saved device not connected, helper error shown', async () => {
    const saved = { flow: 'render', devices: [{ name: '喇叭 (USB DAC)', label: 'Desk', icon: '' }, { name: 'Speakers (Old DAC)', label: '', icon: '' }] };
    const ui = await open(browser, wss, 'switch.html', 'com.diy.audioquick.switch', saved, DEVICES);
    assert.deepEqual(ui.errors, []);
    const second = await ui.page.$eval('.device:nth-child(2) .top select', (n) => ({ value: n.value, text: n.selectedOptions[0].textContent, missing: n.classList.contains('missing') }));
    assert.deepEqual(second, { value: 'Speakers (Old DAC)', text: 'Speakers (Old DAC)（目前未連接）', missing: true });
    assert.equal(await ui.page.$eval('.device:nth-child(1) .top select', (n) => n.value), '喇叭 (USB DAC)');
    assert.equal(await ui.page.$eval('.device:nth-child(1) .bottom input', (n) => n.value), 'Desk');
    assert.equal(ui.saved().length, 0, 'opening the page must not rewrite settings');
    await ui.page.screenshot({ path: path.join(SHOTS, 'ui-switch-missing.png'), fullPage: true });
    await ui.page.close();

    const broken = await open(browser, wss, 'switch.html', 'com.diy.audioquick.switch', saved, { type: 'devices', render: [], capture: [], error: '音訊服務編譯失敗' });
    assert.equal(await broken.page.$eval('#status', (n) => n.classList.contains('show')), true);
    // Both saved devices are still there even though nothing could be listed.
    assert.deepEqual(await broken.page.$$eval('.device .top select', (n) => n.map((s) => s.value)), ['喇叭 (USB DAC)', 'Speakers (Old DAC)']);
    await broken.page.close();
  });

  await t.test('switch page: changing to input lists microphones', async () => {
    const ui = await open(browser, wss, 'switch.html', 'com.diy.audioquick.switch', {}, DEVICES);
    await ui.page.click('input[name="flow"][value="capture"]');
    await new Promise((r) => setTimeout(r, 50));
    const options = await ui.page.$$eval('.device:first-child .top select option', (n) => n.map((o) => o.value));
    assert.deepEqual(options, ['', DEVICES.capture[0].name]);
    assert.equal(ui.saved().pop().flow, 'capture');
    await ui.page.close();
  });

  await t.test('mic page', async () => {
    const ui = await open(browser, wss, 'micmute.html', 'com.diy.audioquick.micmute', {}, DEVICES);
    assert.deepEqual(ui.errors, []);
    const hidden = () => ui.page.$eval('#deviceRow', (n) => getComputedStyle(n).display === 'none');
    assert.equal(await hidden(), true);
    await ui.page.select('#target', 'all');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ui.saved().pop(), { target: 'all', name: '' });
    await ui.page.select('#target', 'device');
    assert.equal(await hidden(), false);
    await ui.page.select('#device', DEVICES.capture[0].name);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(ui.saved().pop(), { target: 'device', name: DEVICES.capture[0].name });
    await ui.page.screenshot({ path: path.join(SHOTS, 'ui-mic.png'), fullPage: true });
    await ui.page.close();
  });
});
