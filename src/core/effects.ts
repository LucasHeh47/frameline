// Every effect and transition: their names, groups and settings. The renderer (src/render) and the
// audio graph (src/media/audioGraph.ts) implement them; the panels build their controls from these.
import { anim, valueAt, type Anim } from './anim';

export type ParamType = 'number' | 'color' | 'select' | 'bool' | 'file';

export interface ParamDef {
  id: string;
  label: string;
  type: ParamType;
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: [string, string][];
  /** Lumetri's sections. */
  group?: string;
  /** File dialog kind for 'file' settings. */
  accept?: 'lut';
}

export interface EffectDef {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  category: string;
  description: string;
  params: ParamDef[];
  keywords?: string;
}

export type ParamValue = Anim | string | boolean;

/** An effect on a clip. */
export interface Effect {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, ParamValue>;
}

const num = (id: string, label: string, def: number, min: number, max: number, extra: Partial<ParamDef> = {}): ParamDef => ({ id, label, type: 'number', default: def, min, max, step: extra.step ?? (max - min > 20 ? 1 : 0.1), ...extra });
const color = (id: string, label: string, def: string, extra: Partial<ParamDef> = {}): ParamDef => ({ id, label, type: 'color', default: def, ...extra });
const bool = (id: string, label: string, def: boolean): ParamDef => ({ id, label, type: 'bool', default: def });
const select = (id: string, label: string, def: string, options: [string, string][]): ParamDef => ({ id, label, type: 'select', default: def, options });

const DIRECTIONS: [string, string][] = [
  ['left', 'From the right'],
  ['right', 'From the left'],
  ['up', 'From below'],
  ['down', 'From above'],
];

