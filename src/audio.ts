// Tiny procedural SFX — no audio assets, everything synthesized.
// Placeholder-quality on purpose; real sound design comes with the art pass.
class Sfx {
  private ctx: AudioContext | null = null;
  private yelpBuffer: Promise<AudioBuffer> | null = null;
  private yelpDecoded: AudioBuffer | null = null;
  // Start the request while the title screen is up. Decoding happens on the
  // first user gesture, so a defeat never waits on network or decoding work.
  private readonly yelpBytes = fetch('/sfx/opponent-yelp.wav?v=instant')
    .then(response => {
      if (!response.ok) throw new Error('Could not load opponent yelp');
      return response.arrayBuffer();
    });
  muted = localStorage.getItem('discipline-muted') === '1';

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('discipline-muted', this.muted ? '1' : '0');
    music.setMuted(this.muted);
    return this.muted;
  }

  private ac(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  preloadYelp() {
    try {
      const ctx = this.ac();
      this.yelpBuffer ??= this.yelpBytes
        .then(data => ctx.decodeAudioData(data))
        .then(decoded => { this.yelpDecoded = decoded; return decoded; });
      void this.yelpBuffer.catch(() => { /* missing asset must not break gameplay */ });
    } catch { /* audio is unavailable until a user gesture */ }
  }

  private blip(freq: number, dur: number, type: OscillatorType = 'square', vol = 0.08, slide = 0) {
    if (this.muted) return;
    try {
      const ctx = this.ac();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), ctx.currentTime + dur);
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + dur);
    } catch { /* audio blocked until user gesture — fine */ }
  }

  private noise(dur: number, vol = 0.15) {
    if (this.muted) return;
    try {
      const ctx = this.ac();
      const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = vol;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900;
      src.connect(f).connect(g).connect(ctx.destination);
      src.start();
    } catch { /* ignore */ }
  }

  tap()   { this.blip(90 + Math.random() * 30, 0.06, 'triangle', 0.1, -40); }
  click() { this.blip(600, 0.04, 'square', 0.05); }
  buy()   { this.blip(440, 0.08, 'square', 0.06); this.blip(660, 0.1, 'square', 0.05); }
  boost() { this.blip(330, 0.12, 'sawtooth', 0.07, 300); this.blip(495, 0.2, 'sawtooth', 0.05, 400); }
  milestone() { this.blip(220, 0.15, 'sawtooth', 0.08, 60); }
  goop()  { this.noise(0.6, 0.25); this.blip(70, 0.5, 'sine', 0.15, -30); }
  /** equipped horn cosmetic plays when an opponent is finished */
  horn(kind?: string) {
    if (kind === 'violin') {        // sad descending strings
      [660, 587, 523, 440].forEach((f, i) =>
        setTimeout(() => this.blip(f, 0.35, 'triangle', 0.07, -20), i * 260));
    } else if (kind === 'airhorn') { // freight blast, three pumps
      [0, 220, 440].forEach((d) =>
        setTimeout(() => { this.blip(233, 0.28, 'sawtooth', 0.11, 8); this.blip(466, 0.28, 'sawtooth', 0.07, 8); }, d));
    }
  }
  /** Opponent defeat yelp: starts synchronously when the decoded buffer is ready. */
  yelp() {
    if (this.muted) return;
    try {
      const ctx = this.ac();
      const play = (buffer: AudioBuffer) => {
        if (this.muted) return;
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        const semitones = -6 + Math.random() * 12;
        src.buffer = buffer;
        src.playbackRate.value = Math.pow(2, semitones / 12);
        gain.gain.value = 0.68;
        src.connect(gain).connect(ctx.destination);
        src.start(ctx.currentTime);
      };
      // Normal path: no Promise/microtask between defeat and source.start().
      if (this.yelpDecoded) { play(this.yelpDecoded); return; }
      // Safety net for an unusually fast first defeat while the title preload
      // is still finishing. All later defeats use the synchronous path above.
      this.preloadYelp();
      void this.yelpBuffer?.then(play).catch(() => { /* asset unavailable */ });
    } catch { /* audio is unavailable until a user gesture */ }
  }  green() { this.blip(523, 0.1, 'square', 0.06); this.blip(659, 0.1, 'square', 0.06); this.blip(784, 0.2, 'square', 0.06); }
}

export const sfx = new Sfx();

// ---------------------------------------------------------------------------
// Web Audio music director. BufferSource looping is sample-accurate, so MP3
// encoder padding cannot add a silence between repetitions.
// ---------------------------------------------------------------------------

const MUSIC_TRACKS = [
  'Phonky_Frog', 'bing_bing_bong', 'Big_Boy', 'Aww_yeayuh', 'Mean_Muggin',
  'Jorkins', 'Galactic_Coomb', 'TDrift_Splurgin', 'Aura', 'Discipline_god',
] as const;
const MUSIC_BPMS = [77, 111, 144] as const;
type MusicBpm = typeof MUSIC_BPMS[number];
type PlayingTrack = { source: AudioBufferSourceNode; gain: GainNode; buffer: AudioBuffer; startedAt: number; offset: number; bpm: MusicBpm; };

