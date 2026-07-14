// Tiny procedural SFX — no audio assets, everything synthesized.
// Placeholder-quality on purpose; real sound design comes with the art pass.
class Sfx {
  private ctx: AudioContext | null = null;
  muted = localStorage.getItem('discipline-muted') === '1';

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem('discipline-muted', this.muted ? '1' : '0');
    return this.muted;
  }

  private ac(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
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
  green() { this.blip(523, 0.1, 'square', 0.06); this.blip(659, 0.1, 'square', 0.06); this.blip(784, 0.2, 'square', 0.06); }
}

export const sfx = new Sfx();

// ---------------------------------------------------------------------------
// Music director. Each red light maps to one of ten songs, wrapping after
// track 10. Battle progress moves through the supplied 77/111/144 BPM renders.
// The garage deliberately uses a random 77 BPM render instead.
// ---------------------------------------------------------------------------

const MUSIC_TRACKS = [
  'Phonky_Frog', 'bing_bing_bong', 'Big_Boy', 'Aww_yeayuh', 'Mean_Muggin',
  'Jorkins', 'Galactic_Coomb', 'TDrift_Splurgin', 'Aura', 'Discipline_god',
] as const;
const MUSIC_BPMS = [77, 111, 144] as const;
type MusicBpm = typeof MUSIC_BPMS[number];

class MusicDirector {
  private audio: HTMLAudioElement | null = null;
  private engaged = false;
  private muted = sfx.muted;
  private ducked = false;
  private inGarage = false;
  private adPauseDepth = 0;
  private opponentIndex = 0;
  private progress = 0;
  private trackIndex = -1;
  private bpm: MusicBpm = 77;
  private switchId = 0;
  private readonly baseVolume = 0.55;

  engage(opponentIndex: number, progress: number) {
    this.engaged = true;
    this.opponentIndex = opponentIndex;
    this.progress = progress;
    this.startBattle(true);
  }

  updateBattle(opponentIndex: number, progress: number) {
    this.opponentIndex = opponentIndex;
    this.progress = progress;
    if (!this.engaged || this.inGarage) return;
    const nextTrack = this.battleTrack(opponentIndex);
    const nextBpm = this.bpmForProgress(progress);
    if (nextTrack !== this.trackIndex) this.startBattle(true);
    else if (nextBpm !== this.bpm) this.switchTo(nextTrack, nextBpm, false);
  }

  setGarage(open: boolean) {
    if (this.inGarage === open) return;
    this.inGarage = open;
    if (!this.engaged) return;
    if (open) this.switchTo(Math.floor(Math.random() * MUSIC_TRACKS.length), 77, true);
    else this.startBattle(true); // resume gameplay from the song's beginning
  }

  setMenuOpen(open: boolean) { this.ducked = open; this.applyVolume(); }
  pauseForAd() { this.adPauseDepth += 1; this.audio?.pause(); }
  resumeAfterAd() {
    this.adPauseDepth = Math.max(0, this.adPauseDepth - 1);
    if (this.adPauseDepth === 0) this.play();
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyVolume();
    if (!muted) this.play();
  }

  private startBattle(fromBeginning: boolean) {
    this.switchTo(this.battleTrack(this.opponentIndex), this.bpmForProgress(this.progress), fromBeginning);
  }
  private battleTrack(index: number) {
    return ((index % MUSIC_TRACKS.length) + MUSIC_TRACKS.length) % MUSIC_TRACKS.length;
  }
  private bpmForProgress(progress: number): MusicBpm {
    if (progress >= 2 / 3) return 144;
    if (progress >= 1 / 3) return 111;
    return 77;
  }
  private url(trackIndex: number, bpm: MusicBpm) {
    const folder = String(trackIndex + 1).padStart(2, '0');
    return `/music/track-${folder}/${MUSIC_TRACKS[trackIndex]}__${bpm}bpm.mp3`;
  }
  private switchTo(trackIndex: number, bpm: MusicBpm, fromBeginning: boolean) {
    const previous = this.audio;
    const previousBpm = this.bpm;
    const previousTime = previous?.currentTime ?? 0;
    const id = ++this.switchId;
    const next = new Audio(this.url(trackIndex, bpm));
    next.loop = true;
    next.preload = 'auto';
    next.volume = this.targetVolume();
    const begin = () => {
      if (id !== this.switchId) return;
      if (!fromBeginning && Number.isFinite(next.duration) && next.duration > 0) {
        next.currentTime = (previousTime * previousBpm / bpm) % next.duration;
      }
      previous?.pause();
      this.audio = next;
      this.trackIndex = trackIndex;
      this.bpm = bpm;
      this.play();
    };
    if (next.readyState >= HTMLMediaElement.HAVE_METADATA) begin();
    else next.addEventListener('loadedmetadata', begin, { once: true });
    next.load();
  }
  private targetVolume() { return this.muted ? 0 : this.baseVolume * (this.ducked ? 0.5 : 1); }
  private applyVolume() { if (this.audio) this.audio.volume = this.targetVolume(); }
  private play() {
    if (!this.engaged || this.adPauseDepth > 0 || !this.audio) return;
    void this.audio.play().catch(() => { /* waits for the next user gesture */ });
  }
}

export const music = new MusicDirector();