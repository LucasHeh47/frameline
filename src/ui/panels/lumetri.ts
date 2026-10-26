// The Lumetri Color panel: color correction for the selected clip with sliders (white balance,
// exposure, contrast, highlights and shadows, saturation), a look (LUT) and a vignette, plus Auto,
// which corrects from the frame at the playhead. It edits the clip's Lumetri Color effect.
import * as L from 'lucide';
import { EFFECTS_BY_ID, defaultParams, makeEffect, numParam, strParam, type Effect } from '../../core/effects';
import { autoCorrect } from '../../core/analysis';
import { parseCube } from '../../core/lut';
import { findClip, type Clip } from '../../core/project';
import type { App } from '../app';
import { slider } from '../controls';
import { h, icon } from '../dom';
import type { Panel } from '../layout';
import { platform } from '../platform';
import { toast, tooltip } from '../widgets';

export class LumetriPanel implements Panel {
  readonly id = 'lumetri';
  readonly title = 'Lumetri Color';
  readonly el: HTMLElement;
  private body: HTMLElement;
  private dragging = false;
  private queued = false;

  constructor(private app: App) {
    this.body = h('div', { class: 'lum-body' });
    this.el = h('div', { class: 'lumetri' }, this.body);
    for (const k of ['selection', 'project', 'sequence'] as const) app.on(k, () => this.request());
    this.request();
  }

