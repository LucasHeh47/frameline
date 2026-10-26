// Editing a sequence: placing clips (overwrite and insert), cutting, trimming (ripple, roll, slip,
// slide, rate stretch), moving, deleting with or without closing the gap, speed, frame holds,
// transitions, tracks and markers. Each function changes the sequence it's given; the app takes a
// snapshot first so it can be undone.
import { animsIn, shiftKeys } from './anim';
import {
  allTracks,
  clipEnd,
  findClip,
  hasMediaLimit,
  linkedClips,
  newTrack,
  sourceSpan,
  sourceTimeAt,
  uid,
  type Clip,
  type MediaItem,
  type Sequence,
  type Track,
  type TrackKind,
  type Transition,
} from './project';

/** Media durations by id, for how far a clip can be lengthened. */
export type MediaLookup = (id: string) => MediaItem | undefined;

const sortClips = (t: Track) => t.clips.sort((a, b) => a.start - b.start);

/** A copy of a clip with a new id (its keyframes and effects copied too). */
export function cloneClip(c: Clip): Clip {
  const copy = structuredClone(c);
  copy.id = uid('c');
  return copy;
}

function shiftClipKeys(c: Clip, frames: number): void {
  for (const a of animsIn([c.motion, c.opacity, c.volume, c.pan, c.effects])) shiftKeys(a, frames);
}

/** Removes `frames` from the start of a clip (negative frames lengthen it). */
export function cutHead(c: Clip, frames: number, fps: number): void {
  c.start += frames;
  c.duration -= frames;
  if (c.hold === undefined && !c.reverse) c.in += (frames / fps) * c.speed;
  shiftClipKeys(c, frames);
}

/** Removes `frames` from the end of a clip (negative frames lengthen it). */
export function cutTail(c: Clip, frames: number, fps: number): void {
  c.duration -= frames;
  if (c.hold === undefined && c.reverse) c.in += (frames / fps) * c.speed;
}

/** Frames of media before the clip's first frame and after its last (Infinity for stills and titles). */
export function handles(c: Clip, media: MediaItem | undefined, fps: number): { head: number; tail: number } {
  if (!hasMediaLimit(c) || !media) return { head: Infinity, tail: Infinity };
  const before = c.in;
  const after = Math.max(0, media.duration - (c.in + sourceSpan(c, fps)));
  const toFrames = (s: number) => Math.floor((s / c.speed) * fps + 1e-6);
  return c.reverse ? { head: toFrames(after), tail: toFrames(before) } : { head: toFrames(before), tail: toFrames(after) };
}

/** Linked clips split at the same frame stay linked to each other. */
const splitLink = (link: string | undefined, f: number) => (link ? `${link.split('.')[0]}.${uid()}${f.toString(36)}` : undefined);

/**
 * Splits a clip at a timeline frame. The left part keeps the clip's id; the right part is returned.
 * `link` gives the right part's new link (so a video and its sound split together stay linked).
 */
export function splitClip(t: Track, c: Clip, f: number, fps: number, link?: string): Clip | null {
  if (f <= c.start || f >= clipEnd(c)) return null;
  const right = cloneClip(c);
  cutHead(right, f - c.start, fps);
  cutTail(c, clipEnd(c) - f, fps);
  delete right.transIn;
  delete c.transOut;
  right.linkId = c.linkId ? link ?? splitLink(c.linkId, f) : undefined;
  t.clips.splice(t.clips.indexOf(c) + 1, 0, right);
  return right;
}

/** Clears a range on a track for something placed on top (clips are cut back, split or removed). */
export function clearRange(t: Track, s: number, e: number, fps: number, keep?: Set<string>): Clip[] {
  const removed: Clip[] = [];
  const out: Clip[] = [];
  for (const c of [...t.clips]) {
    const cs = c.start;
    const ce = clipEnd(c);
    if (ce <= s || cs >= e || keep?.has(c.id)) {
      out.push(c);
      continue;
    }
    if (cs >= s && ce <= e) {
      removed.push(c);
      continue;
    }
    if (cs < s && ce > e) {
      const right = cloneClip(c);
      cutHead(right, e - cs, fps);
      delete right.transIn;
      right.linkId = c.linkId ? `${c.linkId.split('.')[0]}.r${e.toString(36)}` : undefined;
      cutTail(c, ce - s, fps);
      delete c.transOut;
      out.push(c, right);
    } else if (cs < s) {
      cutTail(c, ce - s, fps);
      delete c.transOut;
      out.push(c);
    } else {
      cutHead(c, e - cs, fps);
      delete c.transIn;
      out.push(c);
    }
  }
  t.clips = out;
  sortClips(t);
  return removed;
}

