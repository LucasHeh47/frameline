// Listening to sound for editing: the pauses in speech (for jump cuts), the beat of music (for
// markers to cut on), and how loud a mix is as streaming sites measure it (LUFS).

/** Merged, sorted [start, end) ranges. */
function merge(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const r of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

// ---------- pauses ----------

/**
 * The quiet stretches in a level per frame (0–1): at least `minLength` frames under `threshold`.
 * `pad` frames of each are kept next to the sound around them, so words aren't clipped; quiet at the
 * very start and end is removed up to the sound.
 */
export function silentRanges(levels: ArrayLike<number>, threshold: number, minLength: number, pad: number): [number, number][] {
  const n = levels.length;
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && levels[i] < threshold;
    if (quiet && start < 0) start = i;
    else if (!quiet && start >= 0) {
      const a = start === 0 ? 0 : start + pad;
      const b = i === n ? n : i - pad;
      if (i - start >= minLength && b > a) out.push([a, b]);
      start = -1;
    }
  }
  return out;
}

/** The parts of [a, b) left after taking out the ranges. */
export function keptParts(a: number, b: number, ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let at = a;
  for (const [ra, rb] of merge(ranges)) {
    if (rb <= at || ra >= b) continue;
    if (ra > at) out.push([at, ra]);
    at = Math.max(at, rb);
  }
  if (at < b) out.push([at, b]);
  return out;
}

// ---------- beats ----------

export interface BeatResult {
  /** Beats per minute. */
  bpm: number;
  /** Seconds (relative to the start of the levels) of each beat. */
  beats: number[];
}

/**
 * Finds the beat of music from its loudness envelope (`rate` values per second, 0–1): where the sound
 * jumps up (drums, notes starting), the tempo that best repeats those jumps, and where the beats fall.
 */
export function detectBeats(env: ArrayLike<number>, rate: number, minBpm = 70, maxBpm = 180): BeatResult | null {
  const n = env.length;
  if (n < rate * 4) return null;
  // How sharply the sound rises at each moment (compressed, so quiet parts count too)
  const onset = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.log1p(100 * env[i]);
    onset[i] = Math.max(0, v - prev);
    prev = v;
  }
  // Take away the local average so steady loud passages don't count as beats
  const w = Math.max(1, Math.round(rate * 0.1));
  const flux = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
      sum += onset[j];
      cnt++;
    }
    flux[i] = Math.max(0, onset[i] - sum / cnt);
  }
  // Tempo: the spacing at which the rises repeat most, leaning towards common tempos around 120
  const lagMin = Math.floor((60 * rate) / maxBpm);
  const lagMax = Math.ceil((60 * rate) / minBpm);
  let bestLag = 0;
  let bestScore = 0;
  const scoreAt = (lag: number) => {
    // Fractional lags: interpolate between neighbors
    const l0 = Math.floor(lag);
    const fr = lag - l0;
    let s = 0;
    for (let i = 0; i + l0 + 1 < n; i++) s += flux[i] * (flux[i + l0] * (1 - fr) + flux[i + l0 + 1] * fr);
    return s / (n - l0);
  };
  for (let lag = lagMin; lag <= lagMax; lag += 0.25) {
    const bpm = (60 * rate) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    // Multiples of the beat repeat too: a real tempo is backed up at 2× its spacing
    const s = (scoreAt(lag) + 0.5 * scoreAt(lag * 2)) * prior;
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  if (!bestLag || bestScore <= 0) return null;
  // Where the beats fall: the offset whose evenly spaced points land on the most rises
  let bestPhase = 0;
  let bestSum = -1;
  for (let ph = 0; ph < bestLag; ph += 0.5) {
    let s = 0;
    for (let t = ph; t < n; t += bestLag) s += flux[Math.round(t)] ?? 0;
    if (s > bestSum) {
      bestSum = s;
      bestPhase = ph;
    }
  }
  // Each beat moves a little to the rise nearest to it (live music drifts)
  const beats: number[] = [];
  const reach = Math.max(1, Math.round(bestLag * 0.12));
  for (let t = bestPhase; t < n; t += bestLag) {
    const c = Math.round(t);
    let at = c;
    for (let j = Math.max(0, c - reach); j <= Math.min(n - 1, c + reach); j++) if (flux[j] > flux[at] * 1.5) at = j;
    beats.push(at / rate);
  }
  return { bpm: Math.round(((60 * rate) / bestLag) * 10) / 10, beats };
}

