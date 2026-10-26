import { describe, expect, it } from 'vitest';
import { addKey, removeKey, setAnimated, setValue, valueAt, type Anim } from '../src/core/anim';
import { parseCaptions, writeSrt, writeVtt } from '../src/core/captions';
import { applyTransition } from '../src/core/edit';
import { History } from '../src/core/history';
import { applyLut, parseCube } from '../src/core/lut';
import { clipFromMedia, newProject, newSequence, readProject, writeProject, type MediaItem } from '../src/core/project';
import { parseTimecode, shortDuration, timecode } from '../src/core/time';
import { audioAt, fadeCurve, snapShift, videoAt } from '../src/core/timeline';

const MEDIA: MediaItem = { id: 'm1', kind: 'video', name: 'a.mp4', path: 'a.mp4', duration: 10, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000 };

describe('time', () => {
  it('formats and reads timecode', () => {
    expect(timecode(0, 30)).toBe('00:00:00:00');
    expect(timecode(30 * 3661 + 7, 30)).toBe('01:01:01:07');
    expect(timecode(30, 29.97)).toBe('00:00:01:00');
    expect(parseTimecode('1:00', 30)).toBe(30);
    expect(parseTimecode('01:00:00:00', 30)).toBe(108000);
    expect(parseTimecode('+15', 30, 100)).toBe(115);
    expect(parseTimecode('-1:00', 30, 100)).toBe(70);
    expect(parseTimecode('2.5s', 30)).toBe(75);
    expect(parseTimecode('nope', 30)).toBeNull();
    expect(shortDuration(45, 30)).toBe('1.5s');
    expect(shortDuration(30 * 75, 30)).toBe('1:15');
  });
});

describe('keyframes', () => {
  it('interpolates, holds and eases', () => {
    const a: Anim = { v: 0 };
    setAnimated(a, true, 0);
    setValue(a, 10, 100);
    expect(valueAt(a, 5)).toBeCloseTo(50);
    expect(valueAt(a, -3)).toBe(0);
    expect(valueAt(a, 20)).toBe(100);
    a.keys![0].ease = 'hold';
    expect(valueAt(a, 9)).toBe(0);
    a.keys![0].ease = 'ease';
    expect(valueAt(a, 2)).toBeLessThan(20);
    addKey(a, 5);
    expect(a.keys).toHaveLength(3);
    removeKey(a, 5);
    removeKey(a, 0);
    removeKey(a, 10);
    expect(a.keys).toBeUndefined();
    expect(a.v).toBe(100);
  });
});

describe('what plays at a frame', () => {
  it('shows a clip with its media time, and transitions between clips', () => {
    const s = newSequence('S', 1920, 1080, 30, 2, 2);
    const a = clipFromMedia(MEDIA, s, { start: 0, duration: 60 }, 'video');
    const b = clipFromMedia(MEDIA, s, { start: 60, duration: 60 }, 'video');
    b.in = 2;
    s.video[0].clips.push(a, b);
    let layers = videoAt(s, 30, () => MEDIA);
    expect(layers).toHaveLength(1);
    expect(layers[0].a?.clip).toBe(a);
    expect(layers[0].a?.time).toBeCloseTo(1);
    applyTransition(s, b.id, 'in', 'crossDissolve', 20);
    layers = videoAt(s, 55, () => MEDIA);
    expect(layers[0].transition?.type).toBe('crossDissolve');
    expect(layers[0].a?.clip).toBe(a);
    expect(layers[0].b?.clip).toBe(b);
    // b plays from before its in point during the transition
    expect(layers[0].b?.time).toBeCloseTo(2 - 5 / 30);
    expect(layers[0].transition!.progress).toBeCloseTo(5.5 / 20);
    // Past the transition only b
    expect(videoAt(s, 70)[0].transition).toBeUndefined();
  });

  it('hidden and soloed tracks', () => {
    const s = newSequence('S', 1920, 1080, 30, 2, 0);
    s.video[0].clips.push(clipFromMedia(MEDIA, s, { start: 0, duration: 60 }, 'video'));
    s.video[1].clips.push(clipFromMedia(MEDIA, s, { start: 0, duration: 60 }, 'video'));
    expect(videoAt(s, 10)).toHaveLength(2);
    s.video[1].muted = true;
    expect(videoAt(s, 10)).toHaveLength(1);
    s.video[1].muted = false;
    s.video[1].solo = true;
    expect(videoAt(s, 10).map((l) => l.track)).toEqual([s.video[1]]);
  });

  it('audio crossfades', () => {
    const s = newSequence('S', 1920, 1080, 30, 0, 1);
    const a = clipFromMedia(MEDIA, s, { start: 0, duration: 60 }, 'audio');
    const b = clipFromMedia(MEDIA, s, { start: 60, duration: 60 }, 'audio');
    s.audio[0].clips.push(a, b);
    applyTransition(s, b.id, 'in', 'constantPower', 30);
    const voices = audioAt(s, 60);
    expect(voices.map((v) => v.clip)).toEqual([a, b]);
    const [va, vb] = voices;
    // Constant power keeps the sum of squares at 1
    expect(va.fade ** 2 + vb.fade ** 2).toBeCloseTo(1);
    expect(fadeCurve('constantGain', 0.25, 'in')).toBeCloseTo(0.25);
  });

  it('snaps to the nearest point', () => {
    expect(snapShift([0, 100, 200], [97, 140], 5)).toEqual({ shift: 3, at: 100 });
    expect(snapShift([0, 100], [50], 5)).toBeNull();
  });
});

describe('saving, history, captions and LUTs', () => {
  it('reads back a saved project', () => {
    const p = newProject('Test');
    p.media.push(MEDIA);
    const back = readProject(writeProject(p));
    expect(back.sequences[0].video).toHaveLength(3);
    expect(back.media[0].path).toBe('a.mp4');
    expect(() => readProject('{"app":"other"}')).toThrow();
  });

  it('undoes and redoes, and knows when it is saved', () => {
    const h = new History<number>();
    let v = 1;
    h.markSaved();
    h.record('a', v);
    v = 2;
    expect(h.dirty).toBe(true);
    v = h.undo(v)!;
    expect(v).toBe(1);
    expect(h.dirty).toBe(false);
    v = h.redo(v)!;
    expect(v).toBe(2);
    expect(h.steps()).toEqual([{ label: 'a', done: true }]);
  });

  it('reads and writes subtitles', () => {
    const cues = parseCaptions('1\n00:00:01,000 --> 00:00:02,500\n<i>Hello</i>\n\n2\n00:00:03.000 --> 00:00:04.000 align:start\nTwo\nlines\n');
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: 'Hello' },
      { start: 3, end: 4, text: 'Two\nlines' },
    ]);
    expect(writeSrt(cues)).toContain('00:00:02,500');
    expect(writeVtt(cues)).toMatch(/^WEBVTT/);
    expect(parseCaptions(writeSrt(cues))).toEqual(cues);
  });

  it('reads a .cube LUT', () => {
    const lines = ['TITLE "Invert"', 'LUT_3D_SIZE 2'];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${1 - r} ${1 - g} ${1 - b}`);
    const lut = parseCube(lines.join('\n'));
    expect(lut.title).toBe('Invert');
    const out = applyLut(lut, 0.25, 0.5, 1);
    expect(out[0]).toBeCloseTo(0.75);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(0);
  });
});