export const EFFECTS: EffectDef[] = [
  // ---------- video: color ----------
  {
    id: 'lumetri',
    name: 'Lumetri Color',
    kind: 'video',
    category: 'Color',
    description: 'White balance, exposure, contrast, highlights and shadows, saturation, a look (LUT) and a vignette.',
    keywords: 'color correction grade grading lut white balance exposure',
    params: [
      num('temperature', 'Temperature', 0, -100, 100, { group: 'Basic correction' }),
      num('tint', 'Tint', 0, -100, 100, { group: 'Basic correction' }),
      num('exposure', 'Exposure', 0, -4, 4, { step: 0.05, group: 'Basic correction' }),
      num('contrast', 'Contrast', 0, -100, 100, { group: 'Basic correction' }),
      num('highlights', 'Highlights', 0, -100, 100, { group: 'Basic correction' }),
      num('shadows', 'Shadows', 0, -100, 100, { group: 'Basic correction' }),
      num('whites', 'Whites', 0, -100, 100, { group: 'Basic correction' }),
      num('blacks', 'Blacks', 0, -100, 100, { group: 'Basic correction' }),
      num('saturation', 'Saturation', 100, 0, 200, { unit: '%', group: 'Basic correction' }),
      { id: 'lut', label: 'Look (LUT)', type: 'file', default: '', accept: 'lut', group: 'Creative' },
      num('lutAmount', 'Look intensity', 100, 0, 100, { unit: '%', group: 'Creative' }),
      num('faded', 'Faded film', 0, 0, 100, { group: 'Creative' }),
      num('vibrance', 'Vibrance', 0, -100, 100, { group: 'Creative' }),
      num('vignette', 'Vignette amount', 0, -3, 3, { step: 0.05, group: 'Vignette' }),
      num('vigMidpoint', 'Midpoint', 50, 0, 100, { group: 'Vignette' }),
      num('vigRoundness', 'Roundness', 0, -100, 100, { group: 'Vignette' }),
      num('vigFeather', 'Feather', 50, 0, 100, { group: 'Vignette' }),
    ],
  },
  {
    id: 'brightness',
    name: 'Brightness & Contrast',
    kind: 'video',
    category: 'Color',
    description: 'Makes the picture lighter or darker, and flatter or punchier.',
    params: [num('brightness', 'Brightness', 0, -100, 100), num('contrast', 'Contrast', 0, -100, 100)],
  },
  {
    id: 'hsl',
    name: 'Hue / Saturation',
    kind: 'video',
    category: 'Color',
    description: 'Shifts every color around the color wheel, and changes how colorful and light the picture is.',
    params: [num('hue', 'Hue', 0, -180, 180, { unit: '°' }), num('saturation', 'Saturation', 0, -100, 100), num('lightness', 'Lightness', 0, -100, 100)],
  },
  { id: 'blackWhite', name: 'Black & White', kind: 'video', category: 'Color', description: 'Removes the color.', keywords: 'grayscale monochrome', params: [num('amount', 'Amount', 100, 0, 100, { unit: '%' })] },
  { id: 'sepia', name: 'Sepia', kind: 'video', category: 'Color', description: 'An old-photo brown tone.', params: [num('amount', 'Amount', 100, 0, 100, { unit: '%' })] },
  {
    id: 'tint',
    name: 'Tint',
    kind: 'video',
    category: 'Color',
    description: 'Maps dark and light parts of the picture to two colors (a duotone).',
    keywords: 'duotone colorize',
    params: [color('black', 'Map black to', '#1b1446'), color('white', 'Map white to', '#ffd8a8'), num('amount', 'Amount', 100, 0, 100, { unit: '%' })],
  },
  { id: 'invert', name: 'Invert', kind: 'video', category: 'Color', description: 'A negative of the picture.', params: [num('amount', 'Amount', 100, 0, 100, { unit: '%' })] },
  { id: 'posterize', name: 'Posterize', kind: 'video', category: 'Stylize', description: 'Fewer shades of each color, like a poster print.', params: [num('levels', 'Levels', 6, 2, 32)] },

  // ---------- video: blur & sharpen ----------
  {
    id: 'gaussianBlur',
    name: 'Gaussian Blur',
    kind: 'video',
    category: 'Blur & Sharpen',
    description: 'A soft blur. Combine it with a mask to blur a face or a license plate.',
    params: [num('blurriness', 'Blurriness', 20, 0, 200, { unit: 'px' }), select('dimension', 'Direction', 'both', [['both', 'Both'], ['h', 'Horizontal'], ['v', 'Vertical']])],
  },
  { id: 'sharpen', name: 'Sharpen', kind: 'video', category: 'Blur & Sharpen', description: 'Makes edges crisper.', params: [num('amount', 'Amount', 50, 0, 200)] },
  {
    id: 'glow',
    name: 'Glow',
    kind: 'video',
    category: 'Stylize',
    description: 'Bright parts of the picture glow softly.',
    keywords: 'bloom',
    params: [num('threshold', 'Threshold', 60, 0, 100, { unit: '%' }), num('radius', 'Radius', 20, 0, 100, { unit: 'px' }), num('intensity', 'Intensity', 100, 0, 300, { unit: '%' })],
  },

  // ---------- video: keying ----------
  {
    id: 'ultraKey',
    name: 'Ultra Key',
    kind: 'video',
    category: 'Keying',
    description: 'Makes a green or blue screen see-through so the track below shows.',
    keywords: 'chroma key green screen blue screen',
    params: [
      color('color', 'Key color', '#00b140'),
      num('tolerance', 'Tolerance', 30, 0, 100),
      num('softness', 'Softness', 15, 0, 100),
      num('spill', 'Spill suppression', 50, 0, 100),
      num('choke', 'Choke', 0, 0, 100),
    ],
  },
  {
    id: 'lumaKey',
    name: 'Luma Key',
    kind: 'video',
    category: 'Keying',
    description: 'Makes dark (or light) parts see-through.',
    params: [num('threshold', 'Threshold', 15, 0, 100, { unit: '%' }), num('softness', 'Softness', 10, 0, 100), bool('invert', 'Key out light parts', false)],
  },

  // ---------- video: transform ----------
  {
    id: 'crop',
    name: 'Crop',
    kind: 'video',
    category: 'Transform',
    description: 'Trims the edges of the picture.',
    params: [
      num('left', 'Left', 0, 0, 100, { unit: '%' }),
      num('top', 'Top', 0, 0, 100, { unit: '%' }),
      num('right', 'Right', 0, 0, 100, { unit: '%' }),
      num('bottom', 'Bottom', 0, 0, 100, { unit: '%' }),
      num('feather', 'Edge feather', 0, 0, 200, { unit: 'px' }),
    ],
  },
  { id: 'flip', name: 'Flip', kind: 'video', category: 'Transform', description: 'Mirrors the picture.', keywords: 'mirror horizontal vertical', params: [bool('horizontal', 'Horizontal', true), bool('vertical', 'Vertical', false)] },
  {
    id: 'mask',
    name: 'Mask',
    kind: 'video',
    category: 'Transform',
    description: 'Shows only part of the clip (a rectangle or an ellipse), with a soft edge. Invert it to hide that part.',
    keywords: 'opacity mask shape spotlight',
    params: [
      select('shape', 'Shape', 'ellipse', [['ellipse', 'Ellipse'], ['rectangle', 'Rectangle']]),
      num('x', 'Center X', 50, -50, 150, { unit: '%' }),
      num('y', 'Center Y', 50, -50, 150, { unit: '%' }),
      num('width', 'Width', 40, 0, 200, { unit: '%' }),
      num('height', 'Height', 40, 0, 200, { unit: '%' }),
      num('feather', 'Feather', 10, 0, 100),
      bool('invert', 'Inverted', false),
    ],
  },
  {
    id: 'dropShadow',
    name: 'Drop Shadow',
    kind: 'video',
    category: 'Stylize',
    description: 'A soft shadow behind the clip. Good for titles and picture-in-picture.',
    params: [color('color', 'Color', '#000000'), num('opacity', 'Opacity', 60, 0, 100, { unit: '%' }), num('direction', 'Direction', 135, 0, 360, { unit: '°' }), num('distance', 'Distance', 12, 0, 200, { unit: 'px' }), num('softness', 'Softness', 16, 0, 100, { unit: 'px' })],
  },
  { id: 'mosaic', name: 'Mosaic', kind: 'video', category: 'Stylize', description: 'Big square blocks, to hide something.', keywords: 'pixelate censor', params: [num('blocks', 'Blocks across', 40, 2, 400)] },
  {
    id: 'noise',
    name: 'Film Grain',
    kind: 'video',
    category: 'Stylize',
    description: 'Moving grain, like film.',
    keywords: 'noise',
    params: [num('amount', 'Amount', 20, 0, 100), bool('color', 'Colored grain', false)],
  },

  // ---------- audio ----------
  { id: 'gain', name: 'Amplify', kind: 'audio', category: 'Amplitude', description: 'Makes the clip louder or quieter.', keywords: 'gain volume', params: [num('gain', 'Gain', 0, -24, 24, { step: 0.1, unit: 'dB' })] },
  {
    id: 'eq',
    name: 'Simple EQ',
    kind: 'audio',
    category: 'Filter & EQ',
    description: 'Bass, middle and treble.',
    keywords: 'equalizer bass treble',
    params: [num('low', 'Low (bass)', 0, -24, 24, { step: 0.1, unit: 'dB' }), num('mid', 'Mid', 0, -24, 24, { step: 0.1, unit: 'dB' }), num('high', 'High (treble)', 0, -24, 24, { step: 0.1, unit: 'dB' })],
  },
  { id: 'highpass', name: 'Highpass', kind: 'audio', category: 'Filter & EQ', description: 'Removes rumble and low hum.', keywords: 'low cut', params: [num('frequency', 'Cutoff', 100, 20, 2000, { unit: 'Hz' })] },
  { id: 'lowpass', name: 'Lowpass', kind: 'audio', category: 'Filter & EQ', description: 'Removes hiss and harsh highs; sounds muffled.', keywords: 'high cut muffle', params: [num('frequency', 'Cutoff', 6000, 200, 20000, { unit: 'Hz' })] },
  {
    id: 'compressor',
    name: 'Dynamics',
    kind: 'audio',
    category: 'Amplitude',
    description: 'Evens out loud and quiet parts.',
    keywords: 'compressor limiter',
    params: [num('threshold', 'Threshold', -24, -60, 0, { unit: 'dB' }), num('ratio', 'Ratio', 4, 1, 20, { step: 0.1 }), num('attack', 'Attack', 3, 0, 100, { unit: 'ms' }), num('release', 'Release', 250, 10, 1000, { unit: 'ms' }), num('makeup', 'Make-up gain', 0, 0, 24, { step: 0.1, unit: 'dB' })],
  },
  {
    id: 'reverb',
    name: 'Studio Reverb',
    kind: 'audio',
    category: 'Reverb & Delay',
    description: 'Places the sound in a room or hall.',
    keywords: 'echo room',
    params: [num('decay', 'Decay', 2, 0.2, 10, { step: 0.1, unit: 's' }), num('mix', 'Mix', 25, 0, 100, { unit: '%' })],
  },
  {
    id: 'delay',
    name: 'Delay',
    kind: 'audio',
    category: 'Reverb & Delay',
    description: 'Repeats the sound, fading away.',
    keywords: 'echo',
    params: [num('time', 'Delay', 300, 10, 2000, { unit: 'ms' }), num('feedback', 'Feedback', 35, 0, 90, { unit: '%' }), num('mix', 'Mix', 30, 0, 100, { unit: '%' })],
  },
  {
    id: 'channels',
    name: 'Channels',
    kind: 'audio',
    category: 'Channels',
    description: 'Fixes audio that is only on one side, or swaps the sides.',
    keywords: 'fill left right mono stereo swap',
    params: [select('mode', 'Channels', 'left', [['left', 'Left on both sides'], ['right', 'Right on both sides'], ['mono', 'Mono (mix both)'], ['swap', 'Swap left and right']])],
  },
];

