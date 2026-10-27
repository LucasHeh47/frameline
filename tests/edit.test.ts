import { describe, expect, it } from 'vitest';
import { valueAt } from '../src/core/anim';
import {
  addFrameHold,
  applyTransition,
  clearRange,
  closeGap,
  handles,
  insertSpace,
  liftRange,
  moveClips,
  nudge,
  placeClips,
  razor,
  razorAtMarkers,
  reframedSequence,
  removeRanges,
  removeClips,
  setSpeed,
  slideClip,
  slipClip,
  splitClip,
  stretchClip,
  transitionRange,
  trimClip,
  trimToPlayhead,
} from '../src/core/edit';
import { clipEnd, clipFromMedia, generatedClip, newSequence, sourceTimeAt, titleFor, type Clip, type MediaItem, type Sequence } from '../src/core/project';

const FPS = 30;
const MEDIA: MediaItem = { id: 'm1', kind: 'video', name: 'a.mp4', path: 'C:\\a.mp4', duration: 20, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000 };
const media = (id: string) => (id === 'm1' ? MEDIA : undefined);

function seq(): Sequence {
  return newSequence('S', 1920, 1080, FPS, 2, 2);
}

/** A video clip of m1 at `start` for `dur` frames, starting `inSec` into the media. */
function clip(s: Sequence, start: number, dur: number, inSec = 0, name = 'c'): Clip {
  const c = clipFromMedia(MEDIA, s, { start, duration: dur }, 'video');
  c.in = inSec;
  c.name = name;
  return c;
}

function put(s: Sequence, c: Clip, track = 0): Clip {
  s.video[track].clips.push(c);
  s.video[track].clips.sort((a, b) => a.start - b.start);
  return c;
}

const spans = (s: Sequence, track = 0) => s.video[track].clips.map((c) => [c.start, clipEnd(c)]);

describe('placing clips', () => {
  it('overwrite cuts back, splits and removes what is underneath', () => {
    const s = seq();
    put(s, clip(s, 0, 60, 0, 'a'));
    put(s, clip(s, 60, 30, 0, 'b'));
    put(s, clip(s, 100, 20, 0, 'c'));
    placeClips(s, [{ track: s.video[0], clip: clip(s, 50, 55, 0, 'new') }], 'overwrite');
    expect(spans(s)).toEqual([[0, 50], [50, 105], [105, 120]]);
    // The clip cut at its head now starts 5 frames later in its media
    expect(s.video[0].clips[2].in).toBeCloseTo(5 / FPS);
  });

  it('overwrite in the middle of a clip splits it, the right part continuing the media', () => {
    const s = seq();
    put(s, clip(s, 0, 100, 2));
    placeClips(s, [{ track: s.video[0], clip: clip(s, 40, 10, 0, 'mid') }], 'overwrite');
    expect(spans(s)).toEqual([[0, 40], [40, 50], [50, 100]]);
    expect(s.video[0].clips[2].in).toBeCloseTo(2 + 50 / FPS);
  });

  it('insert pushes later clips along on every sync-locked track', () => {
    const s = seq();
    put(s, clip(s, 0, 60));
    put(s, clip(s, 30, 60), 1);
    placeClips(s, [{ track: s.video[0], clip: clip(s, 60, 15, 0, 'ins') }], 'insert');
    expect(spans(s)).toEqual([[0, 60], [60, 75]]);
    // V2 had a clip across the insert point: it's split and its second half moves
    expect(spans(s, 1)).toEqual([[30, 60], [75, 105]]);
  });

  it('tracks without sync lock stay put on insert', () => {
    const s = seq();
    s.video[1].syncLock = false;
    put(s, clip(s, 100, 10), 1);
    insertSpace(s, 50, 20, [s.video[0], ...s.audio, s.video[1]].filter((t) => t.syncLock));
    expect(spans(s, 1)).toEqual([[100, 110]]);
  });
});

