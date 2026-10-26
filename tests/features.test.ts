import { describe, expect, it } from 'vitest';
import { valueAt } from '../src/core/anim';
import { autoCorrect, histogramDistance } from '../src/core/analysis';
import { PRESETS_BY_ID } from '../src/core/presets';
import { generatedClip, newSequence } from '../src/core/project';

function frame(r: number, g: number, b: number, n = 64): Uint8ClampedArray {
  const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) d.set([r, g, b, 255], i * 4);
  return d;
}

describe('presets', () => {
  it('fade in and out set opacity keyframes at the ends', () => {
    const s = newSequence('S', 1920, 1080, 30, 1, 1);
    const c = generatedClip('color', s, 0, 150);
    PRESETS_BY_ID.get('fadeIn')!.apply(c, s);
    expect(valueAt(c.opacity, 0)).toBe(0);
    expect(valueAt(c.opacity, 30)).toBe(100);
    PRESETS_BY_ID.get('fadeOut')!.apply(c, s);
    expect(valueAt(c.opacity, 119)).toBe(100);
    expect(valueAt(c.opacity, 149)).toBe(0);
  });

  it('picture in picture shrinks the clip into a corner, with a shadow', () => {
    const s = newSequence('S', 1920, 1080, 30, 1, 1);
    const c = generatedClip('color', s, 0, 150);
    PRESETS_BY_ID.get('pipTopRight')!.apply(c, s);
    expect(valueAt(c.motion!.scale, 0)).toBeLessThan(50);
    expect(valueAt(c.motion!.x, 0)).toBeGreaterThan(1920 / 2);
    expect(valueAt(c.motion!.y, 0)).toBeLessThan(1080 / 2);
    expect(c.effects.map((e) => e.type)).toEqual(['dropShadow']);
  });

  it('looks add a Lumetri effect with their settings', () => {
    const s = newSequence('S', 1920, 1080, 30, 1, 1);
    const c = generatedClip('color', s, 0, 150);
    PRESETS_BY_ID.get('warm')!.apply(c, s);
    const e = c.effects[0];
    expect(e.type).toBe('lumetri');
    expect(e.params.temperature).toEqual({ v: 28 });
  });
});

describe('analysis', () => {
  it('sees a cut between different shots but not within one', () => {
    expect(histogramDistance(frame(200, 30, 30), frame(205, 32, 28))).toBeLessThan(0.05);
    expect(histogramDistance(frame(200, 30, 30), frame(20, 30, 200))).toBeGreaterThan(0.9);
  });

  it('auto color brightens a dark frame and cools a warm one', () => {
    const dark = new Uint8Array(frame(40, 40, 40));
    expect(autoCorrect(dark).exposure).toBeGreaterThan(0.5);
    const warm = new Uint8Array(frame(200, 120, 60));
    expect(autoCorrect(warm).temperature).toBeLessThan(0);
  });
});
