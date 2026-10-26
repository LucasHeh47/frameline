// What a sequence shows and plays at a frame: the picture layers from V1 up (with transitions between
// clips), and the sounds with their transition fades. The preview player and the exporter both use
// this, so what you see while editing is what gets exported.
import { valueAt } from './anim';
import { adjacent, transitionRange } from './edit';
import type { ParamValue } from './effects';
import { clipEnd, sourceTimeAt, type Clip, type MediaItem, type Sequence, type Track, type Transition } from './project';

export interface ClipFrame {
  clip: Clip;
  /** Media seconds to show or play (kept inside the media). */
  time: number;
  /** Frames since the clip's start (for keyframes); outside the clip during transitions. */
  local: number;
}

export interface TransitionFrame {
  type: string;
  /** 0 at the start of the transition, 1 at the end. */
  progress: number;
  params: Record<string, ParamValue>;
  /** The clip it belongs to. */
  owner: Clip;
}

export interface VideoLayer {
  track: Track;
  /** The clip shown (or the outgoing one in a transition; null fades in from nothing). */
  a: ClipFrame | null;
  /** The incoming clip in a transition (null fades out to nothing). */
  b?: ClipFrame | null;
  transition?: TransitionFrame;
}

export interface AudioVoice {
  clip: Clip;
  track: Track;
  time: number;
  local: number;
  /** 0–1 from transitions (crossfades and fades). */
  fade: number;
}

export type MediaOf = (c: Clip) => MediaItem | undefined;

interface Affect {
  range: [number, number];
  role: 'in' | 'out';
  tr: Transition;
  owner: Clip;
}

/** The transitions that touch a clip: its own fade in / out, and the next clip's transition from it. */
export function transitionsOf(t: Track, c: Clip): Affect[] {
  const out: Affect[] = [];
  const rin = transitionRange(t, c, 'in');
  if (rin && c.transIn) out.push({ range: rin, role: 'in', tr: c.transIn, owner: c });
  const rout = transitionRange(t, c, 'out');
  if (rout && c.transOut) out.push({ range: rout, role: 'out', tr: c.transOut, owner: c });
  const { next } = adjacent(t, c);
  const rnext = next ? transitionRange(t, next, 'in') : null;
  if (next?.transIn && rnext) out.push({ range: rnext, role: 'out', tr: next.transIn, owner: next });
  return out;
}

/** The frames a clip is seen or heard: its own, plus transition overlaps around it. */
export function activeRange(t: Track, c: Clip): [number, number] {
  let a = c.start;
  let b = clipEnd(c);
  for (const x of transitionsOf(t, c)) {
    a = Math.min(a, x.range[0]);
    b = Math.max(b, x.range[1]);
  }
  return [a, b];
}

const progressIn = (r: [number, number], f: number) => Math.max(0, Math.min(1, (f - r[0] + 0.5) / Math.max(1, r[1] - r[0])));

function clipFrame(c: Clip, f: number, fps: number, media?: MediaOf): ClipFrame {
  let time = sourceTimeAt(c, f, fps);
  const m = media?.(c);
  if (m && m.duration > 0 && c.kind !== 'image') time = Math.max(0, Math.min(m.duration - 0.5 / Math.max(1, m.fps || fps), time));
  return { clip: c, time: Math.max(0, time), local: f - c.start };
}

/** Video tracks that show: not hidden, and when any is soloed, only soloed ones. */
export function visibleVideoTracks(s: Sequence): Track[] {
  const solo = s.video.some((t) => t.solo);
  return s.video.filter((t) => !t.muted && (!solo || t.solo));
}

