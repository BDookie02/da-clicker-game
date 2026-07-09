// Tiny procedural SFX — no audio assets, everything synthesized.
// Placeholder-quality on purpose; real sound design comes with the art pass.
class Sfx {
  private ctx: AudioContext | null = null;

  private ac(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private blip(freq: number, dur: number, type: OscillatorType = 'square', vol = 0.08, slide = 0) {
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
  green() { this.blip(523, 0.1, 'square', 0.06); this.blip(659, 0.1, 'square', 0.06); this.blip(784, 0.2, 'square', 0.06); }
}

export const sfx = new Sfx();
