// Draws a sequence's frame: each track's clip (or transition) from V1 up, with its effects and
// Motion, blended onto the ones below. Used by the Program monitor and by export, so the preview and
// the exported video match.
import { valueAt } from '../core/anim';
import { boolParam, isNeutral, numParam, strParam, type Effect } from '../core/effects';
import { parseCube } from '../core/lut';
import { mediaOf, type Clip, type MediaItem, type Project, type Sequence } from '../core/project';
import { videoAt, type ClipFrame } from '../core/timeline';
import { COPY, Gl, type Target } from './gl';
import * as S from './shaders';
import { drawTitle } from './text';

/** A picture ready to draw: a video frame, an image or a canvas. */
export interface Picture {
  source: TexImageSource;
  /** Upright size (after rotation). */
  width: number;
  height: number;
  /** Quarter turns that make it upright. */
  rotation?: number;
  /** Stills: uploaded once and kept under this key. */
  stillKey?: string;
}

export interface PictureProvider {
  /** The picture of a clip at a media time, or null when it isn't ready yet. */
  picture(clip: Clip, media: MediaItem | undefined, time: number): Picture | null;
}

export interface RenderOptions {
  project: Project;
  seq: Sequence;
  frame: number;
  /** Fraction of the sequence's size to render at (the Program monitor's playback resolution). */
  scale: number;
  provider: PictureProvider;
}

/** Where a clip sits in the frame (sequence pixels), for the monitor's transform handles. */
export interface Placement {
  /** Size after fitting, before Motion's scale. */
  fw: number;
  fh: number;
  /** Maps the picture's centered pixels to the frame. */
  x: number;
  y: number;
  sx: number;
  sy: number;
  rotation: number;
  ax: number;
  ay: number;
}