/** The picture layers at a frame, V1 (bottom) first. */
export function videoAt(s: Sequence, f: number, media?: MediaOf): VideoLayer[] {
  const out: VideoLayer[] = [];
  for (const t of visibleVideoTracks(s)) {
    let layer: VideoLayer | null = null;
    // A transition playing here decides what this track shows
    for (const c of t.clips) {
      if (!c.transIn && !c.transOut && !adjacent(t, c).next?.transIn) continue;
      for (const x of transitionsOf(t, c)) {
        if (f < x.range[0] || f >= x.range[1]) continue;
        const from = x.role === 'in' ? adjacent(t, c).prev : c;
        const to = x.role === 'in' ? c : x.owner !== c ? x.owner : null;
        const shared = x.role === 'in' ? !!from : !!to;
        const frame = (k: Clip | null | undefined) => (k && k.enabled ? clipFrame(k, f, s.fps, media) : null);
        layer = {
          track: t,
          a: x.role === 'in' && !shared ? null : frame(from),
          b: x.role === 'out' && !shared ? null : frame(to),
          transition: { type: x.tr.type, progress: progressIn(x.range, f), params: x.tr.params ?? {}, owner: x.owner },
        };
        break;
      }
      if (layer) break;
    }
    if (!layer) {
      const c = t.clips.find((k) => k.start <= f && clipEnd(k) > f);
      if (c?.enabled) layer = { track: t, a: clipFrame(c, f, s.fps, media) };
    }
    if (layer && (layer.a || layer.b)) out.push(layer);
  }
  return out;
}

/** Audio tracks that play: not muted, and when any is soloed, only soloed ones. */
export function audibleTracks(s: Sequence): Track[] {
  const solo = s.audio.some((t) => t.solo);
  return s.audio.filter((t) => !t.muted && (!solo || t.solo));
}

/** How loud one side of an audio transition is at progress p. */
export function fadeCurve(type: string, p: number, role: 'in' | 'out'): number {
  const x = role === 'in' ? p : 1 - p;
  if (type === 'constantGain') return x;
  if (type === 'exponentialFade') return x * x;
  return Math.sin((x * Math.PI) / 2);
}

/** The transition fade of an audio clip at a frame (1 outside transitions). */
export function audioFade(t: Track, c: Clip, f: number): number {
  let g = 1;
  for (const x of transitionsOf(t, c)) {
    if (f < x.range[0] || f >= x.range[1]) continue;
    g *= fadeCurve(x.tr.type, progressIn(x.range, f), x.role);
  }
  return g;
}

/** The sounds playing at a frame. */
export function audioAt(s: Sequence, f: number, media?: MediaOf): AudioVoice[] {
  const out: AudioVoice[] = [];
  for (const t of audibleTracks(s)) {
    for (const c of t.clips) {
      if (!c.enabled) continue;
      const [a, b] = activeRange(t, c);
      if (f < a || f >= b) continue;
      const cf = clipFrame(c, f, s.fps, media);
      out.push({ clip: c, track: t, time: cf.time, local: cf.local, fade: audioFade(t, c, f) });
    }
  }
  return out;
}

/** dB to a gain multiplier (−∞ dB is silence). */
export function dbToGain(db: number): number {
  return db <= -96 ? 0 : Math.pow(10, db / 20);
}

/** A clip's own level at a frame (its Volume keyframes), as a multiplier. */
export function clipGain(c: Clip, local: number): number {
  return dbToGain(valueAt(c.volume, local, 0));
}

/** Frames to snap to while dragging: clip edges, the playhead, markers, and the in and out points. */
export function snapPoints(s: Sequence, skip: Set<string>, playhead: number): number[] {
  const set = new Set<number>([0, playhead]);
  for (const t of [...s.video, ...s.audio]) {
    for (const c of t.clips) {
      if (skip.has(c.id)) continue;
      set.add(c.start);
      set.add(clipEnd(c));
    }
  }
  for (const m of s.markers) set.add(m.f);
  if (s.inPoint !== null) set.add(s.inPoint);
  if (s.outPoint !== null) set.add(s.outPoint);
  return [...set].sort((a, b) => a - b);
}

/** The nearest snap point within `within` frames of any of the frames given; returns the shift to it. */
export function snapShift(points: number[], frames: number[], within: number): { shift: number; at: number } | null {
  let best: { shift: number; at: number } | null = null;
  for (const f of frames) {
    for (const p of points) {
      const d = p - f;
      if (Math.abs(d) <= within && (!best || Math.abs(d) < Math.abs(best.shift))) best = { shift: d, at: p };
    }
  }
  return best;
}
