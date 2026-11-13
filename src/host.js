'use strict';
// Starts and talks to the Windows audio helper (host/AudioHost.cs).
// The helper is compiled on first run with the C# compiler that ships with Windows.

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

class AudioHost extends EventEmitter {
  constructor({ hostDir, log }) {
    super();
    this.hostDir = hostDir;
    this.log = log;
    this.snapshot = null; // last good device snapshot, or null
    this.error = '啟動中…'; // human-readable reason the snapshot is missing, or null
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.restartDelay = 1000;
    this.restartTimer = null;
    this.stopped = false;
  }

  start() {
    this._launch().catch((err) => this._fail(err));
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      try { this.child.stdin.end(); } catch (_) { /* ignore */ }
      try { this.child.kill(); } catch (_) { /* ignore */ }
    }
  }

  /** Sends a command; resolves when the helper confirms, rejects on failure or timeout. */
  send(command, ...args) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        reject(new Error(this.error || '音訊服務未就緒'));
        return;
      }
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${command} 逾時`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      const clean = args.map((a) => String(a).replace(/[\t\r\n]/g, ' '));
      this.child.stdin.write([id, command, ...clean].join('\t') + '\n', 'utf8');
    });
  }

  async _launch() {
    const [command, args] = await this._resolveCommand();
    if (this.stopped) return;
    this.log(`starting host: ${command} ${args.join(' ')}`);

    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const startedAt = Date.now();

    child.on('error', (err) => {
      if (this.child !== child) return;
      this.child = null;
      this._fail(err);
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('音訊服務已中斷'));
      }
      this.pending.clear();
      // A helper that stayed up for a while earns a quick restart.
      if (Date.now() - startedAt > 30000) this.restartDelay = 1000;
      this._fail(new Error(`音訊服務已結束 (code=${code}, signal=${signal})`));
    });
    child.stdin.on('error', () => { /* the exit handler deals with it */ });
    child.stderr.on('data', (chunk) => this.log(`host stderr: ${String(chunk).trim()}`));

    readline.createInterface({ input: child.stdout }).on('line', (line) => this._onLine(line));
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      this.log(`host sent unreadable line: ${line}`);
      return;
    }
    if (message.type === 'state') {
      this.snapshot = { devices: message.devices || [], defaults: message.defaults || {} };
      this.error = null;
      this.emit('change');
    } else if (message.type === 'result') {
      const entry = this.pending.get(String(message.id));
      if (!entry) return;
      this.pending.delete(String(message.id));
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve();
      else entry.reject(new Error(message.error || '未知錯誤'));
    } else if (message.type === 'error') {
      this.log(`host error: ${message.message}`);
      this.snapshot = null;
      this.error = `無法讀取音訊裝置：${message.message}`;
      this.emit('change');
    } else if (message.type === 'hello') {
      this.log(`host ready (version ${message.version})`);
    }
  }

  _fail(err) {
    this.log(`host failure: ${err && err.message}`);
    this.snapshot = null;
    this.error = (err && err.message) || '音訊服務無法啟動';
    this.emit('change');
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.child) this._launch().catch((e) => this._fail(e));
    }, delay);
  }

  /** Returns [command, args] for the helper, compiling it first when needed. */
  async _resolveCommand() {
    // Test hook: run something else in place of the Windows helper.
    if (process.env.AUDIOQUICK_HOST_CMD) {
      const [command, ...args] = JSON.parse(process.env.AUDIOQUICK_HOST_CMD);
      return [command, args];
    }
    if (process.platform !== 'win32') throw new Error('此插件僅支援 Windows');

    const source = path.join(this.hostDir, 'AudioHost.cs');
    const hash = crypto.createHash('sha1').update(fs.readFileSync(source)).digest('hex').slice(0, 10);
    const exe = path.join(this.hostDir, `AudioHost-${hash}.exe`);
    if (fs.existsSync(exe)) return [exe, []];

    // Remove helpers built from older versions of the source.
    for (const file of fs.readdirSync(this.hostDir)) {
      if (/^AudioHost-[0-9a-f]+\.exe$/i.test(file)) {
        try { fs.unlinkSync(path.join(this.hostDir, file)); } catch (_) { /* still in use; leave it */ }
      }
    }

    const csc = findCompiler();
    if (!csc) throw new Error('找不到 Windows 內建的 C# 編譯器 (csc.exe)，無法建立音訊服務');
    this.log(`compiling host with ${csc}`);
    await new Promise((resolve, reject) => {
      execFile(
        csc,
        ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${exe}`, source],
        { windowsHide: true, timeout: 120000 },
        (err, stdout, stderr) => {
          if (stdout && String(stdout).trim()) this.log(`csc: ${String(stdout).trim()}`);
          if (stderr && String(stderr).trim()) this.log(`csc stderr: ${String(stderr).trim()}`);
          if (err) reject(new Error(`音訊服務編譯失敗：${err.message}`));
          else resolve();
        },
      );
    });
    if (!fs.existsSync(exe)) throw new Error('音訊服務編譯後找不到執行檔');
    return [exe, []];
  }
}

function findCompiler() {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

module.exports = { AudioHost };
