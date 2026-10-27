import { describe, expect, it } from 'vitest';
import { detectBeats, keptParts, LoudnessMeter, normalizeGain, PeakLimiter, silentRanges } from '../src/core/audioAnalysis';

describe('pauses', () => {
  it('finds long quiet stretches, keeping some room around the sound', () => {
    // 10 loud, 20 quiet, 10 loud, 3 quiet (too short), 10 loud, 8 quiet at the end
    const lv = [...Array(10).fill(0.5), ...Array(20).fill(0.001), ...Array(10).fill(0.5), ...Array(3).fill(0.001), ...Array(10).fill(0.5), ...Array(8).fill(0.001)];
    expect(silentRanges(lv, 0.01, 6, 2)).toEqual([
      [12, 28],
      [55, 61],
    ]);
  });

  it('removes quiet at the very start up to the sound', () => {
    const lv = [...Array(15).fill(0), ...Array(10).fill(0.5)];
    expect(silentRanges(lv, 0.01, 6, 3)).toEqual([[0, 12]]);
  });

  it('works out what is kept', () => {
    expect(keptParts(0, 100, [[10, 20], [50, 60], [15, 25]])).toEqual([
      [0, 10],
      [25, 50],
      [60, 100],
    ]);
    expect(keptParts(0, 100, [[0, 100]])).toEqual([]);
  });
});

describe('beats', () => {
  it('finds the tempo and the beats of a steady pulse', () => {
    const rate = 100;
    // 120 BPM: a hit every 50 slots starting at 13, decaying, over a quiet bed
    const env = new Float32Array(rate * 20);
    for (let i = 0; i < env.length; i++) {
      const since = (i - 13 + 1000) % 50;
      env[i] = 0.05 + (i >= 13 ? 0.8 * Math.exp(-since / 6) : 0);
    }
    const r = detectBeats(env, rate)!;
    expect(r.bpm).toBeGreaterThan(117);
    expect(r.bpm).toBeLessThan(123);
    expect(r.beats.length).toBeGreaterThan(30);
    // Beats land on the hits
    for (const b of r.beats.slice(1, -1)) {
      const slot = Math.round(b * rate);
      expect(Math.abs(((slot - 13) % 50 + 50) % 50)).toBeLessThanOrEqual(1);
    }
  });

  it('gives up on too little sound', () => {
    expect(detectBeats(new Float32Array(100), 100)).toBeNull();
  });
});

describe('loudness', () => {
  it('measures a full-scale 1 kHz sine at about -3 LUFS (mono counted on both sides)', () => {
    const sr = 48000;
    const m = new LoudnessMeter(sr, 2);
    const n = sr * 5;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / sr);
    m.add([x, x]);
    // A 0 dBFS sine on one channel reads -3.01 LUFS; on two channels about 0
    expect(m.lufs).toBeGreaterThan(-0.6);
    expect(m.lufs).toBeLessThan(0.6);
    expect(m.peak).toBeCloseTo(1, 3);
  });

  it('reads 10 dB quieter for a sine 10 dB down', () => {
    const sr = 48000;
    const a = new LoudnessMeter(sr, 1);
    const b = new LoudnessMeter(sr, 1);
    const n = sr * 3;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
      y[i] = x[i] * Math.pow(10, -10 / 20);
    }
    a.add([x]);
    b.add([y]);
    expect(a.lufs - b.lufs).toBeCloseTo(10, 1);
  });

  it('is silent for silence', () => {
    const m = new LoudnessMeter(48000, 2);
    m.add([new Float32Array(48000), new Float32Array(48000)]);
    expect(m.lufs).toBe(-Infinity);
  });

  it('gives the gain to the target, up to a limit', () => {
    expect(normalizeGain(-20, -14)).toBeCloseTo(6, 5);
    expect(normalizeGain(-10, -14)).toBeCloseTo(-4, 5);
    expect(normalizeGain(-60, -14)).toBe(20);
    expect(normalizeGain(-Infinity, -14)).toBe(0);
  });
});

describe('peak limiter', () => {
  const sr = 48000;
  const run = (lim: PeakLimiter, x: Float32Array, block = 1000) => {
    const parts: Float32Array[] = [];
    for (let i = 0; i < x.length; i += block) parts.push(lim.process([x.subarray(i, i + block)])[0]);
    parts.push(lim.flush()[0]);
    const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    // Lined up with the input again
    return all.subarray(lim.delay, lim.delay + x.length);
  };

  it('keeps every sample under the ceiling', () => {
    const x = new Float32Array(sr);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 100 * i) / sr) + (i % 4800 < 30 ? 1.8 : 0);
    const y = run(new PeakLimiter(sr, 1, 0.89), x);
    let peak = 0;
    for (const v of y) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(0.89 + 1e-6);
  });

  it('leaves sound under the ceiling alone, just delayed', () => {
    const x = new Float32Array(sr / 2);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    const y = run(new PeakLimiter(sr, 1, 0.89), x, 777);
    for (let i = 0; i < x.length; i += 97) expect(y[i]).toBeCloseTo(x[i], 6);
  });
});
