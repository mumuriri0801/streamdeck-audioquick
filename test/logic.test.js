'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/logic');

const base = () => ({
  devices: [
    { id: 'A1', name: '喇叭 (2- USB DAC)', flow: 'render' },
    { id: 'B1', name: 'Headset Earphone (Wireless Gaming Headset)', flow: 'render' },
    { id: 'C1', name: 'Onboard Digital Output (Onboard(R) Audio)', flow: 'render' },
    { id: 'D1', name: 'Display 27 (HDMI Audio Device)', flow: 'render' },
    { id: 'M1', name: 'Headset Microphone (Wireless Gaming Headset)', flow: 'capture', muted: false },
    { id: 'M2', name: '麥克風 (Onboard(R) Audio)', flow: 'capture', muted: true },
  ],
  defaults: { render: 'A1', renderCommunications: 'A1', capture: 'M1', captureCommunications: 'M2' },
});
const HEADSET = 'Headset Earphone (Wireless Gaming Headset)';
const two = { devices: [{ name: '喇叭 (USB DAC)' }, { name: HEADSET }] };

test('normalizeName strips the Windows re-install counter only', () => {
  assert.equal(L.normalizeName('喇叭 (2- USB DAC)'), '喇叭 (USB DAC)');
  assert.equal(L.normalizeName('Speakers (13- USB Audio)'), 'Speakers (USB Audio)');
  assert.equal(L.normalizeName('Onboard Digital Output (Onboard(R) Audio)'), 'Onboard Digital Output (Onboard(R) Audio)');
  assert.equal(L.normalizeName('Speakers (2-Channel DAC)'), 'Speakers (2-Channel DAC)');
  assert.equal(L.normalizeName('  A   B '), 'A B');
});

test('sameName ignores counter and case, never matches empty', () => {
  assert.ok(L.sameName('喇叭 (USB DAC)', '喇叭 (2- USB DAC)'));
  assert.ok(L.sameName('喇叭 (3- USB DAC)', '喇叭 (2- USB DAC)'));
  assert.ok(L.sameName('SPEAKERS (x)', 'speakers (X)'));
  assert.ok(!L.sameName('', ''));
  assert.ok(!L.sameName('喇叭 (USB DAC)', '喇叭 (Onboard(R) Audio)'));
});

test('deviceNames are normalised and de-duplicated per flow', () => {
  const s = base();
  s.devices.push({ id: 'A9', name: '喇叭 (USB DAC)', flow: 'render' });
  assert.deepEqual(L.deviceNames(s, 'render'), [
    '喇叭 (USB DAC)', HEADSET, 'Onboard Digital Output (Onboard(R) Audio)', 'Display 27 (HDMI Audio Device)',
  ]);
  assert.equal(L.deviceNames(s, 'capture').length, 2);
  assert.deepEqual(L.deviceNames(null, 'render'), []);
});

test('autoLabel prefers the informative half of the name', () => {
  assert.equal(L.autoLabel('喇叭 (2- USB DAC)'), 'USB DAC');
  assert.equal(L.autoLabel(HEADSET), 'Wireless Gaming Headset');
  assert.equal(L.autoLabel('Display 27 (HDMI Audio Device)'), 'Display 27');
  assert.equal(L.autoLabel('Onboard Digital Output (Onboard(R) Audio)'), 'Onboard Digital Output');
  // Windows (zh-TW) names a headset's microphone "耳麥式麥克風 (...)".
  assert.equal(L.autoLabel('耳麥式麥克風 (Wireless Gaming Headset)'), 'Wireless Gaming Headset');
  assert.equal(L.autoLabel('Plain'), 'Plain');
});

test('wrapTitle keeps lines short', () => {
  assert.equal(L.wrapTitle('USB DAC'), 'USB DAC');
  assert.equal(L.wrapTitle('Wireless Gaming Headset'), 'Wireless\nGaming\nHeadset');
  assert.equal(L.wrapTitle('Wireless Gaming Headset Pro Max'), 'Wireless\nGaming\nHeadset…');
  assert.equal(L.wrapTitle('Onboard Digital Output'), 'Onboard\nDigital\nOutput');
  assert.equal(L.wrapTitle('客廳的大喇叭'), '客廳的大喇\n叭');
  assert.equal(L.wrapTitle('Supercalifragilistic'), 'Supercalif\nragilistic');
  assert.equal(L.wrapTitle('a\nb'), 'a\nb');
  assert.equal(L.wrapTitle(''), '');
  for (const line of L.wrapTitle('one two three four five six seven eight nine ten').split('\n')) assert.ok(line.length <= 10, line);
});

test('guessIcon', () => {
  assert.equal(L.guessIcon(HEADSET, 'render'), 'headphones');
  assert.equal(L.guessIcon('Display 27 (HDMI Audio Device)', 'render'), 'monitor');
  assert.equal(L.guessIcon('喇叭 (USB DAC)', 'render'), 'speaker');
  assert.equal(L.guessIcon('anything', 'capture'), 'mic');
});