describe('cutting', () => {
  it('splits a clip so the halves play straight through', () => {
    const s = seq();
    const c = put(s, clip(s, 10, 90, 1));
    const right = splitClip(s.video[0], c, 40, FPS)!;
    expect([c.start, c.duration, right.start, right.duration]).toEqual([10, 30, 40, 60]);
    expect(sourceTimeAt(right, 40, FPS)).toBeCloseTo(sourceTimeAt({ ...c, duration: 90 }, 40, FPS));
  });

  it('splits a reversed clip correctly', () => {
    const s = seq();
    const c = put(s, clip(s, 0, 60, 1));
    c.reverse = true;
    const t30 = sourceTimeAt(c, 30, FPS);
    const right = splitClip(s.video[0], c, 30, FPS)!;
    expect(sourceTimeAt(right, 30, FPS)).toBeCloseTo(t30);
    expect(sourceTimeAt(c, 29, FPS)).toBeCloseTo(t30 + 1 / FPS);
  });

  it('razor splits linked clips too, keeping the halves linked in pairs', () => {
    const s = seq();
    const v = put(s, clip(s, 0, 90));
    const a = clipFromMedia(MEDIA, s, { start: 0, duration: 90 }, 'audio');
    v.linkId = a.linkId = 'L1';
    s.audio[0].clips.push(a);
    expect(razor(s, 45, new Set([v.id]))).toBe(2);
    const [v1, v2] = s.video[0].clips;
    const [a1, a2] = s.audio[0].clips;
    expect(v1.linkId).toBe(a1.linkId);
    expect(v2.linkId).toBe(a2.linkId);
    expect(v2.linkId).not.toBe(v1.linkId);
  });

  it('keyframes stay with the picture when the head is cut', () => {
    const s = seq();
    const c = put(s, clip(s, 0, 100));
    c.opacity = { v: 100, keys: [{ f: 0, v: 0 }, { f: 50, v: 100 }] };
    const right = splitClip(s.video[0], c, 25, FPS)!;
    expect(valueAt(right.opacity, 0)).toBeCloseTo(valueAt(c.opacity, 25));
  });
});

describe('deleting', () => {
  it('ripple delete closes the gap', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 30));
    const b = put(s, clip(s, 30, 30));
    put(s, clip(s, 60, 30));
    removeClips(s, new Set([b.id]), true);
    expect(spans(s)).toEqual([[0, 30], [30, 60]]);
    removeClips(s, new Set([a.id]), false);
    expect(spans(s)).toEqual([[30, 60]]);
  });

  it('ripple delete moves sync-locked tracks only where they are empty', () => {
    const s = seq();
    const b = put(s, clip(s, 30, 30));
    put(s, clip(s, 90, 10));
    put(s, clip(s, 100, 10), 1);
    removeClips(s, new Set([b.id]), true);
    expect(spans(s)).toEqual([[60, 70]]);
    expect(spans(s, 1)).toEqual([[70, 80]]);
  });

  it('closes a gap on a track', () => {
    const s = seq();
    put(s, clip(s, 0, 30));
    put(s, clip(s, 50, 30));
    expect(closeGap(s, s.video[0], 40)).toBe(true);
    expect(spans(s)).toEqual([[0, 30], [30, 60]]);
  });

  it('lift and extract remove a range', () => {
    const s = seq();
    put(s, clip(s, 0, 100));
    liftRange(s, 20, 40, false);
    expect(spans(s)).toEqual([[0, 20], [40, 100]]);
    liftRange(s, 50, 60, true);
    expect(spans(s)).toEqual([[0, 20], [40, 50], [50, 90]]);
  });

  it('trims to the playhead with ripple (Q and W)', () => {
    const s = seq();
    put(s, clip(s, 0, 100));
    trimToPlayhead(s, 30, 'prev');
    expect(spans(s)).toEqual([[0, 70]]);
    trimToPlayhead(s, 50, 'next');
    expect(spans(s)).toEqual([[0, 50]]);
  });

  it('trims only from the nearest edit when a long clip runs under the playhead', () => {
    const s = seq();
    put(s, clip(s, 0, 40, 0, 'first'));
    put(s, clip(s, 40, 60, 0, 'second'));
    put(s, clip(s, 0, 200, 0, 'music'), 1);
    trimToPlayhead(s, 50, 'prev');
    // Only 40–50 goes: the first clip stays whole, the music closes up
    expect(spans(s)).toEqual([[0, 40], [40, 90]]);
    expect(spans(s, 1)).toEqual([[0, 40], [40, 190]]);
  });
});

describe('locked tracks', () => {
  it('placing on a locked track goes to the next unlocked one', () => {
    const s = seq();
    const keep = put(s, clip(s, 0, 50, 0, 'keep'));
    s.video[0].locked = true;
    const items = [{ track: s.video[0], clip: clip(s, 10, 20, 0, 'new') }];
    placeClips(s, items, 'overwrite');
    expect(spans(s)).toEqual([[0, 50]]);
    expect(s.video[0].clips[0]).toBe(keep);
    expect(spans(s, 1)).toEqual([[10, 30]]);
    s.video[1].locked = true;
    placeClips(s, [{ track: s.video[0], clip: clip(s, 10, 20, 0, 'new') }], 'overwrite');
    expect(s.video.length).toBe(3);
    expect(spans(s, 2)).toEqual([[10, 30]]);
  });
});

