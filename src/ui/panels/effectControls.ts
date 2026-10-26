// Effect Controls: the selected clip's settings — Motion, Opacity, speed, title text, volume and
// balance, and each effect — with keyframes. Numbers can be dragged sideways or typed; the stopwatch
// turns keyframes on, and the lane on the right shows them along the clip.
import * as L from 'lucide';
import { addKey, keyAt, moveKey, nearKey, removeKey, setAnimated, setValue, valueAt, type Anim, type Ease } from '../../core/anim';
import { applyTransition } from '../../core/edit';
import { EFFECTS, EFFECTS_BY_ID, TRANSITIONS, TRANSITIONS_BY_ID, defaultParams, makeEffect, type Effect, type ParamDef } from '../../core/effects';
import { BLEND_MODES, clipEnd, defaultMotion, findClip, linkedClips, type BlendMode, type Clip, type Fit, type Sequence, type TitleStyle, type Track } from '../../core/project';
import { parseCube } from '../../core/lut';
import { parseTimecode, shortDuration, timecode } from '../../core/time';
import type { App } from '../app';
import { h, icon } from '../dom';
import type { Panel } from '../layout';
import { platform } from '../platform';
import { promptDialog, showMenu, toast, tooltip, type MenuItem } from '../widgets';

const FONTS = ['Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Ink Free', 'Lucida Console', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Sitka Text', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];

let systemFonts: string[] | null = null;

/** Installed fonts when the system lets us list them, else a list every Windows PC has. */
async function fontList(): Promise<string[]> {
  if (systemFonts) return systemFonts;
  try {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    if (q) systemFonts = [...new Set((await q()).map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    // not allowed
  }
  if (!systemFonts?.length) systemFonts = FONTS;
  return systemFonts;
}

interface NumberOpts {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  decimals?: number;
  onLive: (v: number) => void;
  onEnd: () => void;
  onType: (v: number) => void;
}

/** A number you can drag sideways (Shift: faster, Ctrl: finer) or click to type. */
function scrubber(o: NumberOpts): HTMLElement & { set(v: number): void } {
  const dec = o.decimals ?? (o.step !== undefined && o.step < 1 ? (o.step < 0.1 ? 2 : 1) : 0);
  const fmt = (v: number) => `${v.toFixed(dec)}${o.unit ? (o.unit === '%' || o.unit === '°' ? o.unit : ` ${o.unit}`) : ''}`;
  const clamp = (v: number) => Math.max(o.min ?? -Infinity, Math.min(o.max ?? Infinity, v));
  let value = o.value;
  const el = h('span', { class: 'scrub', tabindex: '0', role: 'spinbutton', 'aria-valuenow': String(value) }, fmt(value)) as HTMLElement & { set(v: number): void };
  el.set = (v: number) => {
    value = v;
    el.textContent = fmt(v);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const v0 = value;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const k = (o.step ?? 1) * (ev.shiftKey ? 10 : ev.ctrlKey ? 0.1 : 1);
      const v = clamp(Math.round((v0 + dx * k) / (k / 1)) * (k / 1));
      el.set(Number(v.toFixed(Math.max(dec, ev.ctrlKey ? dec + 1 : dec))));
      o.onLive(value);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (moved) o.onEnd();
      else edit();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
  const edit = () => {
    const input = h('input', { class: 'input scrub-input', value: value.toFixed(dec) }) as HTMLInputElement;
    el.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      input.replaceWith(el);
      const v = Number(input.value.replace(/[^\d.+-]/g, ''));
      if (ok && Number.isFinite(v)) {
        el.set(clamp(v));
        o.onType(value);
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') edit();
  });
  return el;
}

/** Where a setting lives in a clip, so it can be found again in the current project. */
type Getter = (c: Clip) => Anim | undefined;

export class EffectControls implements Panel {
  readonly id = 'effectControls';
  readonly title = 'Effect Controls';
  readonly el: HTMLElement;
  private body: HTMLElement;
  private collapsed = new Set<string>(['text-style']);
  private tickers: (() => void)[] = [];
  private dragging = 0;
  private queued = false;

  constructor(private app: App) {
    this.body = h('div', { class: 'ec-body' });
    this.el = h('div', { class: 'effect-controls' }, this.body);
    for (const k of ['selection', 'project', 'sequence'] as const) app.on(k, () => this.request());
    app.on('playhead', () => {
      for (const t of this.tickers) t();
    });
    this.request();
  }

  request(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      if (!this.dragging) this.render();
    });
  }

  shown(): void {
    this.request();
  }

  private get seq(): Sequence {
    return this.app.seq;
  }

  private local(c: Clip): number {
    return Math.max(0, Math.min(c.duration - 1, this.app.playhead - c.start));
  }

  private render(): void {
    const app = this.app;
    this.tickers = [];
    if (!app.project) {
      this.body.replaceChildren();
      return;
    }
    if (app.transitionSel) {
      const f = findClip(this.seq, app.transitionSel.clipId);
      if (f) {
        this.body.replaceChildren(...this.transitionView(f.clip, f.track, app.transitionSel.side));
        return;
      }
    }
    const focus = app.focusClip();
    if (!focus) {
      this.body.replaceChildren(h('div', { class: 'ec-empty' }, icon(L.SlidersHorizontal, 26), h('p', null, 'Select a clip on the timeline to change its position, size, opacity, speed, volume and effects.'), h('p', { class: 'hint' }, 'Drag effects from the Effects panel onto clips.')));
      return;
    }
    const { clip } = focus;
    // A picture and its linked sound are shown together
    const linked = linkedClips(this.seq, clip).filter((c) => c !== clip && this.app.selection.has(c.id));
    const audio = clip.kind === 'audio' ? clip : linked.find((c) => c.kind === 'audio');
    const video = clip.kind !== 'audio' ? clip : null;
    const head = h(
      'div',
      { class: 'ec-head' },
      h('div', { class: 'ec-title' }, h('span', { class: 'ec-name' }, clip.name), h('span', { class: 'hint' }, `${timecode(clip.start, this.seq.fps)} · ${shortDuration(clip.duration, this.seq.fps)}`)),
      this.addEffectButton(video, audio ?? null),
    );
    const parts: HTMLElement[] = [head];
    if (video) {
      parts.push(h('div', { class: 'ec-kind' }, 'Video'));
      if (video.kind === 'title') parts.push(...this.titleSections(video));
      if (video.kind === 'color') parts.push(this.section('matte', 'Color matte', [this.colorRow('Color', video.color ?? '#000000', (v) => this.set(video, 'Matte color', (c) => (c.color = v)))]));
      if (video.kind !== 'adjustment') parts.push(this.motionSection(video), this.opacitySection(video), this.timeSection(video));
      else parts.push(this.opacitySection(video));
      for (const e of video.effects) parts.push(this.effectSection(video, e));
    }
    if (audio) {
      parts.push(h('div', { class: 'ec-kind' }, 'Audio'));
      parts.push(this.section(`vol-${audio.id}`, 'Volume', [this.animRow(audio, 'Level', (c) => c.volume, { min: -96, max: 15, step: 0.1, unit: 'dB', def: 0 })], () => this.resetAnim(audio, (c) => c.volume, 0)));
      parts.push(this.section(`pan-${audio.id}`, 'Panner', [this.animRow(audio, 'Balance', (c) => c.pan, { min: -100, max: 100, step: 1, def: 0 })], () => this.resetAnim(audio, (c) => c.pan, 0)));
      if (!video) parts.push(this.timeSection(audio));
      for (const e of audio.effects) parts.push(this.effectSection(audio, e));
    }
    this.body.replaceChildren(...parts);
  }

  // ---------- building blocks ----------

  private section(id: string, title: string, rows: HTMLElement[], reset?: () => void, extra: HTMLElement[] = []): HTMLElement {
    const open = !this.collapsed.has(id);
    const toggle = h('button', { class: 'ec-sec-toggle', 'aria-expanded': open ? 'true' : 'false', onclick: () => {
      if (open) this.collapsed.add(id);
      else this.collapsed.delete(id);
      this.render();
    } }, icon(open ? L.ChevronDown : L.ChevronRight, 14), h('span', null, title));
    const resetBtn = reset ? h('button', { class: 'btn icon-only small', 'aria-label': `Reset ${title}`, onclick: reset }, icon(L.RotateCcw, 13)) : null;
    if (resetBtn) tooltip(resetBtn, `Reset ${title}`);
    return h('section', { class: `ec-sec${open ? '' : ' closed'}` }, h('div', { class: 'ec-sec-head' }, toggle, ...extra, resetBtn), open ? h('div', { class: 'ec-rows' }, ...rows) : null);
  }

  /** Changes a clip (found again in the current project) as one undo step. */
  private set(clip: Clip, label: string, fn: (c: Clip) => void): void {
    this.app.edit(label, (s) => {
      const c = findClip(s, clip.id)?.clip;
      if (!c) return false;
      fn(c);
    });
  }

  /** A keyframe lane: the clip's length, its keyframes, and the playhead. */
  private lane(clip: Clip, getAnims: (c: Clip) => (Anim | undefined)[], label: string): HTMLElement {
    const el = h('div', { class: 'ec-lane' });
    const draw = () => {
      const c = findClip(this.seq, clip.id)?.clip ?? clip;
      const anims = getAnims(c).filter((a): a is Anim => !!a);
      const frames = [...new Set(anims.flatMap((a) => (a.keys ?? []).map((k) => k.f)))];
      const w = Math.max(1, c.duration - 1);
      el.replaceChildren(
        ...frames.map((f) => {
          const d = h('span', { class: 'ec-key', style: { left: `${(Math.max(0, Math.min(w, f)) / w) * 100}%` }, title: timecode(f, this.seq.fps) });
          d.addEventListener('pointerdown', (e) => this.dragKey(e, c, getAnims, f, label, el));
          d.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const ease = (v: Ease) => () => this.set(c, 'Keyframe easing', (x) => {
              for (const a of getAnims(x)) {
                const k = a ? keyAt(a, f) : undefined;
                if (k) k.ease = v;
              }
            });
            const cur = anims.map((a) => keyAt(a, f)?.ease).find(Boolean) ?? 'linear';
            showMenu(
              [
                { label: 'Linear', checked: cur === 'linear', run: ease('linear') },
                { label: 'Ease in and out', checked: cur === 'ease', run: ease('ease') },
                { label: 'Ease in (slow start)', checked: cur === 'in', run: ease('in') },
                { label: 'Ease out (slow end)', checked: cur === 'out', run: ease('out') },
                { label: 'Hold (jump at the next keyframe)', checked: cur === 'hold', run: ease('hold') },
                { separator: true },
                { label: 'Delete keyframe', icon: L.Trash2, run: () => this.set(c, 'Delete keyframe', (x) => {
                  for (const a of getAnims(x)) if (a) removeKey(a, f);
                }) },
              ],
              { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY },
            );
          });
          return d;
        }),
        h('span', { class: 'ec-lane-ph', style: { left: `${(Math.max(0, Math.min(1, (this.app.playhead - c.start) / w))) * 100}%` } }),
      );
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.target !== el) return;
      // Clicking the lane moves the playhead inside the clip
      const r = el.getBoundingClientRect();
      const c = findClip(this.seq, clip.id)?.clip ?? clip;
      this.app.player.pause();
      this.app.setPlayhead(c.start + Math.round(((e.clientX - r.left) / r.width) * (c.duration - 1)));
    });
    draw();
    this.tickers.push(draw);
    return el;
  }

  private dragKey(e: PointerEvent, clip: Clip, getAnims: (c: Clip) => (Anim | undefined)[], from: number, label: string, lane: HTMLElement): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = lane.getBoundingClientRect();
    const live = this.app.liveEdit(`Move keyframe (${label})`);
    let cur = from;
    this.dragging++;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const f = Math.round(((ev.clientX - r.left) / r.width) * Math.max(1, clip.duration - 1));
      const to = Math.max(0, Math.min(clip.duration - 1, f));
      if (to === cur) return;
      const was = cur;
      live.update((s) => {
        const c = findClip(s, clip.id)?.clip;
        if (!c) return;
        for (const a of getAnims(c)) if (a && keyAt(a, was)) moveKey(a, was, to);
      });
      cur = to;
      this.app.setPlayhead(clip.start + to);
      target.style.left = `${(to / Math.max(1, clip.duration - 1)) * 100}%`;
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      this.dragging--;
      live.end();
      this.render();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  /**
   * A row for numbers that can have keyframes: label, stopwatch, value(s), keyframe arrows, lane.
   * Several getters make one row (Position's x and y).
   */
  private animRow(clip: Clip, label: string, get: Getter | Getter[], o: { min?: number; max?: number; step?: number; unit?: string; def: number | number[]; decimals?: number }): HTMLElement {
    const getters = Array.isArray(get) ? get : [get];
    const all = (c: Clip) => getters.map((g) => g(c));
    const cur = () => findClip(this.seq, clip.id)?.clip ?? clip;
    const animated = () => all(cur()).some((a) => !!a?.keys?.length);
    const watch = h('button', { class: `ec-watch${animated() ? ' on' : ''}`, 'aria-label': `Keyframes for ${label}`, onclick: () => {
      const on = !animated();
      const f = this.local(cur());
      this.set(clip, on ? `Keyframes on (${label})` : `Keyframes off (${label})`, (c) => {
        for (const a of all(c)) if (a) setAnimated(a, on, f);
      });
    } }, icon(L.Timer, 14));
    tooltip(watch, animated() ? 'Turn keyframes off (keeps the value at the playhead)' : 'Turn keyframes on: then each change adds a keyframe at the playhead');
    let live: ReturnType<App['liveEdit']> | null = null;
    const nums = getters.map((g, i) => {
      const s = scrubber({
        value: valueAt(g(cur()), this.local(cur()), Array.isArray(o.def) ? o.def[i] : o.def),
        min: o.min,
        max: o.max,
        step: o.step,
        unit: o.unit,
        decimals: o.decimals,
        onLive: (v) => {
          if (!live) {
            live = this.app.liveEdit(label);
            this.dragging++;
          }
          live.update((seq) => {
            const c = findClip(seq, clip.id)?.clip;
            const a = c && g(c);
            if (a) setValue(a, this.local(c), v);
          });
        },
        onEnd: () => {
          live?.end();
          live = null;
          this.dragging--;
          this.render();
        },
        onType: (v) => this.set(clip, label, (c) => {
          const a = g(c);
          if (a) setValue(a, this.local(c), v);
        }),
      });
      return s;
    });
    const nav = h('span', { class: 'ec-nav' });
    const tick = () => {
      const c = cur();
      const f = this.local(c);
      nums.forEach((n, i) => n.set(valueAt(getters[i](c), f, Array.isArray(o.def) ? o.def[i] : o.def)));
      const anims = all(c).filter((a): a is Anim => !!a);
      const on = anims.some((a) => a.keys?.length);
      // Hidden but still taking its place in the row's grid
      nav.style.visibility = on ? '' : 'hidden';
      const here = anims.some((a) => keyAt(a, f));
      nav.replaceChildren(
        h('button', { class: 'btn icon-only tiny', 'aria-label': 'Previous keyframe', onclick: () => {
          const k = anims.map((a) => nearKey(a, f, -1)?.f).filter((x): x is number => x !== undefined);
          if (k.length) this.app.setPlayhead(c.start + Math.max(...k));
        } }, icon(L.ChevronLeft, 12)),
        h('button', { class: `btn icon-only tiny ec-addkey${here ? ' on' : ''}`, 'aria-label': here ? 'Remove keyframe' : 'Add keyframe', onclick: () => this.set(c, here ? 'Remove keyframe' : 'Add keyframe', (x) => {
          for (const a of all(x)) if (a) (here ? removeKey(a, f) : addKey(a, f));
        }) }, icon(L.Diamond, 11)),
        h('button', { class: 'btn icon-only tiny', 'aria-label': 'Next keyframe', onclick: () => {
          const k = anims.map((a) => nearKey(a, f, 1)?.f).filter((x): x is number => x !== undefined);
          if (k.length) this.app.setPlayhead(c.start + Math.min(...k));
        } }, icon(L.ChevronRight, 12)),
      );
    };
    tick();
    this.tickers.push(tick);
    return h('div', { class: 'ec-row' }, watch, h('span', { class: 'ec-label' }, label), h('span', { class: 'ec-vals' }, ...nums), nav, this.lane(clip, all, label));
  }

  private plainRow(label: string, control: HTMLElement): HTMLElement {
    return h('div', { class: 'ec-row plain' }, h('span', { class: 'ec-watch-space' }), h('span', { class: 'ec-label' }, label), h('span', { class: 'ec-vals wide' }, control));
  }

  private colorRow(label: string, value: string, onChange: (v: string) => void): HTMLElement {
    const input = h('input', { type: 'color', class: 'color-input', value }) as HTMLInputElement;
    input.addEventListener('change', () => onChange(input.value));
    return this.plainRow(label, input);
  }

  private selectRow<T extends string>(label: string, options: [T, string][], value: T, onChange: (v: T) => void): HTMLElement {
    const sel = h('select', { class: 'input ec-select' }, ...options.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value as T));
    return this.plainRow(label, sel);
  }

  private checkRow(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const box = h('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
    box.addEventListener('change', () => onChange(box.checked));
    return this.plainRow(label, h('label', { class: 'check' }, box));
  }

  private resetAnim(clip: Clip, get: Getter, v: number): void {
    this.set(clip, 'Reset', (c) => {
      const a = get(c);
      if (a) {
        delete a.keys;
        a.v = v;
      }
    });
  }

  // ---------- sections ----------

  private motionSection(clip: Clip): HTMLElement {
    const s = this.seq;
    const m = clip.motion ?? defaultMotion(s);
    const rows = [
      this.animRow(clip, 'Position', [(c) => c.motion?.x, (c) => c.motion?.y], { step: 1, def: [s.width / 2, s.height / 2], decimals: 1 }),
      this.animRow(clip, m.uniform ? 'Scale' : 'Scale height', (c) => c.motion?.scale, { min: 0, max: 10000, step: 1, unit: '%', def: 100, decimals: 1 }),
    ];
    if (!m.uniform) rows.push(this.animRow(clip, 'Scale width', (c) => c.motion?.scaleW, { min: 0, max: 10000, step: 1, unit: '%', def: 100, decimals: 1 }));
    rows.push(
      this.checkRow('Uniform scale', m.uniform, (v) => this.set(clip, 'Uniform scale', (c) => {
        if (!c.motion) return;
        c.motion.uniform = v;
        if (!v) c.motion.scaleW = structuredClone(c.motion.scale);
      })),
      this.animRow(clip, 'Rotation', (c) => c.motion?.rotation, { step: 1, unit: '°', def: 0, decimals: 1 }),
      this.animRow(clip, 'Anchor point', [(c) => c.motion?.ax, (c) => c.motion?.ay], { step: 1, def: [0, 0], decimals: 1 }),
    );
    if (clip.kind === 'video' || clip.kind === 'image')
      rows.push(this.selectRow<Fit>('Fit to frame', [['fit', 'Fit inside'], ['fill', 'Fill (crop)'], ['stretch', 'Stretch'], ['none', 'Own size']], clip.fit ?? 'fit', (v) => this.set(clip, 'Fit to frame', (c) => (c.fit = v))));
    return this.section(`motion-${clip.id}`, 'Motion', rows, () => this.set(clip, 'Reset motion', (c) => (c.motion = defaultMotion(s))));
  }

  private opacitySection(clip: Clip): HTMLElement {
    return this.section(
      `opacity-${clip.id}`,
      'Opacity',
      [
        this.animRow(clip, 'Opacity', (c) => c.opacity, { min: 0, max: 100, step: 1, unit: '%', def: 100, decimals: 1 }),
        this.selectRow<BlendMode>('Blend mode', BLEND_MODES, clip.blend ?? 'normal', (v) => this.set(clip, 'Blend mode', (c) => (c.blend = v))),
      ],
      () => this.set(clip, 'Reset opacity', (c) => {
        c.opacity = { v: 100 };
        c.blend = 'normal';
      }),
    );
  }

  private timeSection(clip: Clip): HTMLElement {
    const speed = h('button', { class: 'btn small outline', onclick: () => this.app.commands.run('clip.speed') }, `${clip.reverse ? 'Reverse · ' : ''}${Math.round(clip.speed * 1000) / 10}%`);
    tooltip(speed, 'Speed / Duration…', 'Ctrl+R');
    const rows = [this.plainRow('Speed', speed)];
    if (clip.hold !== undefined) rows.push(this.plainRow('Frame hold', h('span', { class: 'hint' }, `Holding ${clip.hold.toFixed(2)}s`)));
    return this.section(`time-${clip.id}`, 'Time', rows);
  }

  private titleSections(clip: Clip): HTMLElement[] {
    const st = clip.title!;
    const setStyle = (label: string, patch: Partial<TitleStyle>) =>
      this.set(clip, label, (c) => {
        if (c.title) Object.assign(c.title, patch);
      });
    const text = h('textarea', { class: 'input ec-text', rows: 3, spellcheck: false }) as HTMLTextAreaElement;
    text.value = st.text;
    text.addEventListener('change', () => this.set(clip, 'Title text', (c) => {
      if (!c.title) return;
      c.title.text = text.value || ' ';
      c.name = (text.value.split('\n')[0] || 'Title').slice(0, 40);
    }));
    text.addEventListener('keydown', (e) => e.stopPropagation());
    const font = h('select', { class: 'input ec-select' }, h('option', { value: st.font }, st.font)) as HTMLSelectElement;
    void fontList().then((list) => {
      font.replaceChildren(...[...new Set([st.font, ...list])].map((f) => h('option', { value: f, style: { fontFamily: `"${f}"` } }, f)));
      font.value = st.font;
    });
    font.addEventListener('change', () => setStyle('Font', { font: font.value }));
    // Dragging these numbers changes the title live, as one undo step
    const liveNum = (label: string, key: 'size' | 'tracking' | 'strokeWidth' | 'shadowBlur' | 'shadowDistance' | 'boxPadding' | 'boxOpacity' | 'lineHeight', min: number, max: number, step = 1, unit = '') => {
      let live: ReturnType<App['liveEdit']> | null = null;
      return this.plainRow(
        label,
        scrubber({
          value: st[key] as number,
          min,
          max,
          step,
          unit,
          onLive: (v) => {
            if (!live) {
              live = this.app.liveEdit(label);
              this.dragging++;
            }
            live.update((s) => {
              const c = findClip(s, clip.id)?.clip;
              if (c?.title) (c.title as unknown as Record<string, number>)[key] = v;
            });
          },
          onEnd: () => {
            live?.end();
            live = null;
            this.dragging--;
            this.render();
          },
          onType: (v) => setStyle(label, { [key]: v }),
        }),
      );
    };
    const align = h(
      'span',
      { class: 'ctl-seg' },
      ...(['left', 'center', 'right'] as const).map((a) => {
        const b = h('button', { class: `btn seg${st.align === a ? ' on' : ''}`, 'aria-label': `Align ${a}`, onclick: () => setStyle('Align text', { align: a }) }, icon(a === 'left' ? L.AlignLeft : a === 'center' ? L.AlignCenter : L.AlignRight, 14));
        return b;
      }),
    );
    const styleBtns = h(
      'span',
      { class: 'ctl-seg' },
      h('button', { class: `btn seg${st.bold ? ' on' : ''}`, 'aria-label': 'Bold', onclick: () => setStyle('Bold', { bold: !st.bold }) }, icon(L.Bold, 14)),
      h('button', { class: `btn seg${st.italic ? ' on' : ''}`, 'aria-label': 'Italic', onclick: () => setStyle('Italic', { italic: !st.italic }) }, icon(L.Italic, 14)),
    );
    const pos = (label: string, key: 'x' | 'y') => {
      let live: ReturnType<App['liveEdit']> | null = null;
      return scrubber({
        value: Math.round(st[key] * 1000) / 10,
        min: -50,
        max: 150,
        step: 0.5,
        unit: '%',
        decimals: 1,
        onLive: (v) => {
          if (!live) {
            live = this.app.liveEdit(label);
            this.dragging++;
          }
          live.update((s) => {
            const c = findClip(s, clip.id)?.clip;
            if (c?.title) c.title[key] = v / 100;
          });
        },
        onEnd: () => {
          live?.end();
          live = null;
          this.dragging--;
          this.render();
        },
        onType: (v) => setStyle(label, { [key]: v / 100 }),
      });
    };
    const textRows = [
      h('div', { class: 'ec-row plain tall' }, h('span', { class: 'ec-watch-space' }), h('span', { class: 'ec-label' }, 'Text'), h('span', { class: 'ec-vals wide' }, text)),
      this.plainRow('Font', font),
      liveNum('Size', 'size', 4, 1000, 1, 'px'),
      this.plainRow('Style', h('span', { class: 'ec-inline' }, styleBtns, align)),
      this.colorRow('Color', st.color, (v) => setStyle('Text color', { color: v })),
      this.plainRow('Where', h('span', { class: 'ec-inline' }, pos('Text across', 'x'), pos('Text down', 'y'))),
    ];
    const look = [
      liveNum('Line spacing', 'lineHeight', 0.6, 3, 0.05),
      liveNum('Letter spacing', 'tracking', -20, 100, 1, 'px'),
      this.checkRow('Outline', st.strokeWidth > 0, (v) => setStyle('Outline', { strokeWidth: v ? Math.max(2, Math.round(st.size / 24)) : 0 })),
      ...(st.strokeWidth > 0 ? [this.colorRow('Outline color', st.stroke, (v) => setStyle('Outline color', { stroke: v })), liveNum('Outline width', 'strokeWidth', 0, 60, 1, 'px')] : []),
      this.checkRow('Shadow', st.shadow, (v) => setStyle('Shadow', { shadow: v })),
      ...(st.shadow ? [this.colorRow('Shadow color', st.shadowColor, (v) => setStyle('Shadow color', { shadowColor: v })), liveNum('Shadow blur', 'shadowBlur', 0, 100, 1, 'px'), liveNum('Shadow distance', 'shadowDistance', 0, 100, 1, 'px')] : []),
      this.checkRow('Background box', st.box, (v) => setStyle('Background box', { box: v })),
      ...(st.box ? [this.colorRow('Box color', st.boxColor, (v) => setStyle('Box color', { boxColor: v })), liveNum('Box opacity', 'boxOpacity', 0, 100, 1, '%'), liveNum('Box padding', 'boxPadding', 0, 200, 1, 'px')] : []),
    ];
    const edit = h('button', { class: 'btn small text', onclick: () => this.app.layout.program.editTitle(clip) }, icon(L.Pencil, 13), 'Edit in monitor');
    return [this.section('text', 'Text', textRows, undefined, [edit]), this.section('text-style', 'Text look', look)];
  }

  private effectSection(clip: Clip, e: Effect): HTMLElement {
    const def = EFFECTS_BY_ID.get(e.type);
    if (!def) return h('div');
    const getP = (id: string): Getter => (c) => {
      const v = c.effects.find((x) => x.id === e.id)?.params[id];
      return typeof v === 'object' ? v : undefined;
    };
    const setParam = (label: string, id: string, v: string | boolean) =>
      this.set(clip, label, (c) => {
        const x = c.effects.find((y) => y.id === e.id);
        if (x) x.params[id] = v;
      });
    const rows: HTMLElement[] = [];
    let group = '';
    for (const p of def.params) {
      if (p.group && p.group !== group) {
        group = p.group;
        rows.push(h('div', { class: 'ec-group' }, group));
      }
      rows.push(this.paramRow(clip, e, p, getP(p.id), (v) => setParam(p.label, p.id, v)));
    }
    const fx = h('button', { class: `ec-fx${e.enabled ? ' on' : ''}`, 'aria-label': e.enabled ? 'Turn the effect off' : 'Turn the effect on', onclick: () => this.set(clip, e.enabled ? 'Effect off' : 'Effect on', (c) => {
      const x = c.effects.find((y) => y.id === e.id);
      if (x) x.enabled = !x.enabled;
    }) }, 'fx');
    tooltip(fx, e.enabled ? 'On — click to bypass the effect' : 'Off — click to turn it back on');
    const more = h('button', { class: 'btn icon-only small', 'aria-label': 'Effect options', onclick: (ev: MouseEvent) => {
      const i = clip.effects.findIndex((x) => x.id === e.id);
      const items: MenuItem[] = [
        { label: 'Move up', disabled: i <= 0, run: () => this.set(clip, 'Reorder effects', (c) => {
          const j = c.effects.findIndex((x) => x.id === e.id);
          if (j > 0) [c.effects[j - 1], c.effects[j]] = [c.effects[j], c.effects[j - 1]];
        }) },
        { label: 'Move down', disabled: i >= clip.effects.length - 1, run: () => this.set(clip, 'Reorder effects', (c) => {
          const j = c.effects.findIndex((x) => x.id === e.id);
          if (j >= 0 && j < c.effects.length - 1) [c.effects[j + 1], c.effects[j]] = [c.effects[j], c.effects[j + 1]];
        }) },
        { label: 'Duplicate', run: () => this.set(clip, 'Duplicate effect', (c) => {
          const j = c.effects.findIndex((x) => x.id === e.id);
          if (j >= 0) c.effects.splice(j + 1, 0, { ...structuredClone(c.effects[j]), id: makeEffect(e.type).id });
        }) },
        { separator: true },
        { label: 'Remove effect', icon: L.Trash2, run: () => this.set(clip, `Remove ${def.name}`, (c) => (c.effects = c.effects.filter((x) => x.id !== e.id))) },
      ];
      showMenu(items, ev.currentTarget as HTMLElement);
    } }, icon(L.Ellipsis, 14));
    return this.section(`fx-${e.id}`, def.name, rows, () => this.set(clip, `Reset ${def.name}`, (c) => {
      const x = c.effects.find((y) => y.id === e.id);
      if (x) x.params = defaultParams(def.params);
    }), [fx, more]);
  }

  private paramRow(clip: Clip, e: Effect, p: ParamDef, get: Getter, setOther: (v: string | boolean) => void): HTMLElement {
    const v = e.params[p.id];
    switch (p.type) {
      case 'number':
        return this.animRow(clip, p.label, get, { min: p.min, max: p.max, step: p.step, unit: p.unit, def: p.default as number });
      case 'color':
        return this.colorRow(p.label, typeof v === 'string' ? v : (p.default as string), (x) => setOther(x));
      case 'bool':
        return this.checkRow(p.label, typeof v === 'boolean' ? v : !!p.default, (x) => setOther(x));
      case 'select':
        return this.selectRow(p.label, p.options ?? [], (typeof v === 'string' ? v : p.default) as string, (x) => setOther(x));
      case 'file': {
        const path = typeof v === 'string' ? v : '';
        const name = path ? path.split(/[\\/]/).pop()! : 'None';
        const pick = h('button', { class: 'btn small outline ec-file', title: path, onclick: async () => {
          const f = await platform.openTextDialog('lut');
          if (!f) return;
          try {
            parseCube(f.text);
            setOther(f.path);
          } catch (err) {
            toast(`That look can't be used: ${(err as Error).message}`, { kind: 'error' });
          }
        } }, icon(L.FolderOpen, 13), name);
        const clear = path ? h('button', { class: 'btn icon-only small', 'aria-label': 'No look', onclick: () => setOther('') }, icon(L.X, 13)) : null;
        return this.plainRow(p.label, h('span', { class: 'ec-inline' }, pick, clear));
      }
    }
  }

  private addEffectButton(video: Clip | null, audio: Clip | null): HTMLElement {
    const b = h('button', { class: 'btn small outline', onclick: () => {
      const add = (clip: Clip, id: string) => {
        const def = EFFECTS_BY_ID.get(id)!;
        this.set(clip, `Add ${def.name}`, (c) => c.effects.push(makeEffect(id)));
      };
      const groups = (kind: 'video' | 'audio', clip: Clip): MenuItem[] =>
        [...new Set(EFFECTS.filter((x) => x.kind === kind).map((x) => x.category))].map((cat) => ({
          label: cat,
          submenu: () => EFFECTS.filter((x) => x.kind === kind && x.category === cat).map((x) => ({ label: x.name, run: () => add(clip, x.id) })),
        }));
      const items: MenuItem[] = [];
      if (video) items.push({ label: 'Video effects', submenu: () => groups('video', video) });
      if (audio) items.push({ label: 'Audio effects', submenu: () => groups('audio', audio) });
      showMenu(items, b);
    } }, icon(L.Plus, 13), 'Effect');
    tooltip(b, 'Add an effect to this clip (or drag one from the Effects panel)');
    return b;
  }

  // ---------- transitions ----------

  private transitionView(clip: Clip, track: Track, side: 'in' | 'out'): HTMLElement[] {
    const tr = side === 'in' ? clip.transIn : clip.transOut;
    if (!tr) return [];
    const def = TRANSITIONS_BY_ID.get(tr.type);
    const s = this.seq;
    const setTr = (label: string, fn: (t: NonNullable<Clip['transIn']>) => void) =>
      this.set(clip, label, (c) => {
        const t = side === 'in' ? c.transIn : c.transOut;
        if (t) fn(t);
      });
    const kind = track.kind;
    const type = this.selectRow(
      'Transition',
      TRANSITIONS.filter((t) => t.kind === kind).map((t) => [t.id, t.name] as [string, string]),
      tr.type,
      (v) =>
        setTr('Change transition', (t) => {
          t.type = v;
          t.params = {};
        }),
    );
    const dur = scrubber({
      value: tr.duration,
      min: 1,
      max: clip.duration * 2,
      step: 1,
      unit: 'frames',
      onLive: () => undefined,
      onEnd: () => undefined,
      onType: (v) => setTr('Transition length', (t) => (t.duration = Math.round(v))),
    });
    const durText = h('button', { class: 'btn small text', onclick: async () => {
      const txt = await promptDialog('Transition length', 'Length (seconds or timecode)', (tr.duration / s.fps).toFixed(2) + 's');
      const f = txt ? parseTimecode(txt.includes(':') || /s$/i.test(txt) ? txt : `${txt}s`, s.fps) : null;
      if (f) setTr('Transition length', (t) => (t.duration = Math.max(1, f)));
    } }, shortDuration(tr.duration, s.fps));
    const rows = [type, this.plainRow('Length', h('span', { class: 'ec-inline' }, dur, durText))];
    const prev = track.clips.find((c) => clipEnd(c) === clip.start);
    if (side === 'in' && prev)
      rows.push(
        this.selectRow<'center' | 'start' | 'end'>('Alignment', [['center', 'Center at cut'], ['start', 'Start at cut'], ['end', 'End at cut']], tr.align, (v) =>
          this.app.edit('Transition alignment', (seq) => {
            const c = findClip(seq, clip.id)?.clip;
            if (!c?.transIn) return false;
            applyTransition(seq, c.id, 'in', c.transIn.type, c.transIn.duration, v);
          }),
        ),
      );
    for (const p of def?.params ?? []) {
      const v = tr.params?.[p.id];
      if (p.type === 'select') rows.push(this.selectRow(p.label, p.options ?? [], (typeof v === 'string' ? v : p.default) as string, (x) => setTr(p.label, (t) => (t.params = { ...t.params, [p.id]: x }))));
      else if (p.type === 'number') {
        const cur = typeof v === 'object' ? v.v : (p.default as number);
        rows.push(this.plainRow(p.label, scrubber({ value: cur, min: p.min, max: p.max, step: p.step, unit: p.unit, onLive: () => undefined, onEnd: () => undefined, onType: (x) => setTr(p.label, (t) => (t.params = { ...t.params, [p.id]: { v: x } })) })));
      }
    }
    const del = h('button', { class: 'btn small outline', onclick: () => this.app.commands.run('edit.clear') }, icon(L.Trash2, 13), 'Remove');
    return [
      h('div', { class: 'ec-head' }, h('div', { class: 'ec-title' }, h('span', { class: 'ec-name' }, def?.name ?? tr.type), h('span', { class: 'hint' }, def?.description ?? '')), del),
      this.section('transition', 'Transition', rows),
    ];
  }
}