// ---------- loudness ----------

/** Filter coefficients for one biquad section. */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The K-weighting of ITU-R BS.1770 (a high shelf, then a high-pass) for a sample rate. */
function kWeighting(sr: number): [Biquad, Biquad] {
  // Stage 1: high shelf, +4 dB above about 1.7 kHz (how the head changes what we hear)
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: high-pass at about 38 Hz
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / sr);
  a0 = 1 + K / Q + K * K;
  const hp: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

/**
 * Measures integrated loudness (LUFS) and the peak, fed a channel's samples bit by bit. Follows
 * BS.1770 / EBU R128: K-weighting, 400 ms blocks overlapping by 75%, and the two gates.
 */
export class LoudnessMeter {
  private filters: [Biquad, Biquad];
  /** Filter state per channel: [x1, x2, y1, y2] per stage. */
  private state: Float64Array[];
  private hop: number;
  /** Mean squares of the current hop (per channel), and of the finished hops. */
  private acc: number[];
  private inHop = 0;
  private hops: number[] = [];
  private blocks: number[] = [];
  peak = 0;

  constructor(
    sr: number,
    private channels: number,
  ) {
    this.filters = kWeighting(sr);
    this.state = Array.from({ length: channels }, () => new Float64Array(8));
    this.hop = Math.round(sr * 0.1);
    this.acc = new Array(channels).fill(0);
  }

  /** Adds samples: one array per channel, all the same length. */
  add(data: Float32Array[]): void {
    const len = data[0]?.length ?? 0;
    const [f1, f2] = this.filters;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < this.channels; c++) {
        const x = data[Math.min(c, data.length - 1)][i];
        const ax = x < 0 ? -x : x;
        if (ax > this.peak) this.peak = ax;
        const st = this.state[c];
        // Stage 1
        const y1 = f1.b0 * x + f1.b1 * st[0] + f1.b2 * st[1] - f1.a1 * st[2] - f1.a2 * st[3];
        st[1] = st[0];
        st[0] = x;
        st[3] = st[2];
        st[2] = y1;
        // Stage 2
        const y2 = f2.b0 * y1 + f2.b1 * st[4] + f2.b2 * st[5] - f2.a1 * st[6] - f2.a2 * st[7];
        st[5] = st[4];
        st[4] = y1;
        st[7] = st[6];
        st[6] = y2;
        this.acc[c] += y2 * y2;
      }
      if (++this.inHop === this.hop) {
        // A hop's power, summed over channels (left and right count the same)
        let p = 0;
        for (let c = 0; c < this.channels; c++) {
          p += this.acc[c] / this.hop;
          this.acc[c] = 0;
        }
        this.inHop = 0;
        this.hops.push(p);
        // Four hops make a 400 ms block
        if (this.hops.length >= 4) {
          const k = this.hops.length;
          this.blocks.push((this.hops[k - 1] + this.hops[k - 2] + this.hops[k - 3] + this.hops[k - 4]) / 4);
        }
      }
    }
  }

  /** Integrated loudness in LUFS (-Infinity for silence). */
  get lufs(): number {
    const loud = (p: number) => -0.691 + 10 * Math.log10(p);
    // Absolute gate at -70 LUFS, then a relative gate 10 LU under the average of what's left
    const abs = this.blocks.filter((p) => p > 0 && loud(p) > -70);
    if (!abs.length) return -Infinity;
    const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
    const rel = abs.filter((p) => loud(p) > loud(mean) - 10);
    if (!rel.length) return -Infinity;
    return loud(rel.reduce((a, b) => a + b, 0) / rel.length);
  }
}