describe('trimming', () => {
  it('normal trims stop at neighbors and at the media', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 30, 1));
    put(s, clip(s, 40, 30));
    // Only 10 frames free after it
    expect(trimClip(s, a.id, 'tail', 50, 'normal', media)).toBe(10);
    // Only 1 second (30 frames) of media before its in point
    expect(trimClip(s, a.id, 'head', -100, 'normal', media)).toBe(0);
    const b = put(s, clip(s, 200, 30, 1));
    expect(trimClip(s, b.id, 'head', -100, 'normal', media)).toBe(-30);
    expect(b.in).toBeCloseTo(0);
    expect(handles(b, MEDIA, FPS).head).toBe(0);
  });

  it('ripple trims move later clips', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 30));
    put(s, clip(s, 30, 30));
    expect(trimClip(s, a.id, 'tail', -10, 'ripple', media)).toBe(-10);
    expect(spans(s)).toEqual([[0, 20], [20, 50]]);
    // Ripple trimming the head keeps the clip in place and pulls the rest back
    expect(trimClip(s, a.id, 'head', 5, 'ripple', media)).toBe(5);
    expect(spans(s)).toEqual([[0, 15], [15, 45]]);
    expect(a.in).toBeCloseTo(5 / FPS);
  });

  it('a long clip on another track doesn’t block a ripple trim', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 30));
    put(s, clip(s, 30, 30));
    put(s, clip(s, 0, 200), 1);
    expect(trimClip(s, a.id, 'tail', -10, 'ripple', media)).toBe(-10);
    expect(spans(s, 1)).toEqual([[0, 200]]);
  });

  it('rolling moves the cut between two clips', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 30, 0));
    const b = put(s, clip(s, 30, 30, 5));
    expect(trimClip(s, a.id, 'tail', 10, 'roll', media)).toBe(10);
    expect(spans(s)).toEqual([[0, 40], [40, 60]]);
    expect(b.in).toBeCloseTo(5 + 10 / FPS);
  });

  it('slips and slides', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 30, 0));
    const b = put(s, clip(s, 30, 30, 2));
    const c = put(s, clip(s, 60, 30, 2));
    expect(slipClip(s, b.id, 15, media)).toBe(15);
    expect(b.in).toBeCloseTo(2.5);
    expect(slideClip(s, b.id, 10, media)).toBe(10);
    expect(spans(s)).toEqual([[0, 40], [40, 70], [70, 90]]);
    expect(c.in).toBeCloseTo(2 + 10 / FPS);
    expect(a.duration).toBe(40);
  });

  it('rate stretch changes speed, not media', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 60));
    expect(stretchClip(s, a.id, 'tail', 60)).toBe(60);
    expect(a.duration).toBe(120);
    expect(a.speed).toBeCloseTo(0.5);
  });
});

describe('moving', () => {
  it('moves clips with overwrite, or copies them', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 30));
    put(s, clip(s, 40, 30));
    moveClips(s, new Set([a.id]), 50, 0, 0);
    expect(spans(s)).toEqual([[40, 50], [50, 80]]);
    const { clips } = moveClips(s, new Set([a.id]), 0, 1, 0, { copy: true });
    expect(spans(s, 1)).toEqual([[50, 80]]);
    expect(clips[0].id).not.toBe(a.id);
  });

  it('nudges only when there is room', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 30));
    put(s, clip(s, 31, 30));
    expect(nudge(s, new Set([a.id]), 1)).toBe(true);
    expect(nudge(s, new Set([a.id]), 1)).toBe(false);
    expect(nudge(s, new Set([a.id]), -5)).toBe(false);
  });
});