export const EFFECTS_BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));

// ---------- transitions ----------

export interface TransitionDef {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  category: string;
  description: string;
  params: ParamDef[];
}

export const TRANSITIONS: TransitionDef[] = [
  { id: 'crossDissolve', name: 'Cross Dissolve', kind: 'video', category: 'Dissolve', description: 'One clip fades into the next.', params: [] },
  { id: 'dipToBlack', name: 'Dip to Black', kind: 'video', category: 'Dissolve', description: 'Fades to black, then up into the next clip.', params: [] },
  { id: 'dipToWhite', name: 'Dip to White', kind: 'video', category: 'Dissolve', description: 'Fades to white, then into the next clip.', params: [] },
  { id: 'blurDissolve', name: 'Blur Dissolve', kind: 'video', category: 'Dissolve', description: 'Blurs out of one clip and into the next.', params: [] },
  { id: 'wipe', name: 'Wipe', kind: 'video', category: 'Wipe', description: 'A straight edge reveals the next clip.', params: [select('direction', 'Direction', 'left', DIRECTIONS), num('softness', 'Edge softness', 5, 0, 50, { unit: '%' })] },
  { id: 'iris', name: 'Iris Round', kind: 'video', category: 'Wipe', description: 'A growing circle reveals the next clip.', params: [num('softness', 'Edge softness', 3, 0, 50, { unit: '%' })] },
  { id: 'slide', name: 'Slide', kind: 'video', category: 'Slide', description: 'The next clip slides in over the first one.', params: [select('direction', 'Direction', 'left', DIRECTIONS)] },
  { id: 'push', name: 'Push', kind: 'video', category: 'Slide', description: 'The next clip pushes the first one out.', params: [select('direction', 'Direction', 'left', DIRECTIONS)] },
  { id: 'zoom', name: 'Cross Zoom', kind: 'video', category: 'Zoom', description: 'Zooms into the first clip and out of the next.', params: [] },
  { id: 'constantPower', name: 'Constant Power', kind: 'audio', category: 'Crossfade', description: 'A smooth crossfade that keeps the loudness steady. The usual choice.', params: [] },
  { id: 'constantGain', name: 'Constant Gain', kind: 'audio', category: 'Crossfade', description: 'A straight crossfade; can dip a little in the middle.', params: [] },
  { id: 'exponentialFade', name: 'Exponential Fade', kind: 'audio', category: 'Crossfade', description: 'Fades out quickly and in slowly; good for fading to silence.', params: [] },
];