class MusicDirector {
  private ctx: AudioContext | null = null;
  private yelpBuffer: Promise<AudioBuffer> | null = null;
  private yelpDecoded: AudioBuffer | null = null;
  private master: GainNode | null = null;
  private active: PlayingTrack | null = null;
  private cache = new Map<string, Promise<AudioBuffer>>();
  private request = 0;
  private engaged = false;
  private muted = sfx.muted;
  private ducked = false;
  private inGarage = false;
  private adPauseDepth = 0;
  private opponentIndex = 0;
  private progress = 0;
  private targetTrack = -1;
  private targetBpm: MusicBpm = 77;
  private readonly baseVolume = 0.55;

  engage(opponentIndex: number, progress: number) {
    this.engaged = true;
    this.opponentIndex = opponentIndex;
    this.progress = progress;
    const ctx = this.audioContext();
    void ctx.resume();
    this.warmBattle(opponentIndex);
    this.start(this.battleTrack(opponentIndex), this.bpmForProgress(progress), true);
  }

  /** Called while stopped at a red light; main.ts suppresses it while driving. */
  updateBattle(opponentIndex: number, progress: number) {
    this.opponentIndex = opponentIndex;
    this.progress = progress;
    if (!this.engaged || this.inGarage) return;
    const track = this.battleTrack(opponentIndex);
    const bpm = this.bpmForProgress(progress);
    if (track !== this.targetTrack || bpm !== this.targetBpm) this.start(track, bpm, false);
  }

  /** Silence battle music during the defeated/drive transition. */
  stopForDefeat() {
    this.request += 1;
    this.targetTrack = -1;
    const active = this.active;
    this.active = null;
    if (!active || !this.ctx) return;
    const now = this.ctx.currentTime;
    active.gain.gain.cancelScheduledValues(now);
    active.gain.gain.setValueAtTime(active.gain.gain.value, now);
    active.gain.gain.linearRampToValueAtTime(0, now + 0.08);
    active.source.stop(now + 0.1);
  }
  setGarage(open: boolean) {
    if (this.inGarage === open) return;
    this.inGarage = open;
    if (!this.engaged) return;
    if (open) this.start(Math.floor(Math.random() * MUSIC_TRACKS.length), 77, true);
    else this.start(this.battleTrack(this.opponentIndex), this.bpmForProgress(this.progress), true);
  }

  setMenuOpen(open: boolean) { this.ducked = open; this.applyVolume(); }
  pauseForAd() { this.adPauseDepth += 1; if (this.ctx?.state === 'running') void this.ctx.suspend(); }
  resumeAfterAd() { this.adPauseDepth = Math.max(0, this.adPauseDepth - 1); if (this.adPauseDepth === 0 && this.engaged) void this.audioContext().resume(); }
  setMuted(muted: boolean) { this.muted = muted; this.applyVolume(); }

  private audioContext() {
    if (this.ctx && this.master) return this.ctx;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.applyVolume();
    return this.ctx;
  }

  private url(track: number, bpm: MusicBpm) {
    return `/music/track-${String(track + 1).padStart(2, '0')}/${MUSIC_TRACKS[track]}__${bpm}bpm.mp3`;
  }

  private load(track: number, bpm: MusicBpm) {
    const url = this.url(track, bpm);
    let pending = this.cache.get(url);
    if (!pending) {
      pending = fetch(url)
        .then(response => { if (!response.ok) throw new Error(`Music failed to load: ${url}`); return response.arrayBuffer(); })
        .then(data => this.audioContext().decodeAudioData(data));
      this.cache.set(url, pending);
    }
    return pending;
  }

  private warm(track: number) { MUSIC_BPMS.forEach(bpm => void this.load(track, bpm)); }
  private warmBattle(index: number) { this.warm(this.battleTrack(index)); this.warm(this.battleTrack(index + 1)); }

  private start(track: number, bpm: MusicBpm, restart: boolean) {
    this.targetTrack = track;
    this.targetBpm = bpm;
    const request = ++this.request;
    void this.load(track, bpm).then(buffer => {
      if (request !== this.request || !this.engaged) return;
      this.begin(buffer, bpm, restart);
    }).catch(() => { /* music failure never stops the game */ });
  }

  private begin(buffer: AudioBuffer, bpm: MusicBpm, restart: boolean) {
    const ctx = this.audioContext();
    const previous = this.active;
    let offset = 0;
    if (!restart && previous) {
      const oldPosition = (previous.offset + ctx.currentTime - previous.startedAt) % previous.buffer.duration;
      offset = (oldPosition * previous.bpm / bpm) % buffer.duration;
    }
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = buffer.duration;
    source.connect(gain).connect(this.master!);
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    source.start(now, offset);
    gain.gain.linearRampToValueAtTime(1, now + 0.06);
    this.active = { source, gain, buffer, startedAt: now, offset, bpm };
    if (previous) {
      previous.gain.gain.cancelScheduledValues(now);
      previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
      previous.gain.gain.linearRampToValueAtTime(0, now + 0.06);
      previous.source.stop(now + 0.08);
    }
    this.warmBattle(this.opponentIndex);
    if (this.adPauseDepth === 0) void ctx.resume();
  }

  private bpmForProgress(progress: number): MusicBpm {
    if (progress >= 0.75) return 144;
    if (progress >= 0.25) return 111;
    return 77;
  }
  private battleTrack(index: number) { return ((index % MUSIC_TRACKS.length) + MUSIC_TRACKS.length) % MUSIC_TRACKS.length; }
  private applyVolume() {
    if (!this.ctx || !this.master) return;
    const volume = this.muted ? 0 : this.baseVolume * (this.ducked ? 0.5 : 1);
    this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }
}

export const music = new MusicDirector();