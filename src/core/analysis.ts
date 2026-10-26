// Looking at pictures: how different two frames are (to find cuts between shots), and what color
// correction a frame needs (Lumetri's Auto).

/** How different two small frames' colors are (0–1), from 4-level-per-channel color histograms. */
export function histogramDistance(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const bins = (d: Uint8ClampedArray) => {
    const out = new Float32Array(64);
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      out[(d[i] >> 6) * 16 + (d[i + 1] >> 6) * 4 + (d[i + 2] >> 6)]++;
      n++;
    }
    for (let i = 0; i < 64; i++) out[i] /= n || 1;
    return out;
  };
  const x = bins(a);
  const y = bins(b);
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += Math.abs(x[i] - y[i]);
  return sum / 2;
}

/** White balance, exposure and contrast from a frame's pixels (bottom-row-first RGBA). */
export function autoCorrect(data: Uint8Array): Record<string, number> {
  const lum: number[] = [];
  let r = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i] / 255;
    const G = data[i + 1] / 255;
    const B = data[i + 2] / 255;
    const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    lum.push(l);
    // Neutral-ish mid tones say the most about the light's color
    if (l > 0.15 && l < 0.85) {
      r += R;
      b += B;
      n++;
    }
  }
  if (!lum.length) return {};
  lum.sort((x, y) => x - y);
  const pct = (p: number) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))];
  const lo = pct(0.02);
  const hi = pct(0.98);
  const mid = pct(0.5);
  const exposure = Math.max(-2, Math.min(2, Math.log2(0.46 / Math.max(0.02, mid)) * 0.8));
  const range = Math.max(0.05, hi - lo);
  const contrast = Math.max(-40, Math.min(45, (0.85 / range - 1) * 40));
  const cast = n ? (r - b) / n : 0;
  const temperature = Math.max(-60, Math.min(60, -cast * 160));
  return {
    exposure: Math.round(exposure * 20) / 20,
    contrast: Math.round(contrast),
    temperature: Math.round(temperature),
    whites: hi < 0.9 ? Math.round((0.95 - hi) * 80) : 0,
    blacks: lo > 0.06 ? -Math.round(lo * 120) : 0,
  };
}