describe('speed, holds and transitions', () => {
  it('speed changes the length and ripples when asked', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 60));
    put(s, clip(s, 60, 30));
    setSpeed(s, a.id, 2, false, true);
    expect(spans(s)).toEqual([[0, 30], [30, 60]]);
    setSpeed(s, a.id, 0.5, false, false);
    // Without ripple it can't grow over the next clip
    expect(spans(s)).toEqual([[0, 30], [30, 60]]);
    expect(a.speed).toBe(0.5);
  });

  it('a faster clip doesn’t pull other tracks into a clip that spans it', () => {
    const s = seq();
    const a = put(s, clip(s, 30, 150), 1);
    put(s, clip(s, 300, 30), 1);
    put(s, clip(s, 0, 360));
    put(s, clip(s, 360, 60));
    setSpeed(s, a.id, 2, false, true);
    // V2 closes up; V1's long clip is in the way, so V1 stays put
    expect(spans(s, 1)).toEqual([[30, 105], [225, 255]]);
    expect(spans(s)).toEqual([[0, 360], [360, 420]]);
  });

  it('frame hold freezes the rest of the clip', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 60, 1));
    const held = addFrameHold(s, a.id, 30)!;
    expect(held.hold).toBeCloseTo(2);
    expect(sourceTimeAt(held, 59, FPS)).toBeCloseTo(2);
    expect(spans(s)).toEqual([[0, 30], [30, 60]]);
  });

  it('a transition between clips is centered on the cut and belongs to the second clip', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 60));
    const b = put(s, clip(s, 60, 60));
    applyTransition(s, a.id, 'out', 'crossDissolve', 20);
    expect(a.transOut).toBeUndefined();
    expect(b.transIn?.align).toBe('center');
    expect(transitionRange(s.video[0], b, 'in')).toEqual([50, 70]);
    // On its own a clip just fades
    const c = put(s, clip(s, 200, 30));
    applyTransition(s, c.id, 'out', 'dipToBlack', 90);
    expect(transitionRange(s.video[0], c, 'out')).toEqual([200, 230]);
  });

  it('clearing a range drops transitions on the cut edges', () => {
    const s = seq();
    const a = put(s, clip(s, 0, 60));
    applyTransition(s, a.id, 'out', 'crossDissolve', 10);
    clearRange(s.video[0], 50, 70, FPS);
    expect(a.transOut).toBeUndefined();
  });
});

describe('jump cuts', () => {
  it('takes ranges out of a clip and its sound, closing the gaps', () => {
    const s = seq();
    const v = put(s, clip(s, 0, 100));
    const a = clipFromMedia(MEDIA, s, { start: 0, duration: 100 }, 'audio');
    v.linkId = 'L';
    a.linkId = 'L';
    s.audio[0].clips.push(a);
    put(s, clip(s, 100, 30, 5, 'after'));
    const removed = removeRanges(s, new Set([v.id]), [[10, 20], [50, 70]]);
    expect(removed).toBe(30);
    expect(spans(s)).toEqual([[0, 10], [10, 40], [40, 70], [70, 100]]);
    expect(s.audio[0].clips.map((c) => [c.start, clipEnd(c)])).toEqual([[0, 10], [10, 40], [40, 70]]);
    // The media keeps its place: the second piece starts where the first cut ended (20 frames in)
    expect(s.video[0].clips[1].in).toBeCloseTo(20 / FPS, 6);
    expect(s.video[0].clips[2].in).toBeCloseTo(70 / FPS, 6);
    // Pieces stay linked to their sound, and the first keeps the clip's id
    expect(s.video[0].clips[0].id).toBe(v.id);
    for (let i = 0; i < 3; i++) expect(s.video[0].clips[i].linkId).toBe(s.audio[0].clips[i].linkId);
    expect(new Set(s.video[0].clips.slice(0, 3).map((c) => c.linkId)).size).toBe(3);
  });

  it('removes a clip that is all cut', () => {
    const s = seq();
    const v = put(s, clip(s, 10, 20));
    put(s, clip(s, 30, 10, 0, 'next'));
    expect(removeRanges(s, new Set([v.id]), [[0, 40]])).toBe(20);
    expect(spans(s)).toEqual([[10, 20]]);
  });
});

describe('cutting at markers', () => {
  it('splits only the clips asked for, at each marker inside them', () => {
    const s = seq();
    const v = put(s, clip(s, 0, 100));
    put(s, clip(s, 0, 100, 0, 'other'), 1);
    s.markers = [10, 50, 150].map((f, i) => ({ id: `m${i}`, f, name: '', color: '#fff' }));
    expect(razorAtMarkers(s, new Set([v.id]))).toBe(2);
    expect(spans(s)).toEqual([[0, 10], [10, 50], [50, 100]]);
    expect(spans(s, 1)).toEqual([[0, 100]]);
  });
});

describe('reframing', () => {
  it('makes a vertical copy where pictures fill the frame and positions follow', () => {
    const s = seq();
    const v = put(s, clip(s, 0, 50));
    v.motion!.x.v = 1440;
    const t = generatedClip('title', s, 0, 50, { title: titleFor(s) });
    put(s, t, 1);
    const r = reframedSequence(s, 1080, 1920, 'S (vertical)');
    expect(r.id).not.toBe(s.id);
    expect([r.width, r.height]).toEqual([1080, 1920]);
    const rv = r.video[0].clips[0];
    expect(rv.id).not.toBe(v.id);
    expect(rv.fit).toBe('fill');
    expect(rv.motion!.x.v).toBeCloseTo(810);
    expect(rv.motion!.y.v).toBeCloseTo(960);
    // The original is untouched
    expect(v.fit).toBe('fit');
    expect(r.video[1].clips[0].title!.size).toBe(t.title!.size);
  });
});