  request(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      if (!this.dragging && this.app.layout?.isShown(this.id)) this.render();
    });
  }

  shown(): void {
    this.render();
  }

  private target(): Clip | null {
    const f = this.app.focusClip();
    return f && f.clip.kind !== 'audio' ? f.clip : null;
  }

  private effectOf(c: Clip): Effect | undefined {
    return c.effects.find((e) => e.type === 'lumetri');
  }

  /** Changes the clip's Lumetri effect (adding it the first time). */
  private change(clip: Clip, s: { effects: Effect[] } | undefined, fn: (e: Effect) => void): void {
    if (!s) return;
    let e = s.effects.find((x) => x.type === 'lumetri');
    if (!e) {
      e = makeEffect('lumetri');
      s.effects.push(e);
    }
    fn(e);
  }

  private render(): void {
    const app = this.app;
    const clip = this.target();
    if (!app.project || !clip) {
      this.body.replaceChildren(h('div', { class: 'ec-empty' }, icon(L.Palette, 26), h('p', null, 'Select a video clip on the timeline to color correct it.'), h('p', { class: 'hint' }, 'Tip: put an adjustment layer above several clips to grade them all at once.')));
      return;
    }
    const def = EFFECTS_BY_ID.get('lumetri')!;
    const e = this.effectOf(clip);
    const local = Math.max(0, app.playhead - clip.start);
    const val = (id: string) => (e ? numParam(e, id, local) : (def.params.find((p) => p.id === id)!.default as number));
    const groups: { title: string; ids: string[] }[] = [
      { title: 'White balance', ids: ['temperature', 'tint'] },
      { title: 'Tone', ids: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'] },
      { title: 'Color', ids: ['saturation', 'vibrance'] },
      { title: 'Creative', ids: ['faded', 'lutAmount'] },
      { title: 'Vignette', ids: ['vignette', 'vigMidpoint', 'vigRoundness', 'vigFeather'] },
    ];
    let live: ReturnType<App['liveEdit']> | null = null;
    const sliderFor = (id: string) => {
      const p = def.params.find((x) => x.id === id)!;
      const animated = !!(e && typeof e.params[id] === 'object' && (e.params[id] as { keys?: unknown[] }).keys?.length);
      const set = (v: number) => (fx: Effect) => {
        const a = fx.params[id];
        if (typeof a === 'object') {
          if (a.keys?.length) {
            // Keyframed in Effect Controls: this changes the keyframe at the playhead
            const k = a.keys.find((x) => x.f === Math.round(local));
            if (k) k.v = v;
            else a.v = v;
          } else a.v = v;
        }
      };
      const el = slider({
        label: p.label,
        min: p.min!,
        max: p.max!,
        step: p.step,
        value: Number(val(id).toFixed(2)),
        unit: p.unit,
        onInput: (v) => {
          if (!live) {
            live = app.liveEdit(`Lumetri: ${p.label}`);
            this.dragging = true;
          }
          live.update((s) => this.change(clip, findClip(s, clip.id)?.clip, set(v)));
        },
        onChange: (v) => {
          if (live) {
            live.end();
            live = null;
            this.dragging = false;
          } else app.edit(`Lumetri: ${p.label}`, (s) => this.change(clip, findClip(s, clip.id)?.clip, set(v)));
        },
      });
      el.classList.add('lum-slider');
      // Double-clicking the label resets it
      el.querySelector('.ctl-label')?.addEventListener('dblclick', () => app.edit(`Reset ${p.label}`, (s) => this.change(clip, findClip(s, clip.id)?.clip, set(p.default as number))));
      if (animated) el.title = 'This setting has keyframes; the slider changes the value at the playhead.';
      return el;
    };
    const lutPath = e ? strParam(e, 'lut') : '';
    const lutBtn = h('button', { class: 'btn small outline', title: lutPath, onclick: async () => {
      const f = await platform.openTextDialog('lut');
      if (!f) return;
      try {
        parseCube(f.text);
      } catch (err) {
        toast(`That look can't be used: ${(err as Error).message}`, { kind: 'error' });
        return;
      }
      app.edit('Lumetri: look', (s) => this.change(clip, findClip(s, clip.id)?.clip, (fx) => (fx.params.lut = f.path)));
    } }, icon(L.FolderOpen, 13), lutPath ? lutPath.split(/[\\/]/).pop()! : 'Choose a look (.cube)…');
    const lutClear = lutPath ? h('button', { class: 'btn icon-only small', 'aria-label': 'No look', onclick: () => app.edit('Lumetri: no look', (s) => this.change(clip, findClip(s, clip.id)?.clip, (fx) => (fx.params.lut = ''))) }, icon(L.X, 13)) : null;
    const auto = h('button', { class: 'btn small primary', onclick: () => this.auto(clip) }, icon(L.Wand2, 13), 'Auto');
    tooltip(auto, 'Corrects exposure, contrast and white balance from the frame at the playhead');
    const reset = h('button', { class: 'btn small outline', disabled: !e, onclick: () => app.edit('Reset Lumetri', (s) => {
      const c = findClip(s, clip.id)?.clip;
      const fx = c && this.effectOf(c);
      if (fx) fx.params = defaultParams(def.params);
    }) }, icon(L.RotateCcw, 13), 'Reset');
    const onOff = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: e ? e.enabled : true, disabled: !e, onchange: (ev: Event) => app.edit('Lumetri on/off', (s) => {
      const c = findClip(s, clip.id)?.clip;
      const fx = c && this.effectOf(c);
      if (fx) fx.enabled = (ev.target as HTMLInputElement).checked;
    }) }), h('span', null, 'On'));
    this.body.replaceChildren(
      h('div', { class: 'lum-head' }, h('div', { class: 'ec-title' }, h('span', { class: 'ec-name' }, clip.name), h('span', { class: 'hint' }, e ? 'Lumetri Color' : 'Move a slider to start')), onOff, auto, reset),
      ...groups.map((g) =>
        h(
          'section',
          { class: 'lum-group' },
          h('div', { class: 'lum-title' }, g.title),
          ...(g.title === 'Creative' ? [h('div', { class: 'lum-lut' }, lutBtn, lutClear)] : []),
          ...g.ids.map(sliderFor),
        ),
      ),
      h('p', { class: 'hint lum-foot' }, 'Double-click a slider’s name to reset it. Keyframes for these are in Effect Controls.'),
    );
  }

  private auto(clip: Clip): void {
    // Measured without this clip's current correction, so Auto doesn't build on itself
    const before = structuredClone(this.app.project!);
    const c = before.sequences.flatMap((s) => [...s.video, ...s.audio]).flatMap((t) => t.clips).find((x) => x.id === clip.id);
    for (const e of c?.effects ?? []) if (e.type === 'lumetri') e.enabled = false;
    const sample = this.app.layout.program.sample(before);
    if (!sample) return;
    const fix = autoCorrect(sample.data);
    this.app.edit('Lumetri: Auto', (s) =>
      this.change(clip, findClip(s, clip.id)?.clip, (fx) => {
        for (const [k, v] of Object.entries(fix)) {
          const a = fx.params[k];
          if (typeof a === 'object') a.v = v;
        }
      }),
    );
  }
}