test('planSwitch toggles between two devices', () => {
  const s = base();
  assert.equal(L.planSwitch(s, two).device.id, 'B1');
  s.defaults.render = 'B1';
  assert.equal(L.planSwitch(s, two).device.id, 'A1');
});

test('planSwitch survives a device coming back with a new ID and counter', () => {
  const s = base();
  s.devices[1] = { id: 'B2-NEW', name: 'Headset Earphone (3- Wireless Gaming Headset)', flow: 'render' };
  assert.equal(L.planSwitch(s, two).device.id, 'B2-NEW');
  s.defaults.render = 'B2-NEW';
  assert.equal(L.planSwitch(s, two).device.id, 'A1');
  assert.equal(L.describeSwitch(s, two).lit, true);
  assert.equal(L.describeSwitch(s, two).icon, 'headphones');
});

test('planSwitch starts at the first entry when the system is on some other device', () => {
  const s = base();
  s.defaults.render = 'D1';
  assert.equal(L.planSwitch(s, two).device.id, 'A1');
  const view = L.describeSwitch(s, two);
  assert.deepEqual([view.icon, view.lit, view.title], ['monitor', false, 'Display 27']);
});

test('planSwitch skips unplugged devices and cycles through three', () => {
  const three = { devices: [{ name: '喇叭 (USB DAC)' }, { name: HEADSET }, { name: 'Display 27 (HDMI Audio Device)' }] };
  const s = base();
  s.devices = s.devices.filter((d) => d.id !== 'B1');
  assert.equal(L.planSwitch(s, three).device.id, 'D1');
  s.defaults.render = 'D1';
  assert.equal(L.planSwitch(s, three).device.id, 'A1');
  // Only the current one is left: nothing to do, and no error.
  s.devices = s.devices.filter((d) => d.id !== 'D1');
  s.defaults.render = 'A1';
  assert.deepEqual(L.planSwitch(s, three), { noop: true });
});

test('planSwitch errors', () => {
  assert.equal(L.planSwitch(null, two).error, 'host');
  assert.equal(L.planSwitch(base(), {}).error, 'unset');
  assert.equal(L.planSwitch(base(), { devices: [{ name: '' }] }).error, 'unset');
  assert.equal(L.planSwitch(base(), { devices: [{ name: 'Gone (X)' }, { name: 'Gone (Y)' }] }).error, 'unavailable');
  assert.equal(L.planSwitch(base(), { devices: [{ name: 'Gone (X)' }] }).error, 'unavailable');
});

test('single-entry list behaves as "set"', () => {
  const one = { devices: [{ name: HEADSET, label: '耳機' }] };
  const s = base();
  assert.equal(L.planSwitch(s, one).device.id, 'B1');
  assert.deepEqual(L.describeSwitch(s, one), { icon: 'headphones', lit: false, title: '耳機' });
  s.defaults.render = 'B1';
  assert.equal(L.planSwitch(s, one).device.id, 'B1'); // re-applies, harmless
  assert.equal(L.describeSwitch(s, one).lit, true);
});

test('describeSwitch honours label, icon, showTitle and capture flow', () => {
  const s = base();
  const cfg = { devices: [{ name: '喇叭 (USB DAC)', label: 'Desk', icon: 'monitor' }, { name: HEADSET }] };
  assert.deepEqual(L.describeSwitch(s, cfg), { icon: 'monitor', lit: true, title: 'Desk' });
  assert.equal(L.describeSwitch(s, { ...cfg, showTitle: false }).title, '');
  assert.equal(L.describeSwitch(s, {}).icon, 'unset');
  assert.equal(L.describeSwitch(null, cfg).icon, 'error');
  const mic = { flow: 'capture', devices: [{ name: '麥克風 (Onboard(R) Audio)' }, { name: 'Headset Microphone (Wireless Gaming Headset)' }] };
  assert.equal(L.planSwitch(s, mic).device.id, 'M2');
  assert.equal(L.describeSwitch(s, mic).icon, 'mic');
});

test('mute targets', () => {
  const s = base();
  assert.deepEqual(L.muteTargets(s, {}).map((d) => d.id), ['M1']);
  assert.deepEqual(L.muteTargets(s, { target: 'communications' }).map((d) => d.id), ['M2']);
  assert.deepEqual(L.muteTargets(s, { target: 'all' }).map((d) => d.id), ['M1', 'M2']);
  assert.deepEqual(L.muteTargets(s, { target: 'device', name: '麥克風 (5- Onboard(R) Audio)' }).map((d) => d.id), ['M2']);
  assert.deepEqual(L.muteTargets(s, { target: 'device', name: '' }), []);
  assert.deepEqual(L.muteTargets(null, {}), []);
  assert.deepEqual(L.describeMute(s, {}), { available: true, muted: false });
  assert.deepEqual(L.describeMute(s, { target: 'communications' }), { available: true, muted: true });
  assert.deepEqual(L.describeMute(s, { target: 'all' }), { available: true, muted: false });
  assert.deepEqual(L.describeMute(s, { target: 'device', name: 'nope' }), { available: false, muted: false });
});
