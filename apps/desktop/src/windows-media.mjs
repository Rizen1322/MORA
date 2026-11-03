import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Windows state is derived from acknowledged native ticks, never renderer play intent. */
export class WindowsMedia {
  constructor(executable, { command, seek, available, artwork, state = () => {}, log = () => {} }, launch = spawn) {
    Object.assign(this, { executable, command, seek, available, artwork, state, log, launch });
    this.tracks = new Map();
    this.process = null;
    this.ready = false;
    this.sampleRate = 48000;
    this.tick = null;
    this.last = null;
    this.lastAt = 0;
    this.artworkGeneration = 0;
    this.image = '';
    this.imageToken = '';
  }
  start(sampleRate) {
    this.sampleRate = sampleRate;
    this.tick = null;
    this.last = null;
    if (this.process) { this.publish(); return; }
    const proc = this.launch(this.executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = proc;
    let finished = false;
    const fail = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const current = this.process === proc;
      if (current) { this.process = null; this.ready = false; this.available(false); }
      lines.close();
      proc.kill();
      if (current) this.log(`SMTC unavailable: ${reason}`);
    };
    const lines = createInterface({ input: proc.stdout });
    const timer = setTimeout(() => fail('startup timeout'), 5000);
    lines.on('line', line => {
      if (finished) return;
      if (line.length > 4096) return fail('invalid response');
      let event;
      try { event = JSON.parse(line); } catch { return fail('invalid response'); }
      if (event.type === 'ready' && !this.ready) {
        clearTimeout(timer); this.ready = true; this.available(true); this.publish();
      } else if (this.ready && event.type === 'command' && ['play', 'pause', 'next', 'prev'].includes(event.command)) this.command(event.command);
      else if (this.ready && event.type === 'seek' && Number.isFinite(event.position) && event.position >= 0 && event.position <= (this.last?.duration ?? 0)) this.seek(event.position);
    });
    proc.stderr.on('data', data => this.log(`SMTC: ${data.toString().slice(0, 2000).trim()}`));
    proc.stdin.on('error', () => fail('input closed'));
    proc.on('error', () => fail('cannot launch helper'));
    proc.once('exit', () => fail('helper exited'));
  }
  track(value) {
    if (!value || typeof value.token !== 'string' || !value.token || value.token.length > 200) return;
    const track = { token: value.token, title: String(value.title ?? '').slice(0, 200), artist: String(value.artist ?? '').slice(0, 200),
      album: String(value.album ?? '').slice(0, 200), coverUrl: typeof value.coverUrl === 'string' ? value.coverUrl.slice(0, 2048) : '' };
    this.tracks.set(track.token, track);
    if (this.tracks.size > 16) this.tracks.delete(this.tracks.keys().next().value);
    this.publish();
  }
  audioEvent(event) {
    if (event.type === 'tick') { this.tick = event; this.publish(); }
    else if (['fatal', 'stopped'].includes(event.type)) this.reset();
  }
  reset() { this.tick = null; this.tracks.clear(); this.publish(); }
  publish() {
    const deck = this.tick?.decks?.[this.tick.main];
    const track = deck && this.tracks.get(deck.token);
    const currentToken = track?.token ?? '';
    if (currentToken !== this.imageToken) {
      this.imageToken = currentToken; this.image = '';
      const generation = ++this.artworkGeneration;
      if (track?.coverUrl) Promise.resolve(this.artwork(track.coverUrl)).then(image => {
        if (generation === this.artworkGeneration) { this.image = image || ''; this.publish(); }
      }).catch(() => {});
    }
    const duration = Number.isFinite(deck?.totalFrames) ? deck.totalFrames / this.sampleRate : 0;
    const state = { title: track?.title ?? '', artist: track?.artist ?? '', album: track?.album ?? '', artwork: this.image,
      status: !track ? 'stopped' : this.tick.paused ? 'paused' : !deck.playing ? 'stopped' : deck.starved ? 'buffering' : 'playing',
      position: Number.isFinite(deck?.position) ? Math.max(0, Math.min(duration, deck.position / this.sampleRate)) : 0,
      duration: Math.max(0, duration), rate: Number.isFinite(deck?.ratio) ? deck.ratio : 1 };
    this.state(state);
    const now = Date.now();
    const significant = !this.last || ['title', 'artist', 'album', 'artwork', 'status', 'duration', 'rate'].some(key => this.last[key] !== state[key])
      || Math.abs(state.position - this.last.position - (this.last.status === 'playing' ? (now - this.lastAt) / 1000 * this.last.rate : 0)) > 1;
    if (!this.ready || (!significant && now - this.lastAt < 5000)) return;
    this.last = state; this.lastAt = now;
    this.process?.stdin.write(JSON.stringify(state) + '\n');
  }
  async stop() {
    this.reset();
    ++this.artworkGeneration;
    const proc = this.process;
    if (!proc) return;
    this.process = null; this.ready = false; this.available(false);
    await new Promise(resolve => {
      const timer = setTimeout(() => { proc.kill(); resolve(); }, 1500);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      proc.stdin.end();
    });
  }
}