export function isFree(t: Track, s: number, e: number, ignore?: Set<string>): boolean {
  return t.clips.every((c) => ignore?.has(c.id) || clipEnd(c) <= s || c.start >= e);
}

/** The tracks an edit that shifts clips moves: the ones edited plus every unlocked sync-locked track. */
export function rippleTracks(s: Sequence, targets: Track[]): Track[] {
  const set = new Set(targets.filter((t) => !t.locked));
  for (const t of allTracks(s)) if (t.syncLock && !t.locked) set.add(t);
  return [...set];
}

/** Opens a gap of `d` frames at frame `f` on these tracks (clips across `f` are split). */
export function insertSpace(s: Sequence, f: number, d: number, tracks: Track[]): void {
  for (const t of tracks) {
    if (t.locked) continue;
    const crossing = t.clips.find((c) => c.start < f && clipEnd(c) > f);
    if (crossing) splitClip(t, crossing, f, s.fps, crossing.linkId ? `${crossing.linkId.split('.')[0]}.i${f.toString(36)}` : undefined);
    for (const c of t.clips) if (c.start >= f) c.start += d;
  }
}

/** Shifts the clips at or after `from` by `d` frames on these tracks. */
function shiftFrom(tracks: Track[], from: number, d: number, skip?: Set<string>): void {
  for (const t of tracks) {
    if (t.locked) continue;
    for (const c of t.clips) if (c.start >= from && !skip?.has(c.id)) c.start += d;
    sortClips(t);
  }
}

export type PlaceMode = 'overwrite' | 'insert';

/** Puts clips on tracks. Overwrite replaces what's there; insert pushes later clips along. */
export function placeClips(s: Sequence, items: { track: Track; clip: Clip }[], mode: PlaceMode): void {
  if (!items.length) return;
  if (mode === 'insert') {
    const f = Math.min(...items.map((i) => i.clip.start));
    const end = Math.max(...items.map((i) => clipEnd(i.clip)));
    insertSpace(s, f, end - f, rippleTracks(s, items.map((i) => i.track)));
  } else {
    for (const { track, clip } of items) clearRange(track, clip.start, clipEnd(clip), s.fps);
  }
  for (const { track, clip } of items) {
    track.clips.push(clip);
    sortClips(track);
  }
}

/** Splits clips under a frame: on the given tracks (or every unlocked one), with their linked clips. */
export function razor(s: Sequence, f: number, onlyIds?: Set<string>, tracks?: Track[]): number {
  let n = 0;
  const links = new Map<string, string>();
  const targets = (tracks ?? allTracks(s)).filter((t) => !t.locked);
  const cut = new Set<string>();
  for (const t of targets) {
    for (const c of t.clips) {
      if (c.start < f && clipEnd(c) > f && (!onlyIds || onlyIds.has(c.id))) {
        cut.add(c.id);
        for (const l of linkedClips(s, c)) cut.add(l.id);
      }
    }
  }
  for (const t of allTracks(s)) {
    if (t.locked) continue;
    for (const c of [...t.clips]) {
      if (!cut.has(c.id) || c.start >= f || clipEnd(c) <= f) continue;
      let link: string | undefined;
      if (c.linkId) {
        if (!links.has(c.linkId)) links.set(c.linkId, splitLink(c.linkId, f)!);
        link = links.get(c.linkId);
      }
      if (splitClip(t, c, f, s.fps, link)) n++;
    }
  }
  return n;
}