const hex = (c: string): [number, number, number] => {
  const n = parseInt((c || '#000000').replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** How a picture of this size fits the sequence (before Motion). */
export function fitSize(clip: Clip, w: number, h: number, seq: Pick<Sequence, 'width' | 'height'>): [number, number] {
  if (clip.kind === 'title' || clip.kind === 'color' || clip.kind === 'adjustment') return [seq.width, seq.height];
  switch (clip.fit ?? 'fit') {
    case 'none':
      return [w, h];
    case 'stretch':
      return [seq.width, seq.height];
    case 'fill': {
      const k = Math.max(seq.width / w, seq.height / h);
      return [w * k, h * k];
    }
    default: {
      const k = Math.min(seq.width / w, seq.height / h);
      return [w * k, h * k];
    }
  }
}

export function placement(clip: Clip, local: number, w: number, h: number, seq: Pick<Sequence, 'width' | 'height'>): Placement {
  const [fw, fh] = fitSize(clip, w, h, seq);
  const m = clip.motion;
  const scale = valueAt(m?.scale, local, 100) / 100;
  const sx = m && !m.uniform ? valueAt(m.scaleW, local, 100) / 100 : scale;
  return {
    fw,
    fh,
    x: valueAt(m?.x, local, seq.width / 2),
    y: valueAt(m?.y, local, seq.height / 2),
    sx,
    sy: scale,
    rotation: valueAt(m?.rotation, local, 0),
    ax: valueAt(m?.ax, local, 0),
    ay: valueAt(m?.ay, local, 0),
  };
}

/** A point of the picture (centered, y down, fitted pixels) in the frame (sequence pixels). */
export function toFrame(p: Placement, qx: number, qy: number): [number, number] {
  const r = (p.rotation * Math.PI) / 180;
  const dx = (qx - p.ax) * p.sx;
  const dy = (qy - p.ay) * p.sy;
  return [p.x + dx * Math.cos(r) - dy * Math.sin(r), p.y + dx * Math.sin(r) + dy * Math.cos(r)];
}

/** The reverse: a frame point to the picture's centered pixels. */
export function fromFrame(p: Placement, X: number, Y: number): [number, number] {
  const r = (p.rotation * Math.PI) / 180;
  const dx = X - p.x;
  const dy = Y - p.y;
  const ux = dx * Math.cos(r) + dy * Math.sin(r);
  const uy = -dx * Math.sin(r) + dy * Math.cos(r);
  return [ux / (p.sx || 1e-6) + p.ax, uy / (p.sy || 1e-6) + p.ay];
}

interface TexEntry {
  tex: WebGLTexture;
  key: string;
  used: number;
}

export class Compositor {
  readonly gl: Gl;
  private textures = new Map<string, TexEntry>();
  private luts = new Map<string, { tex: WebGLTexture | null; size: number; failed: boolean; ready: Promise<void> }>();
  private titleCanvas: OffscreenCanvas | null = null;
  private renderCount = 0;
  /** Called when something it was waiting for (a LUT) arrived, so the frame can be drawn again. */
  onReady: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, private readText: (path: string) => Promise<string | null>) {
    this.gl = new Gl(canvas);
  }

  /** Draws a frame onto the canvas (sized to the sequence × scale). */
  render(o: RenderOptions): void {
    const out = this.renderToTarget(o);
    const canvas = this.gl.canvas;
    if (canvas.width !== out.w || canvas.height !== out.h) {
      canvas.width = out.w;
      canvas.height = out.h;
    }
    this.gl.pass(COPY, null, { uTex: out.tex }, [out.w, out.h]);
    this.gl.release(out);
  }

  /** Draws a frame into a target (the caller releases it). */
  renderToTarget(o: RenderOptions): Target {
    const { seq, scale } = o;
    const gl = this.gl;
    this.renderCount++;
    const W = Math.max(2, Math.round(seq.width * scale));
    const H = Math.max(2, Math.round(seq.height * scale));
    let base = gl.target(W, H);
    gl.clear(base, [0, 0, 0, 1]);
    const media = (c: Clip) => mediaOf(o.project, c);
    for (const layer of videoAt(seq, o.frame, media)) {
      if (layer.transition) {
        const tr = layer.transition;
        let a = layer.a && layer.a.clip.kind !== 'adjustment' ? this.clipLayer(layer.a, o, W, H) : null;
        let b = layer.b && layer.b.clip.kind !== 'adjustment' ? this.clipLayer(layer.b, o, W, H) : null;
        if (tr.type === 'blurDissolve') {
          const sigma = Math.sin(tr.progress * Math.PI) * 18 * scale;
          if (a) a = this.blur(a, sigma, true, true);
          if (b) b = this.blur(b, sigma, true, true);
        }
        const t = gl.target(W, H);
        const dir = typeof tr.params.direction === 'string' ? tr.params.direction : 'left';
        const soft = numParam({ type: tr.type, params: tr.params }, 'softness', 0) / 100;
        gl.pass(S.TRANSITION, t, { uA: a?.tex, uB: b?.tex, uHasA: !!a, uHasB: !!b, uP: tr.progress, uType: S.TRANSITION_INDEX[tr.type] ?? 0, uDir: S.DIRECTION_INDEX[dir] ?? 0, uSoft: soft });
        gl.release(a);
        gl.release(b);
        base = this.blendOnto(base, t, 'normal');
        continue;
      }
      const cf = layer.a!;
      if (cf.clip.kind === 'adjustment') {
        base = this.adjust(base, cf, o);
        continue;
      }
      const t = this.clipLayer(cf, o, W, H);
      if (t) base = this.blendOnto(base, t, cf.clip.blend ?? 'normal');
    }
    this.sweep();
    return base;
  }

  private blendOnto(base: Target, layer: Target, mode: string): Target {
    const out = this.gl.target(base.w, base.h);
    this.gl.pass(S.BLEND, out, { uBase: base.tex, uLayer: layer.tex, uMode: S.BLEND_INDEX[mode] ?? 0 });
    this.gl.release(base);
    this.gl.release(layer);
    return out;
  }

  /** An adjustment layer: its effects change everything below it, mixed by its opacity. */
  private adjust(base: Target, cf: ClipFrame, o: RenderOptions): Target {
    const copy = this.gl.target(base.w, base.h);
    this.gl.pass(COPY, copy, { uTex: base.tex });
    const done = this.effects(copy, cf.clip.effects, cf.local, o.scale, o.frame);
    const opacity = valueAt(cf.clip.opacity, cf.local, 100) / 100;
    const out = this.gl.target(base.w, base.h);
    this.gl.pass(S.MIX, out, { uA: base.tex, uB: done.tex, uT: opacity });
    this.gl.release(base);
    this.gl.release(done);
    return out;
  }

  private texture(key: string, id: string, upload: (t: WebGLTexture | null) => WebGLTexture): WebGLTexture {
    const e = this.textures.get(id);
    if (e && e.key === key && key) {
      e.used = this.renderCount;
      return e.tex;
    }
    const tex = upload(e?.tex ?? null);
    this.textures.set(id, { tex, key, used: this.renderCount });
    return tex;
  }

  /** Textures not drawn for a while are freed. */
  private sweep(): void {
    if (this.renderCount % 60) return;
    for (const [id, e] of this.textures) {
      if (this.renderCount - e.used > 120) {
        this.gl.deleteTexture(e.tex);
        this.textures.delete(id);
      }
    }
  }

  /** A clip's picture in the frame (frame-sized, transparent around it), or null when it isn't ready. */
  private clipLayer(cf: ClipFrame, o: RenderOptions, W: number, H: number): Target | null {
    const gl = this.gl;
    const { clip } = cf;
    const seq = o.seq;
    const k = o.scale;
    // The source picture
    let sw: number;
    let sh: number;
    let draw: (t: Target) => void;
    if (clip.kind === 'color') {
      sw = seq.width;
      sh = seq.height;
      const [r, g, b] = hex(clip.color ?? '#000000');
      draw = (t) => gl.pass(S.SOLID, t, { uColor: [r, g, b, 1] });
    } else if (clip.kind === 'title' && clip.title) {
      sw = seq.width;
      sh = seq.height;
      const st = clip.title;
      draw = (t) => {
        const ks = t.w / seq.width;
        const key = `title:${t.w}x${t.h}:${JSON.stringify(st)}`;
        const tex = this.texture(key, `title:${clip.id}`, (old) => {
          this.titleCanvas ??= new OffscreenCanvas(t.w, t.h);
          const c = this.titleCanvas;
          if (c.width !== t.w || c.height !== t.h) {
            c.width = t.w;
            c.height = t.h;
          }
          const ctx = c.getContext('2d')!;
          ctx.clearRect(0, 0, t.w, t.h);
          drawTitle(ctx, st, seq.width, seq.height, ks);
          return gl.upload(c, old);
        });
        gl.pass(S.SOURCE, t, { uTex: tex, uRot: 0, uOpaque: false });
      };
    } else {
      const m = mediaOf(o.project, clip);
      const pic = o.provider.picture(clip, m, cf.time);
      if (!pic) return null;
      sw = pic.width;
      sh = pic.height;
      const tex = this.texture(pic.stillKey ?? '', pic.stillKey ? `still:${pic.stillKey}` : `clip:${clip.id}`, (old) => gl.upload(pic.source, old));
      const opaque = clip.kind === 'video';
      draw = (t) => gl.pass(S.SOURCE, t, { uTex: tex, uRot: pic.rotation ?? 0, uOpaque: opaque });
    }
    const p = placement(clip, cf.local, sw, sh, seq);
    if (Math.abs(p.sx) < 1e-4 || Math.abs(p.sy) < 1e-4) return null;
    const opacity = valueAt(clip.opacity, cf.local, 100) / 100;
    if (opacity <= 0) return null;
    // Effects run at the size the picture is shown (up to its own resolution)
    const zoom = Math.max(1, Math.abs(p.sx), Math.abs(p.sy));
    const limitW = clip.kind === 'title' || clip.kind === 'color' ? 8192 : Math.max(sw, p.fw * k);
    const cw = Math.max(1, Math.min(8192, Math.round(Math.min(limitW, p.fw * k * zoom))));
    const ch = Math.max(1, Math.min(8192, Math.round((cw * p.fh) / p.fw)));
    let src = gl.target(cw, ch);
    draw(src);
    const pxScale = cw / p.fw;
    src = this.effects(src, clip.effects.filter((e) => e.type !== 'dropShadow'), cf.local, pxScale, o.frame);
    // Motion: from a frame pixel back to the picture's uv
    const toUv = (fx: number, fy: number): [number, number] => {
      const [qx, qy] = fromFrame(p, fx / k, seq.height - fy / k);
      return [qx / p.fw + 0.5, 0.5 - qy / p.fh];
    };
    const [u0, v0] = toUv(0, 0);
    const [u1, v1] = toUv(1, 0);
    const [u2, v2] = toUv(0, 1);
    const inv = [u1 - u0, v1 - v0, 0, u2 - u0, v2 - v0, 0, u0, v0, 1];
    let out = gl.target(W, H);
    gl.pass(S.PLACE, out, { uTex: src.tex, uInv: inv, uClipPx: [Math.abs(p.fw * p.sx * k), Math.abs(p.fh * p.sy * k)], uOpacity: opacity });
    gl.release(src);
    for (const e of clip.effects) {
      if (e.type === 'dropShadow' && e.enabled) out = this.dropShadow(out, e, cf.local, k);
    }
    return out;
  }

  private dropShadow(layer: Target, e: Effect, f: number, k: number): Target {
    const gl = this.gl;
    const soft = this.blur(this.copyOf(layer), (numParam(e, 'softness', f) * k) / 2, true, true);
    const ang = (numParam(e, 'direction', f) * Math.PI) / 180;
    const dist = numParam(e, 'distance', f) * k;
    const [r, g, b] = hex(strParam(e, 'color'));
    const a = numParam(e, 'opacity', f) / 100;
    const out = gl.target(layer.w, layer.h);
    gl.pass(S.SHADOW, out, { uTex: layer.tex, uShadow: soft.tex, uOffset: [Math.sin(ang) * dist, Math.cos(ang) * dist], uColor: [r * a, g * a, b * a, a] });
    gl.release(soft);
    gl.release(layer);
    return out;
  }

  private copyOf(t: Target): Target {
    const c = this.gl.target(t.w, t.h);
    this.gl.pass(COPY, c, { uTex: t.tex });
    return c;
  }

  /** A gaussian blur; big ones run on a smaller copy (much faster, and it looks the same). */
  blur(t: Target, sigma: number, horizontal: boolean, vertical: boolean): Target {
    const gl = this.gl;
    if (sigma < 0.3 || (!horizontal && !vertical)) return t;
    let work = t;
    let factor = 1;
    while (sigma / factor > 8 && work.w / 2 >= 8 && work.h / 2 >= 8) {
      const half = gl.target(Math.round(work.w / 2), Math.round(work.h / 2));
      gl.pass(COPY, half, { uTex: work.tex });
      if (work !== t) gl.release(work);
      work = half;
      factor *= 2;
    }
    const s = sigma / factor;
    if (horizontal) {
      const n = gl.target(work.w, work.h);
      gl.pass(S.BLUR, n, { uTex: work.tex, uStep: [1 / work.w, 0], uSigma: s });
      if (work !== t) gl.release(work);
      work = n;
    }
    if (vertical) {
      const n = gl.target(work.w, work.h);
      gl.pass(S.BLUR, n, { uTex: work.tex, uStep: [0, 1 / work.h], uSigma: s });
      if (work !== t) gl.release(work);
      work = n;
    }
    if (work.w !== t.w || work.h !== t.h) {
      const full = gl.target(t.w, t.h);
      gl.pass(COPY, full, { uTex: work.tex });
      gl.release(work);
      work = full;
    }
    gl.release(t);
    return work;
  }

  /** A look's 3D texture, loading it the first time (null until it's ready). */
  private lut(path: string): { tex: WebGLTexture; size: number } | null {
    let e = this.luts.get(path);
    if (!e) {
      const entry = { tex: null as WebGLTexture | null, size: 33, failed: false, ready: Promise.resolve() };
      entry.ready = this.readText(path).then((text) => {
        try {
          if (!text) throw new Error('missing');
          const lut = parseCube(text);
          entry.tex = this.gl.lut3d(lut.data, lut.size);
          entry.size = lut.size;
          this.onReady?.();
        } catch {
          entry.failed = true;
        }
      });
      this.luts.set(path, (e = entry));
    }
    return e.tex ? { tex: e.tex, size: e.size } : null;
  }

  /** Loads looks before drawing (exports shouldn't start without them). */
  async preload(paths: string[]): Promise<void> {
    for (const p of paths) this.lut(p);
    await Promise.all(paths.map((p) => this.luts.get(p)!.ready));
  }

  /** A LUT that couldn't be loaded (for a warning in the panel). */
  lutFailed(path: string): boolean {
    return !!this.luts.get(path)?.failed;
  }

  /** Runs a clip's effects in order (in the picture's own pixels; px settings are scaled by pxScale). */
  private effects(t: Target, list: Effect[], f: number, pxScale: number, frame: number): Target {
    const gl = this.gl;
    let cur = t;
    const run = (shader: string, u: Record<string, unknown>) => {
      const n = gl.target(cur.w, cur.h);
      gl.pass(shader, n, { uTex: cur.tex, ...(u as Record<string, number>) });
      gl.release(cur);
      cur = n;
    };
    for (const e of list) {
      if (!e.enabled || isNeutral(e)) continue;
      const n = (id: string) => numParam(e, id, f);
      switch (e.type) {
        case 'lumetri': {
          const lutPath = strParam(e, 'lut');
          const lut = lutPath ? this.lut(lutPath) : null;
          run(S.LUMETRI, {
            uTemp: n('temperature') / 100,
            uTint: n('tint') / 100,
            uExposure: n('exposure'),
            uContrast: n('contrast') / 100,
            uHighlights: n('highlights') / 100,
            uShadows: n('shadows') / 100,
            uWhites: n('whites') / 100,
            uBlacks: n('blacks') / 100,
            uSaturation: n('saturation') / 100,
            uVibrance: n('vibrance') / 100,
            uFaded: n('faded') / 100,
            uLut: lut ? { tex3d: lut.tex } : null,
            uLutAmount: lut ? n('lutAmount') / 100 : 0,
            uLutSize: lut?.size ?? 33,
            uVignette: n('vignette'),
            uVigMid: n('vigMidpoint') / 100,
            uVigRound: n('vigRoundness') / 100,
            uVigFeather: n('vigFeather') / 100,
            uAspect: [cur.w / cur.h, 1],
          });
          break;
        }
        case 'brightness':
          run(S.BRIGHTNESS, { uBrightness: n('brightness') / 100, uContrast: n('contrast') / 100 });
          break;
        case 'hsl':
          run(S.HSL, { uHue: n('hue') / 360, uSat: n('saturation') / 100, uLight: n('lightness') / 100 });
          break;
        case 'blackWhite':
          run(S.BLACK_WHITE, { uAmount: n('amount') / 100 });
          break;
        case 'sepia':
          run(S.SEPIA, { uAmount: n('amount') / 100 });
          break;
        case 'tint':
          run(S.TINT, { uBlack: hex(strParam(e, 'black')), uWhite: hex(strParam(e, 'white')), uAmount: n('amount') / 100 });
          break;
        case 'invert':
          run(S.INVERT, { uAmount: n('amount') / 100 });
          break;
        case 'posterize':
          run(S.POSTERIZE, { uLevels: Math.max(2, n('levels')) });
          break;
        case 'noise':
          run(S.NOISE, { uAmount: (n('amount') / 100) * 0.5, uSeed: frame % 997, uColor: boolParam(e, 'color') });
          break;
        case 'gaussianBlur': {
          const dim = strParam(e, 'dimension');
          cur = this.blur(cur, (n('blurriness') * pxScale) / 2, dim !== 'v', dim !== 'h');
          break;
        }
        case 'sharpen':
          run(S.SHARPEN, { uAmount: n('amount') / 100 });
          break;
        case 'glow': {
          const bright = gl.target(cur.w, cur.h);
          gl.pass(S.BRIGHT_PASS, bright, { uTex: cur.tex, uThreshold: n('threshold') / 100 });
          const soft = this.blur(bright, Math.max(0.5, (n('radius') * pxScale) / 2), true, true);
          const out = gl.target(cur.w, cur.h);
          gl.pass(S.ADD, out, { uBase: cur.tex, uAdd: soft.tex, uIntensity: n('intensity') / 100 });
          gl.release(soft);
          gl.release(cur);
          cur = out;
          break;
        }
        case 'ultraKey':
          run(S.ULTRA_KEY, { uKey: hex(strParam(e, 'color')), uTolerance: n('tolerance') / 100, uSoftness: n('softness') / 100, uSpill: n('spill') / 100, uChoke: n('choke') / 100 });
          break;
        case 'lumaKey':
          run(S.LUMA_KEY, { uThreshold: n('threshold') / 100, uSoftness: n('softness') / 100, uInvert: boolParam(e, 'invert') });
          break;
        case 'crop':
          run(S.CROP, { uCrop: [n('left') / 100, n('top') / 100, n('right') / 100, n('bottom') / 100], uFeather: n('feather') * pxScale });
          break;
        case 'flip':
          run(S.FLIP, { uH: boolParam(e, 'horizontal'), uV: boolParam(e, 'vertical') });
          break;
        case 'mask':
          run(S.MASK, { uCenter: [n('x') / 100, 1 - n('y') / 100], uHalf: [n('width') / 200, n('height') / 200], uFeather: n('feather') / 100, uEllipse: strParam(e, 'shape') !== 'rectangle', uInvert: boolParam(e, 'invert') });
          break;
        case 'mosaic':
          run(S.MOSAIC, { uBlocks: Math.max(2, n('blocks')) });
          break;
      }
    }
    return cur;
  }

  dispose(): void {
    for (const e of this.textures.values()) this.gl.deleteTexture(e.tex);
    this.textures.clear();
    for (const l of this.luts.values()) this.gl.deleteTexture(l.tex);
    this.gl.dispose();
  }
}
