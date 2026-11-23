/**
 * Relaxing background sounds generated with Web Audio (no audio files: works
 * offline, no licensing). Rain = filtered noise with gentle, random swells.
 */
export type SoundKind = "off" | "rain" | "brown" | "white";

export class SoundScape {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nodes: AudioNode[] = [];
  private timers: number[] = [];
  private kind: SoundKind = "off";
  private volume = 0.4;

  get current(): SoundKind {
    return this.kind;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(this.volume * 0.5, this.ctx.currentTime, 0.1);
  }

  /** Must be called from a user gesture the first time (browser rule). */
  play(kind: SoundKind): void {
    this.stopNodes();
    this.kind = kind;
    if (kind === "off") return;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx ??= new AC();
    void this.ctx.resume();
    const ctx = this.ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(ctx.destination);
    this.gain.gain.setTargetAtTime(this.volume * 0.5, ctx.currentTime, 0.6); // fade in
    if (kind === "white") this.loop(this.noise("white"), [this.filter("lowpass", 9000)]);
    if (kind === "brown") this.loop(this.noise("brown"), []);
    if (kind === "rain") this.rain();
  }

  private noise(color: "white" | "brown" | "pink"): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (color === "white") d[i] = w * 0.35;
        else if (color === "brown") {
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.2;
        } else {
          b0 = 0.997 * b0 + w * 0.029591;
          b1 = 0.985 * b1 + w * 0.032534;
          b2 = 0.95 * b2 + w * 0.048056;
          d[i] = (b0 + b1 + b2 + w * 0.05) * 0.9;
        }
      }
      // Cross-fade the loop seam.
      const fade = 2000;
      for (let i = 0; i < fade; i++) d[len - fade + i] = d[len - fade + i] * (1 - i / fade) + d[i] * (i / fade);
    }
    return buf;
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private loop(buf: AudioBuffer, chain: AudioNode[], out: AudioNode = this.gain!): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    let node: AudioNode = src;
    for (const n of chain) {
      node.connect(n);
      node = n;
    }
    node.connect(out);
    src.start();
    this.nodes.push(src, ...chain);
    return src;
  }

  private rain(): void {
    const ctx = this.ctx!;
    // Steady hiss of rain.
    this.loop(this.noise("pink"), [this.filter("highpass", 500), this.filter("lowpass", 5500)]);
    // Gentle swells, like gusts.
    const swell = ctx.createGain();
    swell.gain.value = 0.5;
    swell.connect(this.gain!);
    this.loop(this.noise("white"), [this.filter("bandpass", 2200, 0.6)], swell);
    this.nodes.push(swell);
    const gust = () => {
      const t = ctx.currentTime;
      swell.gain.setTargetAtTime(0.25 + Math.random() * 0.5, t, 1.5 + Math.random() * 2);
      this.timers.push(window.setTimeout(gust, 2500 + Math.random() * 4000));
    };
    gust();
  }

  private stopNodes(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const n of this.nodes) {
      try {
        (n as AudioBufferSourceNode).stop?.();
      } catch {
        /* already stopped */
      }
      n.disconnect();
    }
    this.nodes = [];
    this.gain?.disconnect();
    this.gain = null;
  }

  /** Short soft chime for timer suggestions. */
  chime(): void {
    const AC = window.AudioContext;
    if (!AC) return;
    this.ctx ??= new AC();
    const ctx = this.ctx;
    void ctx.resume();
    const t = ctx.currentTime;
    for (const [i, f] of [660, 880].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.18);
      g.gain.linearRampToValueAtTime(0.18, t + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 1.2);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.18);
      o.stop(t + i * 0.18 + 1.3);
    }
  }
}