/** Merged [start, end) ranges. */
function merge(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Removes clips. With `ripple`, the gaps they leave close up: later clips on their tracks move back,
 * and so do sync-locked tracks that are empty there.
 */
export function removeClips(s: Sequence, ids: Set<string>, ripple: boolean): void {
  const removedBy = new Map<Track, [number, number][]>();
  for (const t of allTracks(s)) {
    if (t.locked) continue;
    const gone = t.clips.filter((c) => ids.has(c.id));
    if (!gone.length) continue;
    t.clips = t.clips.filter((c) => !ids.has(c.id));
    removedBy.set(t, gone.map((c) => [c.start, clipEnd(c)]));
  }
  if (!ripple) return;
  const all = merge([...removedBy.values()].flat());
  for (const t of allTracks(s)) {
    if (t.locked) continue;
    const own = removedBy.get(t);
    const gaps = own
      ? merge(own).filter(([a, b]) => isFree(t, a, b))
      : t.syncLock
        ? all.filter(([a, b]) => isFree(t, a, b))
        : [];
    // Later gaps first, so earlier positions stay right
    for (const [a, b] of gaps.sort((x, y) => y[0] - x[0])) shiftFrom([t], b, -(b - a));
  }
}

/** The empty space on a track around a frame, or null when a clip is there. */
export function gapAt(t: Track, f: number): [number, number] | null {
  if (t.clips.some((c) => c.start <= f && clipEnd(c) > f)) return null;
  const prev = [...t.clips].reverse().find((c) => clipEnd(c) <= f);
  const next = t.clips.find((c) => c.start > f);
  if (!next) return null;
  return [prev ? clipEnd(prev) : 0, next.start];
}

/** Closes the gap on a track at a frame (Ripple Delete on empty space). */
export function closeGap(s: Sequence, t: Track, f: number): boolean {
  const g = gapAt(t, f);
  if (!g) return false;
  const [a, b] = g;
  const tracks = [t, ...allTracks(s).filter((x) => x !== t && x.syncLock && !x.locked && isFree(x, a, b))];
  shiftFrom(tracks, b, -(b - a));
  return true;
}

// ---------- moving ----------

export interface MoveResult {
  /** The moved clips (copies when copying). */
  clips: Clip[];
}

/**
 * Moves clips by `df` frames and `dv` / `da` tracks (video / audio), overwriting what's there, or
 * pushing it along with `insert`. With `copy` the originals stay.
 */
export function moveClips(s: Sequence, ids: Set<string>, df: number, dv: number, da: number, opts: { insert?: boolean; copy?: boolean } = {}): MoveResult {
  const moving: { clip: Clip; from: Track }[] = [];
  for (const t of allTracks(s)) for (const c of t.clips) if (ids.has(c.id)) moving.push({ clip: c, from: t });
  if (!moving.length) return { clips: [] };
  // Not before the start of the sequence, and onto existing unlocked tracks of the same kind
  const minStart = Math.min(...moving.map((m) => m.clip.start));
  df = Math.max(df, -minStart);
  const dest = (from: Track): Track | undefined => {
    const list = from.kind === 'video' ? s.video : s.audio;
    const i = list.indexOf(from) + (from.kind === 'video' ? dv : da);
    return list[i];
  };
  for (const m of moving) {
    const d = dest(m.from);
    if (!d || d.locked) {
      if (m.from.kind === 'video') dv = 0;
      else da = 0;
    }
  }
  const links = new Map<string, string>();
  const placed: { track: Track; clip: Clip }[] = [];
  for (const m of moving) {
    let c = m.clip;
    if (opts.copy) {
      c = cloneClip(m.clip);
      if (c.linkId) {
        if (!links.has(c.linkId)) links.set(c.linkId, uid('l'));
        c.linkId = links.get(c.linkId);
      }
    } else m.from.clips = m.from.clips.filter((x) => x !== c);
    c.start += df;
    placed.push({ track: dest(m.from)!, clip: c });
  }
  placeClips(s, placed, opts.insert ? 'insert' : 'overwrite');
  return { clips: placed.map((p) => p.clip) };
}

/** Moves clips by frames when there's room (Alt+arrow nudging); returns whether they moved. */
export function nudge(s: Sequence, ids: Set<string>, df: number): boolean {
  const moving = allTracks(s).flatMap((t) => t.clips.filter((c) => ids.has(c.id)).map((c) => ({ c, t })));
  if (!moving.length || moving.some(({ t }) => t.locked)) return false;
  for (const { c, t } of moving) {
    const s2 = c.start + df;
    if (s2 < 0 || !isFree(t, s2, s2 + c.duration, ids)) return false;
  }
  for (const { c, t } of moving) {
    c.start += df;
    sortClips(t);
  }
  return true;
}

// ---------- trimming ----------

export type TrimMode = 'normal' | 'ripple' | 'roll';

/** How far the clips at or after `from` on a track can move back before they hit what's before them. */
function roomBefore(t: Track, from: number, skip: Set<string>): number {
  const after = t.clips.filter((c) => c.start >= from && !skip.has(c.id));
  if (!after.length) return Infinity;
  const limit = Math.max(0, ...t.clips.filter((c) => c.start < from && !skip.has(c.id)).map(clipEnd));
  return after[0].start - limit;
}

function neighbors(t: Track, c: Clip): { prev?: Clip; next?: Clip } {
  const i = t.clips.indexOf(c);
  return { prev: t.clips[i - 1], next: t.clips[i + 1] };
}

/**
 * Trims a clip's start ('head') or end ('tail') by `delta` frames (positive moves the edge later),
 * with its linked clips. Returns the delta actually used after the limits: neighbors (for normal
 * trims), the media's length, and at least one frame left.
 */
export function trimClip(s: Sequence, clipId: string, edge: 'head' | 'tail', delta: number, mode: TrimMode, media: MediaLookup, withLinked = true): number {
  const found = findClip(s, clipId);
  if (!found || found.track.locked) return 0;
  const group = (withLinked ? linkedClips(s, found.clip) : [found.clip])
    .map((c) => ({ c, t: findClip(s, c.id)!.track }))
    // Linked clips trim with it when their edge is in the same place
    .filter(({ c, t }) => !t.locked && (edge === 'head' ? c.start === found.clip.start : clipEnd(c) === clipEnd(found.clip)));
  let lo = -Infinity;
  let hi = Infinity;
  for (const { c, t } of group) {
    const h = handles(c, c.mediaId ? media(c.mediaId) : undefined, s.fps);
    const { prev, next } = neighbors(t, c);
    if (edge === 'head') {
      hi = Math.min(hi, c.duration - 1);
      lo = Math.max(lo, -h.head);
      if (mode === 'normal') lo = Math.max(lo, (prev ? clipEnd(prev) : 0) - c.start);
      if (mode === 'roll' && prev && clipEnd(prev) === c.start) {
        const ph = handles(prev, prev.mediaId ? media(prev.mediaId) : undefined, s.fps);
        lo = Math.max(lo, -(prev.duration - 1));
        hi = Math.min(hi, ph.tail);
      } else if (mode === 'roll') lo = Math.max(lo, (prev ? clipEnd(prev) : 0) - c.start);
    } else {
      lo = Math.max(lo, -(c.duration - 1));
      hi = Math.min(hi, h.tail);
      if (mode === 'normal') hi = Math.min(hi, (next ? next.start : Infinity) - clipEnd(c));
      if (mode === 'roll' && next && next.start === clipEnd(c)) {
        const nh = handles(next, next.mediaId ? media(next.mediaId) : undefined, s.fps);
        hi = Math.min(hi, next.duration - 1);
        lo = Math.max(lo, -nh.head);
      } else if (mode === 'roll') hi = Math.min(hi, (next ? next.start : Infinity) - clipEnd(c));
    }
  }
  const ids = new Set(group.map((g) => g.c.id));
  const from = clipEnd(found.clip);
  if (mode === 'ripple') {
    // The clips after it on its own tracks move back with it, so they need the room
    for (const { t } of group) {
      const room = roomBefore(t, from, ids);
      if (edge === 'head') hi = Math.min(hi, room);
      else lo = Math.max(lo, -room);
    }
  }
  const d = Math.round(Math.max(lo, Math.min(hi, delta)));
  if (!d || lo > hi) return 0;
  if (mode === 'ripple') {
    const shift = edge === 'head' ? -d : d;
    const own = new Set(group.map((g) => g.t));
    // Other sync-locked tracks follow when they have room (a long music clip there doesn't block the edit)
    const tracks = rippleTracks(s, [...own]).filter((t) => own.has(t) || shift > 0 || roomBefore(t, from, ids) >= -shift);
    if (edge === 'head') {
      // The clip keeps its place; its first frames go and everything after closes up
      for (const { c } of group) {
        cutHead(c, d, s.fps);
        c.start -= d;
      }
    } else for (const { c } of group) cutTail(c, -d, s.fps);
    shiftFrom(tracks, from, shift, ids);
    return d;
  }
  for (const { c, t } of group) {
    const { prev, next } = neighbors(t, c);
    if (edge === 'head') {
      if (mode === 'roll' && prev && clipEnd(prev) === c.start) cutTail(prev, -d, s.fps);
      cutHead(c, d, s.fps);
    } else {
      if (mode === 'roll' && next && next.start === clipEnd(c)) cutHead(next, d, s.fps);
      cutTail(c, -d, s.fps);
    }
    sortClips(t);
  }
  return d;
}

/** Slips a clip: shows earlier or later media without moving it (`frames` of the timeline). */
export function slipClip(s: Sequence, clipId: string, frames: number, media: MediaLookup): number {
  const found = findClip(s, clipId);
  if (!found || found.track.locked) return 0;
  let d = frames;
  const group = linkedClips(s, found.clip);
  for (const c of group) {
    if (!hasMediaLimit(c)) continue;
    const h = handles(c, c.mediaId ? media(c.mediaId) : undefined, s.fps);
    // Positive shows later media: the head moves into the tail handle
    const later = c.reverse ? h.head : h.tail;
    const earlier = c.reverse ? h.tail : h.head;
    d = Math.max(-earlier, Math.min(later, d));
  }
  if (!d) return 0;
  for (const c of group) if (hasMediaLimit(c)) c.in += ((c.reverse ? -d : d) / s.fps) * c.speed;
  return d;
}

/** Slides a clip between its neighbors: it moves, the clip before gets longer or shorter and the one after makes up for it. */
export function slideClip(s: Sequence, clipId: string, frames: number, media: MediaLookup): number {
  const found = findClip(s, clipId);
  if (!found || found.track.locked) return 0;
  const { clip: c, track: t } = found;
  const { prev, next } = neighbors(t, c);
  if (!prev || !next || clipEnd(prev) !== c.start || next.start !== clipEnd(c)) return 0;
  const ph = handles(prev, prev.mediaId ? media(prev.mediaId) : undefined, s.fps);
  const nh = handles(next, next.mediaId ? media(next.mediaId) : undefined, s.fps);
  const d = Math.max(-(prev.duration - 1), -nh.head, Math.min(ph.tail, next.duration - 1, frames));
  if (!d) return 0;
  cutTail(prev, -d, s.fps);
  c.start += d;
  cutHead(next, d, s.fps);
  return d;
}

/** Rate stretch: changes a clip's length by dragging an edge, keeping the same media (its speed changes). */
export function stretchClip(s: Sequence, clipId: string, edge: 'head' | 'tail', delta: number): number {
  const found = findClip(s, clipId);
  if (!found || found.track.locked) return 0;
  const { clip: c, track: t } = found;
  const { prev, next } = neighbors(t, c);
  const span = sourceSpan(c, s.fps);
  // Between 1% and 10000% speed, and not over the neighbors
  const minDur = Math.max(1, Math.ceil((span / 100) * s.fps));
  const maxDur = Math.floor((span / 0.01) * s.fps);
  let d = edge === 'head' ? -delta : delta;
  d = Math.max(minDur - c.duration, Math.min(maxDur - c.duration, d));
  if (edge === 'head') d = Math.min(d, c.start - (prev ? clipEnd(prev) : 0));
  else d = Math.min(d, (next ? next.start : Infinity) - clipEnd(c));
  if (!d) return 0;
  for (const x of linkedClips(s, c)) {
    const dur = x.duration + d;
    x.speed = (sourceSpan(x, s.fps) * s.fps) / dur;
    if (edge === 'head') x.start -= d;
    x.duration = dur;
  }
  return edge === 'head' ? -d : d;
}

/**
 * Sets a clip's speed (1 = 100%) and direction, with its linked clips. Its length changes to keep the
 * same media; with `ripple` later clips move, otherwise it can't grow past the next clip.
 */
export function setSpeed(s: Sequence, clipId: string, speed: number, reverse: boolean, ripple: boolean): void {
  const found = findClip(s, clipId);
  if (!found) return;
  speed = Math.max(0.01, Math.min(100, speed));
  const group = linkedClips(s, found.clip).map((c) => ({ c, t: findClip(s, c.id)!.track }));
  const oldEnd = clipEnd(found.clip);
  // Each linked clip keeps its own media; the clip's own change decides how far later clips move
  const durs = new Map(group.map(({ c }) => [c, Math.max(1, Math.round((sourceSpan(c, s.fps) / speed) * s.fps))]));
  if (!ripple) {
    for (const { c, t } of group) {
      const next = t.clips.find((x) => x.start >= clipEnd(c) && x !== c);
      if (next) durs.set(c, Math.min(durs.get(c)!, next.start - c.start));
    }
  }
  const d = durs.get(found.clip)! - found.clip.duration;
  if (ripple && d) shiftFrom(rippleTracks(s, group.map((g) => g.t)), oldEnd, d, new Set(group.map((g) => g.c.id)));
  for (const { c } of group) {
    c.speed = speed;
    if (reverse) c.reverse = true;
    else delete c.reverse;
    c.duration = durs.get(c)!;
  }
}

/** Frame hold: from frame `f` on, the clip shows that frame (it's split there first). */
export function addFrameHold(s: Sequence, clipId: string, f: number): Clip | null {
  const found = findClip(s, clipId);
  if (!found || found.clip.kind !== 'video') return null;
  const { clip: c, track: t } = found;
  const at = Math.max(c.start, Math.min(clipEnd(c) - 1, f));
  const time = sourceTimeAt(c, at, s.fps);
  const right = at > c.start ? splitClip(t, c, at, s.fps, undefined) : c;
  if (!right) return null;
  right.hold = time;
  // The held part's sound would be the wrong length; it keeps playing on its own track
  delete right.linkId;
  return right;
}

// ---------- in / out range ----------

/** Lift (keep the gap) or Extract (close it) the range between the in and out points. */
export function liftRange(s: Sequence, a: number, b: number, extract: boolean): void {
  if (b <= a) return;
  for (const t of allTracks(s)) {
    if (t.locked) continue;
    clearRange(t, a, b, s.fps);
    if (extract) shiftFrom([t], b, -(b - a));
  }
}

/** Ripple trims the clips under the playhead to it: 'prev' removes from their start (Q), 'next' to their end (W). */
export function trimToPlayhead(s: Sequence, f: number, side: 'prev' | 'next'): boolean {
  const under = allTracks(s).flatMap((t) => (t.locked ? [] : t.clips.filter((c) => c.start < f && clipEnd(c) > f)));
  if (!under.length) return false;
  if (side === 'prev') {
    const a = Math.min(...under.map((c) => c.start));
    liftRange(s, a, f, true);
  } else {
    const b = Math.max(...under.map(clipEnd));
    liftRange(s, f, b, true);
  }
  return true;
}

// ---------- transitions ----------

/** The clips right before and after a clip on its track (only touching ones). */
export function adjacent(t: Track, c: Clip): { prev?: Clip; next?: Clip } {
  const { prev, next } = neighbors(t, c);
  return { prev: prev && clipEnd(prev) === c.start ? prev : undefined, next: next && next.start === clipEnd(c) ? next : undefined };
}

/** Where a clip's transition plays, in timeline frames [start, end). */
export function transitionRange(t: Track, c: Clip, side: 'in' | 'out'): [number, number] | null {
  const tr = side === 'in' ? c.transIn : c.transOut;
  if (!tr) return null;
  const d = tr.duration;
  if (side === 'out') return [clipEnd(c) - d, clipEnd(c)];
  const { prev } = adjacent(t, c);
  if (!prev || tr.align === 'start') return [c.start, c.start + d];
  if (tr.align === 'end') return [c.start - d, c.start];
  const before = Math.floor(d / 2);
  return [c.start - before, c.start - before + d];
}

/**
 * Adds a transition at a clip's start or end. Between two clips it belongs to the second one's start
 * (centered on the cut); alone it fades the clip in or out.
 */
export function applyTransition(s: Sequence, clipId: string, side: 'in' | 'out', type: string, duration: number, align?: Transition['align']): boolean {
  const found = findClip(s, clipId);
  if (!found || found.track.locked) return false;
  let { clip: c } = found;
  const t = found.track;
  if (side === 'out') {
    const { next } = adjacent(t, c);
    if (next) {
      c = next;
      side = 'in';
    }
  }
  const { prev } = adjacent(t, c);
  const shared = side === 'in' && !!prev;
  const a: Transition['align'] = shared ? align ?? 'center' : side === 'in' ? 'start' : 'end';
  let d = Math.max(1, Math.round(duration));
  d = Math.min(d, c.duration);
  if (shared && prev) d = Math.min(d, a === 'center' ? Math.min(c.duration, prev.duration) * 2 : a === 'end' ? prev.duration : c.duration);
  const tr: Transition = { type, duration: d, align: a };
  if (side === 'in') {
    c.transIn = tr;
    if (prev) delete prev.transOut;
  } else c.transOut = tr;
  return true;
}

/** Every cut and clip edge on unlocked tracks (Up / Down arrows go between these). */
export function editPoints(s: Sequence): number[] {
  const set = new Set<number>([0]);
  for (const t of allTracks(s)) for (const c of t.clips) {
    set.add(c.start);
    set.add(clipEnd(c));
  }
  return [...set].sort((a, b) => a - b);
}

// ---------- tracks ----------

/** Renames tracks V1, V2… / A1, A2… unless the user named them. */
function renumber(list: Track[], kind: TrackKind): void {
  list.forEach((t, i) => {
    if (/^[VA]\d+$/.test(t.name)) t.name = `${kind === 'video' ? 'V' : 'A'}${i + 1}`;
  });
}

export function addTrack(s: Sequence, kind: TrackKind, index?: number): Track {
  const list = kind === 'video' ? s.video : s.audio;
  const t = newTrack(kind, list.length + 1);
  list.splice(index ?? list.length, 0, t);
  renumber(list, kind);
  return t;
}

export function removeTrack(s: Sequence, id: string): boolean {
  for (const kind of ['video', 'audio'] as const) {
    const list = kind === 'video' ? s.video : s.audio;
    const i = list.findIndex((t) => t.id === id);
    if (i < 0) continue;
    if (list.length <= 1) return false;
    list.splice(i, 1);
    renumber(list, kind);
    return true;
  }
  return false;
}

/** The track a clip's sound goes on, matching its picture's track (A1 for V1); added if missing. */
export function audioTrackFor(s: Sequence, videoTrack: Track): Track {
  const i = Math.max(0, s.video.indexOf(videoTrack));
  while (s.audio.length <= i) addTrack(s, 'audio');
  return s.audio[i];
}

/** The picture track for a sound on an audio track (V1 for A1). */
export function videoTrackFor(s: Sequence, audioTrack: Track): Track {
  const i = Math.max(0, s.audio.indexOf(audioTrack));
  while (s.video.length <= i) addTrack(s, 'video');
  return s.video[i];
}

// ---------- markers ----------

export const MARKER_COLORS = ['#3fcf8e', '#e5383b', '#ffb547', '#4ea1ff', '#a98bff', '#f472b6', '#e4e7ec'];
export const MARKER_COLOR_NAMES = ['Green', 'Red', 'Orange', 'Blue', 'Violet', 'Pink', 'White'];

export function addMarker(s: Sequence, f: number, name = '', color = MARKER_COLORS[0]): string {
  const existing = s.markers.find((m) => m.f === f);
  if (existing) return existing.id;
  const id = uid('m');
  s.markers.push({ id, f, name, color });
  s.markers.sort((a, b) => a.f - b.f);
  return id;
}