/** The gain (dB) to bring a mix to a loudness (never more than `maxBoost`, so near-silence isn't blown up). */
export function normalizeGain(lufs: number, target: number, maxBoost = 20): number {
  if (!Number.isFinite(lufs)) return 0;
  return Math.min(maxBoost, target - lufs);
}

/**
 * A look-ahead peak limiter: keeps every sample under `ceiling` (linear) while changing the level
 * smoothly. Its output is `delay` samples late; feed it the whole sound in order, drop the first
 * `delay` output samples and call flush() at the end for the last ones.
 */
export class PeakLimiter {
  readonly delay: number;
  /** The last delay + 1 input samples per channel (the one going out is the oldest). */
  private ring: Float32Array[];
  /** Sliding minimum of the gains needed over the look-ahead: a queue of (sample, gain), gains rising. */
  private qIndex: Float64Array;
  private qGain: Float32Array;
  private qHead = 0;
  private qTail = 0;
  /** The last delay + 1 look-ahead minimums, for their average. */
  private mins: Float32Array;
  private minSum: number;
  private pos = 0;
  private gain = 1;
  private release: number;

  constructor(
    sr: number,
    private channels: number,
    private ceiling: number,
    lookAheadMs = 5,
    releaseMs = 80,
  ) {
    this.delay = Math.max(1, Math.round((sr * lookAheadMs) / 1000));
    const n = this.delay + 1;
    this.ring = Array.from({ length: channels }, () => new Float32Array(n));
    this.qIndex = new Float64Array(n + 1);
    this.qGain = new Float32Array(n + 1);
    this.mins = new Float32Array(n).fill(1);
    this.minSum = n;
    this.release = 1 - Math.exp(-1 / ((sr * releaseMs) / 1000));
  }

  /** Limits a block (one array per channel); returns the same number of samples, `delay` late. */
  process(data: Float32Array[]): Float32Array[] {
    const len = data[0]?.length ?? 0;
    const out = Array.from({ length: this.channels }, () => new Float32Array(len));
    const n = this.delay + 1;
    const cap = n + 1;
    for (let i = 0; i < len; i++) {
      const pos = this.pos;
      let peak = 0;
      for (let c = 0; c < this.channels; c++) {
        const x = data[Math.min(c, data.length - 1)][i];
        this.ring[c][pos % n] = x;
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
      }
      // The gain this sample needs joins the queue; gains it makes irrelevant leave
      const need = peak > this.ceiling ? this.ceiling / peak : 1;
      while (this.qTail !== this.qHead && this.qGain[(this.qTail - 1 + cap) % cap] >= need) this.qTail = (this.qTail - 1 + cap) % cap;
      this.qIndex[this.qTail] = pos;
      this.qGain[this.qTail] = need;
      this.qTail = (this.qTail + 1) % cap;
      // Only samples from the one going out (pos - delay) onwards count
      while (this.qIndex[this.qHead] < pos - this.delay) this.qHead = (this.qHead + 1) % cap;
      const m = this.qGain[this.qHead];
      // The minimums averaged over the look-ahead: each peak's gain is reached, gradually, by the time
      // the peak goes out
      const slot = pos % n;
      this.minSum += m - this.mins[slot];
      this.mins[slot] = m;
      const target = Math.min(1, this.minSum / n);
      // Down at once (already smooth), back up slowly
      this.gain = target < this.gain ? target : this.gain + (target - this.gain) * this.release;
      const leaving = (pos + 1) % n;
      for (let c = 0; c < this.channels; c++) out[c][i] = this.ring[c][leaving] * this.gain;
      this.pos++;
    }
    return out;
  }

  /** The last `delay` samples still inside. */
  flush(): Float32Array[] {
    return this.process(Array.from({ length: this.channels }, () => new Float32Array(this.delay)));
  }
}
