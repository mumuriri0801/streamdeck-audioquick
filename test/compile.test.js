'use strict';
// Exercises the "compile the helper on first run" path.
//  - Linux / macOS: a pretend csc.exe (a shebang script) stands in for the compiler.
//  - Windows: the csc.exe that ships with Windows builds the real AudioHost.cs, and the helper
//    is run against the real Core Audio API. That test only reads: it never changes the
//    default device or any mute state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const IS_WINDOWS = process.platform === 'win32';
const SOURCE = path.join(__dirname, '..', 'com.diy.audioquick.sdPlugin', 'host', 'AudioHost.cs');

test('first run compiles, later runs reuse, stale builds are removed', { skip: IS_WINDOWS && '假的 csc.exe 是 shebang 腳本，Windows 無法執行；改跑下面用真 csc.exe 的測試' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aq 測試 '));        // spaces + non-ASCII, like a real user profile
  const hostDir = path.join(root, 'host');
  const framework = path.join(root, 'Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.mkdirSync(framework, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'AudioHost.cs'), '// source v1');
  fs.writeFileSync(path.join(hostDir, 'AudioHost-0123456789.exe'), 'stale');
  const calls = path.join(root, 'calls.log');
  // Pretend compiler: records its arguments, then writes a runnable "exe" to the /out: path.
  fs.writeFileSync(path.join(framework, 'csc.exe'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const out = args.find((a) => a.startsWith('/out:')).slice(5);
fs.writeFileSync(out, '#!${process.execPath}\\n' + fs.readFileSync(${JSON.stringify(path.join(__dirname, 'fake-host.js'))}, 'utf8'));
fs.chmodSync(out, 0o755);
`);
  fs.chmodSync(path.join(framework, 'csc.exe'), 0o755);

  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.WINDIR = path.join(root, 'Windows');
  delete process.env.AUDIOQUICK_HOST_CMD;
  const { AudioHost } = require('../src/host');

  const logs = [];
  const run = async () => {
    const host = new AudioHost({ hostDir, log: (m) => logs.push(m) });
    host.start();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no snapshot: ' + logs.join(' | '))), 5000);
      host.on('change', () => { if (host.snapshot) { clearTimeout(timer); resolve(); } });
    });
    await host.send('setDefault', 'B1', 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(host.snapshot.defaults.render, 'B1');
    await assert.rejects(host.send('setDefault', 'nope', 1), /device not found/);
    host.stop();
  };

  await run();
  const exes = () => fs.readdirSync(hostDir).filter((f) => f.endsWith('.exe'));
  assert.equal(exes().length, 1, 'stale build removed, one new build');
  assert.match(exes()[0], /^AudioHost-[0-9a-f]{10}\.exe$/);
  const first = JSON.parse(fs.readFileSync(calls, 'utf8').trim().split('\n')[0]);
  assert.deepEqual(first.slice(0, 4), ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu']);
  assert.equal(first[5], path.join(hostDir, 'AudioHost.cs'));

  await run(); // second start: no recompile
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);

  fs.writeFileSync(path.join(hostDir, 'AudioHost.cs'), '// source v2'); // plugin update
  const before = exes()[0];
  await run();
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2);
  assert.equal(exes().length, 1);
  assert.notEqual(exes()[0], before);
});

/** Resolves with the first truthy value of check(), re-evaluated on every host 'change'. */
function waitFor(host, check, what, ms) {
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { clearTimeout(timer); host.off('change', onChange); fn(value); };
    const onChange = () => {
      let value;
      try { value = check(); } catch (err) { finish(reject, err); return; }
      if (value) finish(resolve, value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`timed out waiting for ${what}`)), ms);
    host.on('change', onChange);
    onChange();
  });
}

test('Windows: the built-in csc.exe compiles AudioHost.cs and the helper reads the audio devices', { skip: !IS_WINDOWS && '需要 Windows 內建的 csc.exe 與 Core Audio API', timeout: 180000 }, async (t) => {
  // Spaces and non-ASCII in the path, like a plugin folder under a Chinese user name.
  const hostDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aq 測試 ')), 'host');
  fs.mkdirSync(hostDir);
  fs.copyFileSync(SOURCE, path.join(hostDir, 'AudioHost.cs'));
  delete process.env.AUDIOQUICK_HOST_CMD;
  const { AudioHost } = require('../src/host');

  const logs = [];
  const host = new AudioHost({ hostDir, log: (m) => logs.push(m) });
  t.after(() => host.stop());
  host.start();

  // Compiler errors, a crashing helper and COM failures all end up in host.error.
  const snapshot = await waitFor(host, () => {
    if (host.snapshot) return host.snapshot;
    if (host.error !== '啟動中…') throw new Error(`${host.error}\n${logs.join('\n')}`);
    return null;
  }, 'the first device snapshot', 150000);

  assert.ok(logs.some((m) => m.startsWith('host ready')), 'the helper said hello');
  const exe = fs.readdirSync(hostDir).find((f) => /^AudioHost-[0-9a-f]{10}\.exe$/.test(f));
  assert.ok(exe, 'the compiled helper sits next to the source');

  t.diagnostic(`${snapshot.devices.length} active device(s):`);
  for (const d of snapshot.devices) {
    t.diagnostic(`  ${d.flow === 'render' ? '輸出' : '輸入'}  ${d.name}${d.flow === 'capture' ? (d.muted ? '  [靜音]' : '  [啟用]') : ''}`);
    assert.ok(typeof d.id === 'string' && d.id, 'device id');
    assert.ok(typeof d.name === 'string' && d.name, 'device name');
    assert.ok(d.flow === 'render' || d.flow === 'capture', 'device flow');
    if (d.flow === 'capture') assert.equal(typeof d.muted, 'boolean', 'capture devices report mute state');
  }
  for (const role of ['render', 'renderCommunications', 'capture', 'captureCommunications']) {
    const id = snapshot.defaults[role];
    assert.ok(id === null || snapshot.devices.some((d) => d.id === id), `defaults.${role} is null or one of the listed devices`);
    const device = snapshot.devices.find((d) => d.id === id);
    t.diagnostic(`default ${role}: ${device ? device.name : '(none)'}`);
  }

  await host.send('ping');
  await host.send('refresh');

  // An ID that matches no device must come back as an error from the API without upsetting
  // the helper. Neither call can change anything on the machine.
  const unknown = '{0.0.0.00000000}.{00000000-0000-0000-0000-000000000000}';
  await assert.rejects(host.send('setMute', unknown, 1), /GetDevice failed/);
  const outcome = await host.send('setDefault', unknown, 0).then(() => 'ok', (err) => err.message);
  t.diagnostic(`setDefault(unknown id): ${outcome}`);
  // Getting this far means PolicyConfigClient was created and handed out IPolicyConfig.
  assert.ok(outcome === 'ok' || /^SetDefaultEndpoint\(console\) failed \(0x[0-9A-F]{8}\)$/.test(outcome), outcome);
  await host.send('ping'); // still alive after both
  host.stop();

  // Closing stdin on its own must end the helper: that is how it notices the plugin is gone.
  const child = spawn(path.join(hostDir, exe), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const first = await new Promise((resolve, reject) => {
    readline.createInterface({ input: child.stdout }).once('line', resolve);
    child.once('error', reject);
  });
  assert.match(first, /^\{"type":"hello"/);
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 5000))]);
  if (code === 'still running') child.kill();
  assert.equal(code, 0, 'the helper exits by itself once stdin is closed');
});