export const TRANSITIONS_BY_ID = new Map(TRANSITIONS.map((t) => [t.id, t]));

// ---------- making and reading effects ----------

let effectSeq = 0;
const newId = () => `fx${Date.now().toString(36)}${(effectSeq++).toString(36)}`;

export function defaultParams(params: ParamDef[]): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of params) out[p.id] = p.type === 'number' ? anim(p.default as number) : (p.default as string | boolean);
  return out;
}

export function makeEffect(type: string): Effect {
  const def = EFFECTS_BY_ID.get(type);
  if (!def) throw new Error(`Unknown effect ${type}`);
  return { id: newId(), type, enabled: true, params: defaultParams(def.params) };
}

/** A number setting at a frame of the clip (its default when it isn't set). */
export function numParam(e: { type: string; params: Record<string, ParamValue> }, id: string, f: number): number {
  const v = e.params[id];
  if (v && typeof v === 'object') return valueAt(v, f);
  const def = (EFFECTS_BY_ID.get(e.type)?.params ?? TRANSITIONS_BY_ID.get(e.type)?.params)?.find((p) => p.id === id);
  return typeof def?.default === 'number' ? def.default : 0;
}

export function strParam(e: { type: string; params: Record<string, ParamValue> }, id: string): string {
  const v = e.params[id];
  if (typeof v === 'string') return v;
  const def = (EFFECTS_BY_ID.get(e.type)?.params ?? TRANSITIONS_BY_ID.get(e.type)?.params)?.find((p) => p.id === id);
  return typeof def?.default === 'string' ? def.default : '';
}

export function boolParam(e: { type: string; params: Record<string, ParamValue> }, id: string): boolean {
  const v = e.params[id];
  if (typeof v === 'boolean') return v;
  const def = EFFECTS_BY_ID.get(e.type)?.params.find((p) => p.id === id);
  return def?.default === true;
}

/** An effect whose settings are all at their defaults does nothing (the renderer skips it). */
export function isNeutral(e: Effect): boolean {
  if (!e.enabled) return true;
  if (e.type !== 'lumetri' && e.type !== 'brightness' && e.type !== 'hsl') return false;
  const def = EFFECTS_BY_ID.get(e.type)!;
  return def.params.every((p) => {
    const v = e.params[p.id];
    if (p.type === 'number') return typeof v === 'object' && !v.keys?.length && v.v === p.default;
    return v === p.default || (p.type === 'file' && !v);
  });
}
