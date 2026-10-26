// Video scopes for color work: the waveform (how bright each part of the picture is, left to
// right), the RGB parade (the same for red, green and blue) and the vectorscope (how colorful, and
// which hues). Drawn from a small copy of the Program monitor's frame.
import type { App } from '../app';
import { h } from '../dom';
import { tooltip } from '../widgets';

type Mode = 'waveform' | 'parade' | 'vector';

const MODES: [Mode, string, string][] = [
  ['waveform', 'Waveform', 'Brightness across the picture: the top is white, the bottom black'],
  ['parade', 'RGB parade', 'Red, green and blue side by side — equal heights mean neutral greys'],
  ['vector', 'Vectorscope', 'How colorful the picture is (distance from the middle) and which hues'],
];

export class Scopes {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private mode: Mode = 'waveform';
  private bar: HTMLElement;
  private timer: number | undefined;
  private last = 0;

  constructor(private app: App) {
    this.canvas = h('canvas', { class: 'scope-canvas', width: 360, height: 150 }) as HTMLCanvasElement;
    this.bar = h('div', { class: 'scope-modes' });
    this.el = h('div', { class: 'scopes' }, this.bar, this.canvas);
    this.renderBar();
    for (const k of ['playhead', 'project', 'selection'] as const) app.on(k, () => this.schedule());
  }

  private renderBar(): void {
    this.bar.replaceChildren(
      ...MODES.map(([m, label, tip]) => {
        const b = h('button', { class: `btn small${m === this.mode ? ' on' : ''}`, onclick: () => {
          this.mode = m;
          this.renderBar();
          this.update();
        } }, label);
        tooltip(b, tip);
        return b;
      }),
    );
  }

  /** At most a few times a second (it reads the frame back from the graphics card). */
  schedule(): void {
    if (!this.el.isConnected || !this.app.layout?.isShown('lumetri')) return;
    if (this.timer) return;
    const wait = Math.max(0, 220 - (performance.now() - this.last));
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.update();
    }, wait);
  }

  update(): void {
    this.last = performance.now();
    const sample = this.app.layout?.program.sample();
    if (!sample) return;
    const c = this.canvas;
    const W = c.width;
    const H = c.height;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const out = img.data;
    const { data, w, h: sh } = sample;
    const counts = new Float32Array(W * H * 3);
    const hits = new Float32Array(this.mode === 'vector' ? W * H : 0);
    const plot = (x: number, y: number, ch: number, v = 1) => {
      const xi = Math.max(0, Math.min(W - 1, Math.round(x)));
      const yi = Math.max(0, Math.min(H - 1, Math.round(y)));
      counts[(yi * W + xi) * 3 + ch] += v;
    };
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;
        if (this.mode === 'waveform') {
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const px = (x / w) * W;
          plot(px, (1 - l) * (H - 1), 0);
          plot(px, (1 - l) * (H - 1), 1);
          plot(px, (1 - l) * (H - 1), 2);
        } else if (this.mode === 'parade') {
          const third = W / 3;
          plot((x / w) * third, (1 - r) * (H - 1), 0);
          plot(third + (x / w) * third, (1 - g) * (H - 1), 1);
          plot(2 * third + (x / w) * third, (1 - b) * (H - 1), 2);
        } else {
          const cb = -0.1687 * r - 0.3313 * g + 0.5 * b;
          const cr = 0.5 * r - 0.4187 * g - 0.0813 * b;
          const size = Math.min(W, H) - 8;
          const px = W / 2 + cb * size * 1.8;
          const py = H / 2 - cr * size * 1.8;
          // Drawn in the pixels' own (average) color
          plot(px, py, 0, r);
          plot(px, py, 1, g);
          plot(px, py, 2, b);
          hits[Math.max(0, Math.min(H - 1, Math.round(py))) * W + Math.max(0, Math.min(W - 1, Math.round(px)))]++;
        }
      }
    }
    const k = 255 / Math.log(1 + Math.max(4, (w * sh) / W / 6));
    for (let i = 0; i < W * H; i++) {
      if (this.mode === 'vector') {
        const n = hits[i];
        const bright = n ? Math.min(255, Math.log(1 + n) * k * 1.4) : 0;
        const r = n ? counts[i * 3] / n : 0;
        const g = n ? counts[i * 3 + 1] / n : 0;
        const b = n ? counts[i * 3 + 2] / n : 0;
        const top = Math.max(r, g, b, 1e-3);
        out[i * 4] = bright * (0.3 + (0.7 * r) / top);
        out[i * 4 + 1] = bright * (0.3 + (0.7 * g) / top);
        out[i * 4 + 2] = bright * (0.3 + (0.7 * b) / top);
        out[i * 4 + 3] = 255;
        continue;
      }
      out[i * 4] = Math.min(255, Math.log(1 + counts[i * 3]) * k * (this.mode === 'waveform' ? 0.55 : 1));
      out[i * 4 + 1] = Math.min(255, Math.log(1 + counts[i * 3 + 1]) * k);
      out[i * 4 + 2] = Math.min(255, Math.log(1 + counts[i * 3 + 2]) * k * (this.mode === 'waveform' ? 0.7 : 1));
      out[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Guides: 0, 50 and 100% lines, or the vectorscope's ring and skin-tone line
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '9px "Segoe UI", sans-serif';
    ctx.lineWidth = 1;
    if (this.mode === 'vector') {
      const size = Math.min(W, H) - 8;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, size * 0.5 * 1.8 * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      // Skin tones fall near this line, whatever the person's complexion
      const a = (-123 * Math.PI) / 180;
      ctx.moveTo(W / 2, H / 2);
      ctx.lineTo(W / 2 + Math.cos(a) * size * 0.5, H / 2 + Math.sin(a) * size * 0.5);
      ctx.stroke();
    } else {
      for (const p of [0, 0.5, 1]) {
        const y = Math.round((1 - p) * (H - 1)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.fillText(`${p * 100}`, 2, Math.max(9, Math.min(H - 2, y - 2)));
      }
    }
  }
}
