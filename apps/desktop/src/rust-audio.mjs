import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

/** One native audio owner per app; the page only sends commands and receives telemetry. */
export class RustAudio {
  constructor(executable, emit, launch = spawn) {
    this.executable = executable;
    this.emit = emit;
    this.launch = launch;
    this.process = null;
    this.pending = new Map();
    this.sequence = 0;
    this.generation = 0;
    this.cancelStartup = null;
  }
  devices() {
    return new Promise((resolve, reject) => {
      execFile(this.executable, ['--devices'], { windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error('Не удалось получить аудиоустройства Windows'));
        try {
          const devices = JSON.parse(stdout);
          if (!Array.isArray(devices) || !devices.every(d => typeof d.deviceId === 'string' && typeof d.label === 'string')) throw new Error();
          resolve(devices);
        } catch { reject(new Error('Некорректный список аудиоустройств')); }
      });
    });
  }
  async start(device = '') {
    if (typeof device !== 'string' || device.length > 4096) throw new Error('Некорректное аудиоустройство');
    const generation = ++this.generation;
    await this.stopProcess();
    if (generation !== this.generation) throw new Error('Запуск аудиодвижка отменён');
    return new Promise((resolve, reject) => {
      const proc = this.launch(this.executable, ['--realtime', device], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.process = proc;
      let ready = false, finished = false, stderr = '';
      const timer = setTimeout(() => fail(new Error('Rust-аудиодвижок не ответил при запуске')), 10000);
      const cancelStartup = () => { finished = true; clearTimeout(timer); reject(new Error('Запуск аудиодвижка отменён')); };
      this.cancelStartup = cancelStartup;
      const fail = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (this.cancelStartup === cancelStartup) this.cancelStartup = null;
        if (stderr.trim()) { error.message += `
${stderr.trim()}`; console.error('[mora-audio stderr]', stderr.trim()); }
        if (!ready) reject(error);
        else if (this.process === proc) this.emit({ type: 'fatal', error: error.message });
        if (this.process === proc) {
          this.process = null;
          for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
          this.pending.clear();
        }
        proc.kill();
      };
      const lines = createInterface({ input: proc.stdout });
      lines.on('line', line => {
        if (finished) return;
        if (line.length > 256 * 1024) return fail(new Error('Некорректный ответ аудиодвижка'));
        let event;
        try { event = JSON.parse(line); } catch { return fail(new Error('Некорректный ответ аудиодвижка')); }
        if (event.type === 'ready' && !ready) {
          if (![44100, 48000, 88200, 96000].includes(event.sampleRate)) return fail(new Error('Некорректная частота аудиодвижка'));
          ready = true;
          clearTimeout(timer);
          if (this.cancelStartup === cancelStartup) this.cancelStartup = null;
          resolve(event);
        } else if (event.type === 'fatal') fail(new Error(event.error || 'Ошибка Rust-аудиодвижка'));
        else if (event.type === 'ack' || event.type === 'error') {
          const p = this.pending.get(event.request);
          if (p) { clearTimeout(p.timer); this.pending.delete(event.request); if (event.type === 'ack') p.resolve(); else p.reject(new Error(event.error)); }
        } else if (ready && this.process === proc) this.emit(event);
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
      proc.stdin.on('error', () => fail(new Error('Связь с аудиодвижком потеряна')));
      proc.on('error', () => fail(new Error('Не удалось запустить Rust-аудиодвижок. Пересоберите приложение.')));
      proc.on('exit', () => fail(new Error('Rust-аудиодвижок завершился')));
    });
  }
  command(command) {
    if (command?.cmd === 'feedFile') return Promise.reject(new Error('Недопустимая аудиокоманда'));
    return this.send(command);
  }
  // Only the trusted host can issue file commands; paths never come from the page.
  feedFile(command) {
    if (command?.cmd !== 'feedFile') return Promise.reject(new Error('Некорректная аудиокоманда'));
    return this.send(command);
  }
  send(command) {
    if (!this.process) return Promise.reject(new Error('Аудиодвижок не запущен'));
    if (!command || typeof command !== 'object' || typeof command.cmd !== 'string' || command.cmd === 'quit') return Promise.reject(new Error('Некорректная аудиокоманда'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Очередь аудиокоманд переполнена'));
    const value = { ...command, request: ++this.sequence };
    if (value.cmd === 'feed' || value.cmd === 'feedVocal') {
      for (const key of ['L', 'R']) {
        const pcm = value[key];
        if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length > 32768 || !pcm.every(Number.isFinite)) return Promise.reject(new Error('Некорректный PCM'));
        value[key] = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
      }
      if (command.L.length !== command.R.length) return Promise.reject(new Error('Длины каналов PCM различаются'));
    }
    const line = JSON.stringify(value);
    if (line.length > 400000) return Promise.reject(new Error('Аудиокоманда слишком велика'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(value.request); reject(new Error('Аудиодвижок не подтвердил команду')); }, 10000);
      this.pending.set(value.request, { resolve, reject, timer });
      this.process.stdin.write(line + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(value.request); reject(new Error('Связь с аудиодвижком потеряна')); }
      });
    });
  }
  async stop() {
    ++this.generation;
    await this.stopProcess();
  }
  async stopProcess() {
    const proc = this.process;
    if (!proc) return;
    this.process = null;
    this.cancelStartup?.();
    this.cancelStartup = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Аудиодвижок остановлен')); }
    this.pending.clear();
    await new Promise(resolve => {
      const timer = setTimeout(() => { proc.kill(); resolve(); }, 2000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      proc.stdin.end('{"cmd":"quit"}\n');
    });
  }
}
