// The Audio Track Mixer (a fader, balance, mute and solo for each audio track, and the master level,
// with meters) and the master meters beside the timeline.
import { allTracks, type Track } from '../../core/project';
import type { App } from '../app';
import { h } from '../dom';
import type { Panel } from '../layout';
import { tooltip } from '../widgets';

const MIN_DB = -60;
const MAX_DB = 6;

/** A peak level to a meter height (0–1) on a dB scale. */
function meterLevel(peak: number): number {
  if (peak <= 0) return 0;
  const db = 20 * Math.log10(peak);
  return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

/** Draws a stereo meter; levels fall back slowly so peaks are readable. */
class Meter {
  readonly el: HTMLCanvasElement;
  private shown: [number, number] = [0, 0];
  private held: [number, number] = [0, 0];
  private heldAt = [0, 0];

  constructor(cls = 'meter') {
    this.el = h('canvas', { class: cls }) as HTMLCanvasElement;
  }

  draw(levels: [number, number], scale = false): void {
    const c = this.el;
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (!w || !hh) return;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(hh * dpr)) c.height = Math.round(hh * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const now = performance.now();
    const barW = scale ? (w - 18) / 2 - 1 : w / 2 - 1;
    for (let i = 0; i < 2; i++) {
      const target = meterLevel(levels[i]);
      this.shown[i] = target > this.shown[i] ? target : Math.max(target, this.shown[i] - 0.025);
      if (target >= this.held[i] || now - this.heldAt[i] > 1200) {
        this.held[i] = target;
        this.heldAt[i] = now;
      }
      const x = i * (barW + 2);
      ctx.fillStyle = 'rgba(128,128,128,0.18)';
      ctx.fillRect(x, 0, barW, hh);
      const lh = this.shown[i] * hh;
      const grad = ctx.createLinearGradient(0, hh, 0, 0);
      grad.addColorStop(0, '#2fbf71');
      grad.addColorStop(0.75, '#2fbf71');
      grad.addColorStop(0.86, '#e8c547');
      grad.addColorStop(0.92, '#ff5c5c');
      ctx.fillStyle = grad;
      ctx.fillRect(x, hh - lh, barW, lh);
      if (this.held[i] > 0.01) {
        ctx.fillStyle = this.held[i] > 0.9 ? '#ff5c5c' : '#d7dbe2';
        ctx.fillRect(x, hh - this.held[i] * hh, barW, 2);
      }
    }
    if (scale) {
      ctx.fillStyle = 'rgba(160,166,178,0.9)';
      ctx.font = '9px "Segoe UI", sans-serif';
      ctx.textAlign = 'right';
      for (const db of [0, -6, -12, -24, -36, -48]) {
        const y = hh - ((db - MIN_DB) / (MAX_DB - MIN_DB)) * hh;
        ctx.fillText(String(db), w, Math.max(8, Math.min(hh - 1, y + 3)));
      }
    }
  }

  get idle(): boolean {
    return this.shown[0] < 0.001 && this.shown[1] < 0.001 && this.held[0] < 0.001 && this.held[1] < 0.001;
  }
}

/** Runs the meters while sound plays, and a little after (so they fall to zero). */
class MeterLoop {
  private raf = 0;

  constructor(private app: App, private draw: () => boolean) {
    app.on('playhead', () => this.start());
  }

  start(): void {
    if (this.raf) return;
    const tick = () => {
      const busy = this.draw();
      this.raf = busy || this.app.player.playing ? requestAnimationFrame(tick) : 0;
    };
    this.raf = requestAnimationFrame(tick);
  }
}

export class MasterMeters {
  readonly el: HTMLElement;
  private meter = new Meter('meter master-meter');

  constructor(private app: App) {
    this.el = h('div', { class: 'master-meters' }, this.meter.el);
    tooltip(this.el, 'Master level (dB). Red means too loud — it may distort.');
    new MeterLoop(app, () => {
      const { master } = this.app.player.levels();
      this.meter.draw(master, true);
      return !this.meter.idle;
    });
    new ResizeObserver(() => this.meter.draw([0, 0], true)).observe(this.el);
  }
}

export class MixerPanel implements Panel {
  readonly id = 'mixer';
  readonly title = 'Audio Mixer';
  readonly el: HTMLElement;
  private strips: HTMLElement;
  private meters = new Map<string, Meter>();
  private master = new Meter('meter');
  private dragging = false;

  constructor(private app: App) {
    this.strips = h('div', { class: 'mix-strips' });
    this.el = h('div', { class: 'mixer' }, this.strips);
    for (const k of ['project', 'sequence'] as const) app.on(k, () => !this.dragging && this.render());
    new MeterLoop(app, () => {
      if (!this.app.layout?.isShown(this.id)) return false;
      const lv = this.app.player.levels();
      let busy = false;
      for (const [id, m] of this.meters) {
        m.draw(lv.tracks.get(id) ?? [0, 0]);
        busy ||= !m.idle;
      }
      this.master.draw(lv.master);
      return busy || !this.master.idle;
    });
    this.render();
  }

  shown(): void {
    this.render();
  }

  private render(): void {
    const app = this.app;
    if (!app.project) {
      this.strips.replaceChildren();
      return;
    }
    const s = app.seq;
    this.meters.clear();
    const strips = s.audio.map((t) => this.strip(t));
    this.strips.replaceChildren(...strips, this.masterStrip());
    requestAnimationFrame(() => {
      for (const m of this.meters.values()) m.draw([0, 0]);
      this.master.draw([0, 0]);
    });
  }

  private dbLabel(db: number): string {
    return db <= MIN_DB ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
  }

  /** A vertical fader in dB. */
  private fader(value: number, label: string, onLive: (db: number) => void, onEnd: () => void): HTMLElement {
    const out = h('span', { class: 'mix-db' }, this.dbLabel(value));
    const range = h('input', { type: 'range', class: 'mix-fader', min: MIN_DB, max: MAX_DB, step: 0.1, value: String(Math.max(MIN_DB, value)), 'aria-label': label }) as HTMLInputElement;
    range.addEventListener('input', () => {
      const v = Number(range.value);
      const db = v <= MIN_DB ? -96 : v;
      out.textContent = this.dbLabel(db);
      onLive(db);
    });
    range.addEventListener('change', onEnd);
    range.addEventListener('dblclick', () => {
      range.value = '0';
      range.dispatchEvent(new Event('input'));
      onEnd();
    });
    tooltip(range, `${label} — double-click for 0 dB`);
    return h('div', { class: 'mix-fader-wrap' }, range, out);
  }

  private strip(t: Track): HTMLElement {
    const app = this.app;
    let live: ReturnType<App['liveEdit']> | null = null;
    const change = (label: string, fn: (x: Track) => void) => {
      if (!live) {
        live = app.liveEdit(label);
        this.dragging = true;
      }
      live.update((s) => {
        const x = allTracks(s).find((y) => y.id === t.id);
        if (x) fn(x);
      });
    };
    const end = () => {
      live?.end();
      live = null;
      this.dragging = false;
      this.render();
    };
    const pan = h('input', { type: 'range', class: 'mix-pan', min: -100, max: 100, step: 1, value: String(t.pan), 'aria-label': `${t.name} balance` }) as HTMLInputElement;
    const panOut = h('span', { class: 'mix-pan-out' }, t.pan === 0 ? 'C' : t.pan < 0 ? `L${-t.pan}` : `R${t.pan}`);
    pan.addEventListener('input', () => {
      const v = Number(pan.value);
      panOut.textContent = v === 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`;
      change('Track balance', (x) => (x.pan = v));
    });
    pan.addEventListener('change', end);
    pan.addEventListener('dblclick', () => {
      pan.value = '0';
      pan.dispatchEvent(new Event('input'));
      end();
    });
    tooltip(pan, 'Balance (left / right) — double-click to center');
    const meter = new Meter('meter');
    this.meters.set(t.id, meter);
    const toggle = (on: boolean, text: string, label: string, fn: () => void, cls: string) => {
      const b = h('button', { class: `tl-hbtn ${cls}${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', 'aria-label': label, onclick: fn }, text);
      tooltip(b, label);
      return b;
    };
    const setFlag = (label: string, fn: (x: Track) => void) =>
      app.edit(label, (s) => {
        const x = allTracks(s).find((y) => y.id === t.id);
        if (!x) return false;
        fn(x);
      });
    return h(
      'div',
      { class: `mix-strip${t.muted ? ' muted' : ''}` },
      h('div', { class: 'mix-name', title: t.name }, t.name),
      h('div', { class: 'mix-pan-row' }, pan, panOut),
      h('div', { class: 'mix-btns' }, toggle(t.muted, 'M', t.muted ? 'Unmute' : 'Mute', () => setFlag('Mute track', (x) => (x.muted = !x.muted)), 'mute'), toggle(t.solo, 'S', t.solo ? 'Stop soloing' : 'Solo', () => setFlag('Solo track', (x) => (x.solo = !x.solo)), 'solo')),
      h('div', { class: 'mix-body' }, this.fader(t.volume, `${t.name} level`, (db) => change('Track level', (x) => (x.volume = db)), end), meter.el),
    );
  }

  private masterStrip(): HTMLElement {
    const app = this.app;
    let live: ReturnType<App['liveEdit']> | null = null;
    return h(
      'div',
      { class: 'mix-strip master' },
      h('div', { class: 'mix-name' }, 'Master'),
      h('div', { class: 'mix-pan-row' }),
      h('div', { class: 'mix-btns' }),
      h(
        'div',
        { class: 'mix-body' },
        this.fader(
          app.seq.masterVolume,
          'Master level',
          (db) => {
            if (!live) {
              live = app.liveEdit('Master level');
              this.dragging = true;
            }
            live.update((s) => (s.masterVolume = db));
          },
          () => {
            live?.end();
            live = null;
            this.dragging = false;
          },
        ),
        this.master.el,
      ),
    );
  }
}
