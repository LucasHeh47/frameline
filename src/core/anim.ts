// Values that can change over time (keyframes). A clip's position, scale, opacity, volume and effect
// settings are each an Anim: a fixed value, or keyframes the value moves between.

export type Ease = 'linear' | 'ease' | 'in' | 'out' | 'hold';

export interface Key {
  /** Frames from the clip's start. */
  f: number;
  v: number;
  /** How the value moves from this keyframe to the next. */
  ease?: Ease;
}

export interface Anim {
  /** The value when there are no keyframes. */
  v: number;
  keys?: Key[];
}

export const anim = (v: number): Anim => ({ v });

export function isAnimated(a: Anim | undefined): boolean {
  return !!a?.keys?.length;
}

function shape(t: number, ease: Ease | undefined): number {
  switch (ease) {
    case 'hold':
      return 0;
    case 'ease':
      return t * t * (3 - 2 * t);
    case 'in':
      return t * t;
    case 'out':
      return 1 - (1 - t) * (1 - t);
    default:
      return t;
  }
}

/** The value at a frame (from the clip's start; fractions are fine). */
export function valueAt(a: Anim | undefined, f: number, fallback = 0): number {
  if (!a) return fallback;
  const keys = a.keys;
  if (!keys?.length) return a.v;
  if (f <= keys[0].f) return keys[0].v;
  const last = keys[keys.length - 1];
  if (f >= last.f) return last.v;
  // Keyframes are kept sorted
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].f <= f) i++;
  const a0 = keys[i];
  const a1 = keys[i + 1];
  const t = a1.f === a0.f ? 1 : (f - a0.f) / (a1.f - a0.f);
  return a0.v + (a1.v - a0.v) * shape(t, a0.ease);
}

function sortKeys(a: Anim): void {
  a.keys?.sort((x, y) => x.f - y.f);
}

/**
 * Sets the value at a frame. With keyframes on, that adds (or moves) a keyframe there; without,
 * it changes the single value.
 */
export function setValue(a: Anim, f: number, v: number): void {
  if (!a.keys?.length) {
    a.v = v;
    return;
  }
  const at = Math.round(f);
  const k = a.keys.find((x) => x.f === at);
  if (k) k.v = v;
  else {
    const prev = [...a.keys].reverse().find((x) => x.f < at);
    a.keys.push({ f: at, v, ease: prev?.ease });
    sortKeys(a);
  }
  a.v = valueAt(a, 0);
}

/** Turns keyframes on (the first one at `f` with the current value) or off (keeping the value at `f`). */
export function setAnimated(a: Anim, on: boolean, f: number): void {
  if (on) {
    if (!a.keys?.length) a.keys = [{ f: Math.round(f), v: a.v }];
  } else {
    a.v = valueAt(a, f);
    delete a.keys;
  }
}

export function addKey(a: Anim, f: number): void {
  const v = valueAt(a, f);
  if (!a.keys?.length) a.keys = [{ f: Math.round(f), v }];
  else setValue(a, f, v);
}

export function removeKey(a: Anim, f: number): void {
  if (!a.keys) return;
  const at = Math.round(f);
  const v = valueAt(a, f);
  a.keys = a.keys.filter((k) => k.f !== at);
  if (!a.keys.length) {
    delete a.keys;
    a.v = v;
  }
}

export function moveKey(a: Anim, from: number, to: number): void {
  const k = a.keys?.find((x) => x.f === from);
  if (!k || !a.keys) return;
  const at = Math.round(to);
  // Moving onto another keyframe replaces it
  a.keys = a.keys.filter((x) => x === k || x.f !== at);
  k.f = at;
  sortKeys(a);
}

export function keyAt(a: Anim | undefined, f: number): Key | undefined {
  return a?.keys?.find((k) => k.f === Math.round(f));
}

/** The nearest keyframe before / after a frame (for the keyframe arrows). */
export function nearKey(a: Anim | undefined, f: number, dir: -1 | 1): Key | undefined {
  const keys = a?.keys ?? [];
  return dir < 0 ? [...keys].reverse().find((k) => k.f < Math.round(f)) : keys.find((k) => k.f > Math.round(f));
}

/** Keyframes after cutting `frames` off a clip's start (they stay with the picture). */
export function shiftKeys(a: Anim | undefined, frames: number): void {
  if (!a?.keys) return;
  for (const k of a.keys) k.f -= frames;
}

/** Every Anim inside a value (a clip, an effect's settings…), to shift or copy their keyframes together. */
export function animsIn(obj: unknown, out: Anim[] = []): Anim[] {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const x of obj) animsIn(x, out);
    return out;
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.v === 'number' && Object.keys(o).every((k) => k === 'v' || k === 'keys')) {
    out.push(o as unknown as Anim);
    return out;
  }
  for (const v of Object.values(o)) animsIn(v, out);
  return out;
}
