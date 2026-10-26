// Effect presets: common jobs done in one go (fades, a slow zoom, picture-in-picture, color looks,
// clearer voices). Each changes a clip like the user would by hand, so everything stays editable.
import { anim, type Anim } from './anim';
import { makeEffect, type Effect } from './effects';
import { defaultMotion, type Clip, type Sequence } from './project';

export interface Preset {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  description: string;
  apply(c: Clip, s: Sequence): void;
}

/** Keyframes from `a` to `b` over the first (or last) `frames` of a clip. */
function ramp(c: Clip, from: number, to: number, frames: number, at: 'start' | 'end' | 'all'): Anim {
  const d = Math.max(1, Math.min(frames, c.duration - 1));
  const end = c.duration - 1;
  if (at === 'all') return { v: from, keys: [{ f: 0, v: from, ease: 'ease' }, { f: end, v: to }] };
  if (at === 'start') return { v: from, keys: [{ f: 0, v: from, ease: 'ease' }, { f: d, v: to }] };
  return { v: from, keys: [{ f: end - d, v: from, ease: 'ease' }, { f: end, v: to }] };
}

function withEffect(c: Clip, type: string, params: Record<string, number | string | boolean> = {}): Effect {
  const e = makeEffect(type);
  for (const [k, v] of Object.entries(params)) e.params[k] = typeof v === 'number' ? anim(v) : v;
  c.effects.push(e);
  return e;
}

const second = (s: Sequence) => Math.round(s.fps);

export const PRESETS: Preset[] = [
  {
    id: 'fadeIn',
    name: 'Fade in',
    kind: 'video',
    description: 'The clip fades up from transparent over a second.',
    apply: (c, s) => {
      c.opacity = ramp(c, 0, 100, second(s), 'start');
    },
  },
  {
    id: 'fadeOut',
    name: 'Fade out',
    kind: 'video',
    description: 'The clip fades away over its last second.',
    apply: (c, s) => {
      c.opacity = ramp(c, 100, 0, second(s), 'end');
    },
  },
  {
    id: 'kenBurns',
    name: 'Slow zoom (Ken Burns)',
    kind: 'video',
    description: 'A gentle zoom across the whole clip — brings photos to life.',
    apply: (c, s) => {
      c.motion ??= defaultMotion(s);
      c.motion.scale = ramp(c, 100, 118, c.duration, 'all');
      c.motion.x = ramp(c, s.width / 2, s.width / 2 - s.width * 0.03, c.duration, 'all');
    },
  },
  {
    id: 'punchIn',
    name: 'Punch in',
    kind: 'video',
    description: 'Zooms in 30% (a quick reframe, or a second "camera" from one shot).',
    apply: (c, s) => {
      c.motion ??= defaultMotion(s);
      c.motion.scale = anim(130);
    },
  },
  {
    id: 'pipTopRight',
    name: 'Picture in picture: top right',
    kind: 'video',
    description: 'A small picture in the corner, with a soft shadow.',
    apply: (c, s) => {
      c.motion = { ...defaultMotion(s), scale: anim(32), x: anim(s.width * 0.79), y: anim(s.height * 0.22) };
      withEffect(c, 'dropShadow', { opacity: 55, distance: 8, softness: 18 });
    },
  },
  {
    id: 'pipBottomLeft',
    name: 'Picture in picture: bottom left',
    kind: 'video',
    description: 'A small picture in the corner, with a soft shadow.',
    apply: (c, s) => {
      c.motion = { ...defaultMotion(s), scale: anim(32), x: anim(s.width * 0.21), y: anim(s.height * 0.78) };
      withEffect(c, 'dropShadow', { opacity: 55, distance: 8, softness: 18 });
    },
  },
  {
    id: 'warm',
    name: 'Look: warm',
    kind: 'video',
    description: 'Golden, sunny color.',
    apply: (c) => void withEffect(c, 'lumetri', { temperature: 28, tint: 4, saturation: 112, contrast: 8 }),
  },
  {
    id: 'cool',
    name: 'Look: cool',
    kind: 'video',
    description: 'Blue, crisp color.',
    apply: (c) => void withEffect(c, 'lumetri', { temperature: -26, saturation: 105, contrast: 12, highlights: -10 }),
  },
  {
    id: 'cinematic',
    name: 'Look: cinematic',
    kind: 'video',
    description: 'Deeper contrast, softer highlights, a slight vignette.',
    apply: (c) => void withEffect(c, 'lumetri', { contrast: 22, highlights: -25, shadows: -8, saturation: 90, vibrance: 15, vignette: -0.8, faded: 6 }),
  },
  {
    id: 'vintage',
    name: 'Look: vintage',
    kind: 'video',
    description: 'Faded, warm and grainy.',
    apply: (c) => {
      withEffect(c, 'lumetri', { faded: 45, temperature: 18, saturation: 80, contrast: -10, vignette: -1.2 });
      withEffect(c, 'noise', { amount: 12 });
    },
  },
  {
    id: 'noir',
    name: 'Look: black & white',
    kind: 'video',
    description: 'Black and white with punch.',
    apply: (c) => {
      withEffect(c, 'blackWhite');
      withEffect(c, 'brightness', { contrast: 25 });
    },
  },
  {
    id: 'greenScreen',
    name: 'Green screen',
    kind: 'video',
    description: 'Ultra Key set up for a green screen; put the background on the track below.',
    apply: (c) => void withEffect(c, 'ultraKey'),
  },
  {
    id: 'blurFace',
    name: 'Blur part of the picture',
    kind: 'video',
    description: 'Put it on a copy of the clip (or an adjustment layer) above the clip: a blurred oval to move over a face or a sign under Mask.',
    apply: (c) => {
      withEffect(c, 'gaussianBlur', { blurriness: 60 });
      withEffect(c, 'mask', { width: 22, height: 30, feather: 20 });
    },
  },
  {
    id: 'voice',
    name: 'Clearer voice',
    kind: 'audio',
    description: 'Removes rumble, lifts speech and evens out the level.',
    apply: (c) => {
      withEffect(c, 'highpass', { frequency: 90 });
      withEffect(c, 'eq', { low: -2, mid: 3, high: 2 });
      withEffect(c, 'compressor', { threshold: -22, ratio: 3, makeup: 4 });
    },
  },
  {
    id: 'phone',
    name: 'Telephone voice',
    kind: 'audio',
    description: 'Thin and small, like a phone call.',
    apply: (c) => {
      withEffect(c, 'highpass', { frequency: 400 });
      withEffect(c, 'lowpass', { frequency: 3200 });
      withEffect(c, 'gain', { gain: 4 });
    },
  },
  {
    id: 'audioFadeIn',
    name: 'Fade sound in',
    kind: 'audio',
    description: 'The sound rises from silence over a second.',
    apply: (c, s) => {
      c.volume = ramp(c, -60, 0, second(s), 'start');
    },
  },
  {
    id: 'audioFadeOut',
    name: 'Fade sound out',
    kind: 'audio',
    description: 'The sound falls to silence over its last two seconds.',
    apply: (c, s) => {
      c.volume = ramp(c, 0, -60, second(s) * 2, 'end');
    },
  },
];

export const PRESETS_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
