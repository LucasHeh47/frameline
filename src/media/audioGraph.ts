// Audio effects as Web Audio nodes. The same chain plays live and renders the export, so the
// exported sound matches what you hear while editing.
import { valueAt } from '../core/anim';
import { numParam, strParam, type Effect } from '../core/effects';
import { dbToGain } from '../core/timeline';

export interface FxChain {
  input: AudioNode;
  output: AudioNode;
  /** Sets the settings for a frame of the clip (live playback). */
  update(local: number): void;
  /** Schedules keyframed settings over frames of the clip (export): `at(local)` gives the context time. */
  automate(at: (local: number) => number, from: number, to: number): void;
  dispose(): void;
}

/** An impulse response for a room: decaying noise, a little different on each side. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.round(ctx.sampleRate * Math.min(10, Math.max(0.1, seconds))));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let seed = c ? 0x2545f491 : 0x9e3779b9;
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = ((seed >>> 0) / 4294967296) * 2 - 1;
      d[i] = noise * Math.pow(1 - i / len, 3);
    }
  }
  return buf;
}

interface Param {
  param: AudioParam;
  map: (local: number) => number;
  animated: boolean;
  last?: number;
}

/** A chain of the clip's enabled audio effects (or a plain pass-through). */
export function buildChain(ctx: BaseAudioContext, effects: Effect[]): FxChain {
  const input = ctx.createGain();
  let last: AudioNode = input;
  const params: Param[] = [];
  const nodes: AudioNode[] = [input];
  const node = <T extends AudioNode>(n: T) => {
    nodes.push(n);
    return n;
  };
  const watch = (e: Effect, param: AudioParam, id: string, conv: (v: number) => number = (v) => v) => {
    const raw = e.params[id];
    const animated = typeof raw === 'object' && !!raw.keys?.length;
    params.push({ param, map: (f) => conv(numParam(e, id, f)), animated });
    param.value = conv(numParam(e, id, 0));
  };
  /** Dry and wet mixed: `wet` is the processed path from `last`. */
  const mixWet = (e: Effect, wetIn: AudioNode, wetOut: AudioNode) => {
    const dry = node(ctx.createGain());
    const wet = node(ctx.createGain());
    const out = node(ctx.createGain());
    last.connect(dry);
    last.connect(wetIn);
    wetOut.connect(wet);
    dry.connect(out);
    wet.connect(out);
    params.push({ param: wet.gain, map: (f) => numParam(e, 'mix', f) / 100, animated: false });
    params.push({ param: dry.gain, map: (f) => 1 - (numParam(e, 'mix', f) / 100) * 0.5, animated: false });
    wet.gain.value = numParam(e, 'mix', 0) / 100;
    dry.gain.value = 1 - (numParam(e, 'mix', 0) / 100) * 0.5;
    last = out;
  };
  for (const e of effects) {
    if (!e.enabled) continue;
    switch (e.type) {
      case 'gain': {
        const g = node(ctx.createGain());
        watch(e, g.gain, 'gain', dbToGain);
        last.connect(g);
        last = g;
        break;
      }
      case 'eq': {
        const bands: [BiquadFilterType, number, string][] = [
          ['lowshelf', 120, 'low'],
          ['peaking', 1000, 'mid'],
          ['highshelf', 6000, 'high'],
        ];
        for (const [type, freq, id] of bands) {
          const b = node(ctx.createBiquadFilter());
          b.type = type;
          b.frequency.value = freq;
          b.Q.value = 0.8;
          watch(e, b.gain, id);
          last.connect(b);
          last = b;
        }
        break;
      }
      case 'highpass':
      case 'lowpass': {
        const b = node(ctx.createBiquadFilter());
        b.type = e.type;
        b.Q.value = 0.707;
        watch(e, b.frequency, 'frequency');
        last.connect(b);
        last = b;
        break;
      }
      case 'compressor': {
        const c = node(ctx.createDynamicsCompressor());
        watch(e, c.threshold, 'threshold');
        watch(e, c.ratio, 'ratio');
        watch(e, c.attack, 'attack', (v) => v / 1000);
        watch(e, c.release, 'release', (v) => v / 1000);
        c.knee.value = 6;
        const makeup = node(ctx.createGain());
        watch(e, makeup.gain, 'makeup', dbToGain);
        last.connect(c);
        c.connect(makeup);
        last = makeup;
        break;
      }
      case 'reverb': {
        const conv = node(ctx.createConvolver());
        conv.buffer = impulse(ctx, numParam(e, 'decay', 0));
        mixWet(e, conv, conv);
        break;
      }
      case 'delay': {
        const d = node(ctx.createDelay(2.5));
        const fb = node(ctx.createGain());
        watch(e, d.delayTime, 'time', (v) => v / 1000);
        watch(e, fb.gain, 'feedback', (v) => Math.min(0.95, v / 100));
        d.connect(fb);
        fb.connect(d);
        mixWet(e, d, d);
        break;
      }
      case 'channels': {
        const split = node(ctx.createChannelSplitter(2));
        const merge = node(ctx.createChannelMerger(2));
        last.connect(split);
        const mode = strParam(e, 'mode');
        if (mode === 'left' || mode === 'right') {
          const src = mode === 'left' ? 0 : 1;
          split.connect(merge, src, 0);
          split.connect(merge, src, 1);
        } else if (mode === 'swap') {
          split.connect(merge, 0, 1);
          split.connect(merge, 1, 0);
        } else {
          const half = node(ctx.createGain());
          half.gain.value = 0.5;
          split.connect(half, 0);
          split.connect(half, 1);
          half.connect(merge, 0, 0);
          half.connect(merge, 0, 1);
        }
        last = merge;
        break;
      }
    }
  }
  return {
    input,
    output: last,
    update(local) {
      // Every setting, so changes made while playing are heard right away
      for (const p of params) {
        const v = p.map(local);
        if (v === p.last) continue;
        p.last = v;
        p.param.setTargetAtTime(v, ctx.currentTime, 0.02);
      }
    },
    automate(at, from, to) {
      for (const p of params) {
        if (!p.animated) continue;
        p.param.setValueAtTime(p.map(from), Math.max(0, at(from)));
        for (let f = from + 1; f <= to; f++) p.param.linearRampToValueAtTime(p.map(f), Math.max(0, at(f)));
      }
    },
    dispose() {
      for (const n of nodes) n.disconnect();
    },
  };
}

/** Whether two effect lists build the same chain (so a live chain can be kept). */
export function sameChain(a: Effect[], b: Effect[]): boolean {
  const shape = (l: Effect[]) => l.filter((e) => e.enabled).map((e) => `${e.type}:${e.type === 'channels' ? strParam(e, 'mode') : ''}:${e.type === 'reverb' ? numParam(e, 'decay', 0) : ''}`).join('|');
  return shape(a) === shape(b);
}

/** A clip's volume and balance at a frame. */
export function clipLevels(volume: Parameters<typeof valueAt>[0], pan: Parameters<typeof valueAt>[0], local: number): { gain: number; pan: number } {
  return { gain: dbToGain(valueAt(volume, local, 0)), pan: Math.max(-1, Math.min(1, valueAt(pan, local, 0) / 100)) };
}
