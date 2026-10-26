// Auto-ducking: music gets quieter while someone speaks (or any other sound plays), then comes back.
// Finds the frames where other sound is loud enough, and makes volume keyframes that dip under them.
import type { Key } from './anim';

/**
 * Ranges of frames [start, end) whose level is over the threshold. Gaps shorter than `bridge`
 * frames are joined (pauses between words), and blips shorter than `minLength` are ignored.
 */
export function activeRanges(levels: ArrayLike<number>, threshold: number, bridge: number, minLength: number): [number, number][] {
  const raw: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= levels.length; i++) {
    const on = i < levels.length && levels[i] > threshold;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      raw.push([start, i]);
      start = -1;
    }
  }
  const joined: [number, number][] = [];
  for (const r of raw) {
    const last = joined[joined.length - 1];
    if (last && r[0] - last[1] < bridge) last[1] = r[1];
    else joined.push([r[0], r[1]]);
  }
  return joined.filter(([a, b]) => b - a >= minLength);
}

/**
 * Volume keyframes (dB) for a clip that dip by `depth` dB under each range, fading over `fade`
 * frames before and after. Ranges are in timeline frames; keyframes are in the clip's frames.
 */
export function duckKeys(ranges: [number, number][], clipStart: number, clipDuration: number, base: number, depth: number, fade: number): Key[] {
  const last = clipDuration - 1;
  const low = base - Math.abs(depth);
  // Dips closer together than a fade out and back in are one dip
  const dips: [number, number][] = [];
  for (const [a, b] of ranges) {
    const s = a - clipStart;
    const e = b - clipStart;
    if (e + fade < 0 || s - fade > last) continue;
    const prev = dips[dips.length - 1];
    if (prev && s - prev[1] < fade * 2) prev[1] = e;
    else dips.push([s, e]);
  }
  const keys: Key[] = [];
  const add = (f: number, v: number) => {
    const at = Math.max(0, Math.min(last, Math.round(f)));
    const k = keys.find((x) => x.f === at);
    // Where a fade is cut off by the clip's edge, the low level wins
    if (k) k.v = Math.min(k.v, v);
    else keys.push({ f: at, v, ease: 'ease' });
  };
  for (const [s, e] of dips) {
    add(s - fade, base);
    add(s, low);
    add(e, low);
    add(e + fade, base);
  }
  return keys.sort((x, y) => x.f - y.f);
}
