// The Effects panel: presets, video and audio effects, and transitions, grouped and searchable.
// Drag one onto a clip (or a transition onto a cut), or double-click to apply it to the selected clips.
import * as L from 'lucide';
import { applyTransition } from '../../core/edit';
import { EFFECTS, TRANSITIONS, makeEffect } from '../../core/effects';
import { PRESETS } from '../../core/presets';
import { findClip } from '../../core/project';
import type { App } from '../app';
import { h, icon } from '../dom';
import type { Panel } from '../layout';
import { toast, tooltip } from '../widgets';

interface Item {
  kind: 'effect' | 'transition' | 'preset';
  id: string;
  name: string;
  media: 'video' | 'audio';
  description: string;
  category: string;
}

const ITEMS: Item[] = [
  ...PRESETS.map((p) => ({ kind: 'preset' as const, id: p.id, name: p.name, media: p.kind, description: p.description, category: 'Presets' })),
  ...EFFECTS.map((e) => ({ kind: 'effect' as const, id: e.id, name: e.name, media: e.kind, description: e.description + (e.keywords ? ` ${e.keywords}` : ''), category: `${e.kind === 'video' ? 'Video Effects' : 'Audio Effects'}/${e.category}` })),
  ...TRANSITIONS.map((t) => ({ kind: 'transition' as const, id: t.id, name: t.name, media: t.kind, description: t.description, category: `${t.kind === 'video' ? 'Video Transitions' : 'Audio Transitions'}/${t.category}` })),
];

const TOP = ['Presets', 'Video Effects', 'Video Transitions', 'Audio Effects', 'Audio Transitions'];

export class EffectsPanel implements Panel {
  readonly id = 'effects';
  readonly title = 'Effects';
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private open = new Set<string>(['Presets', 'Video Effects', 'Video Transitions']);

  constructor(private app: App) {
    this.search = h('input', { class: 'input proj-search', type: 'search', placeholder: 'Search effects and transitions', 'aria-label': 'Search effects' }) as HTMLInputElement;
    this.search.addEventListener('input', () => this.render());
    this.list = h('div', { class: 'fx-list' });
    this.el = h('div', { class: 'effects-panel' }, h('div', { class: 'proj-bar' }, this.search), this.list);
    this.render();
  }

  private render(): void {
    const q = this.search.value.trim().toLowerCase();
    const out: HTMLElement[] = [];
    if (q) {
      const hits = ITEMS.filter((i) => `${i.name} ${i.description} ${i.category}`.toLowerCase().includes(q));
      out.push(...hits.map((i) => this.itemEl(i, true)));
      if (!hits.length) out.push(h('p', { class: 'hint fx-none' }, 'Nothing found.'));
      this.list.replaceChildren(...out);
      return;
    }
    for (const top of TOP) {
      const items = ITEMS.filter((i) => i.category === top || i.category.startsWith(`${top}/`));
      const isOpen = this.open.has(top);
      out.push(this.folder(top, isOpen, 0));
      if (!isOpen) continue;
      const subs = [...new Set(items.map((i) => i.category.split('/')[1]).filter(Boolean))];
      if (!subs.length) out.push(...items.map((i) => this.itemEl(i)));
      for (const sub of subs) {
        const key = `${top}/${sub}`;
        const subOpen = this.open.has(key);
        out.push(this.folder(key, subOpen, 1, sub));
        if (subOpen) out.push(...items.filter((i) => i.category === key).map((i) => this.itemEl(i)));
      }
    }
    this.list.replaceChildren(...out);
  }

  private folder(key: string, isOpen: boolean, depth: number, label = key): HTMLElement {
    return h('button', { class: `fx-folder d${depth}`, 'aria-expanded': isOpen ? 'true' : 'false', onclick: () => {
      if (isOpen) this.open.delete(key);
      else this.open.add(key);
      this.render();
    } }, icon(isOpen ? L.ChevronDown : L.ChevronRight, 13), icon(isOpen ? L.FolderOpen : L.Folder, 14), label);
  }

  private itemEl(i: Item, flat = false): HTMLElement {
    const ic = i.kind === 'transition' ? L.Blend : i.kind === 'preset' ? L.WandSparkles : i.media === 'audio' ? L.AudioLines : L.Sparkles;
    const el = h('div', { class: `fx-item${flat ? '' : ' nested'}`, draggable: 'true', tabindex: '0' }, icon(ic, 14), h('span', null, i.name), flat ? h('span', { class: 'hint fx-cat' }, i.category.replace('/', ' › ')) : null);
    tooltip(el, `${i.description.split('. ')[0].replace(/\.$/, '')}. Drag onto a clip, or double-click to apply it to the selected clips.`);
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('application/x-frameline-effect', JSON.stringify({ kind: i.kind === 'preset' ? 'preset' : i.kind, id: i.id }));
      e.dataTransfer!.effectAllowed = 'copy';
    });
    el.addEventListener('dblclick', () => this.apply(i));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.apply(i);
    });
    return el;
  }

  /** Applies an effect, preset or transition to the selected clips (of the right kind). */
  apply(i: Item): void {
    const app = this.app;
    const targets = app.selectedClips().filter(({ clip }) => (i.media === 'audio' ? clip.kind === 'audio' : clip.kind !== 'audio'));
    if (!targets.length) {
      toast(i.media === 'audio' ? 'Select an audio clip first (or drag it onto one).' : 'Select a video clip first (or drag it onto one).');
      return;
    }
    const ids = targets.map((t) => t.clip.id);
    if (i.kind === 'transition') {
      const frames = Math.max(1, Math.round(app.settings.num(i.media === 'audio' ? 'timeline.audioTransitionSeconds' : 'timeline.transitionSeconds') * app.fps));
      app.edit(`Add ${i.name}`, (s) => {
        let n = 0;
        for (const id of ids) {
          if (applyTransition(s, id, 'in', i.id, frames)) n++;
          if (applyTransition(s, id, 'out', i.id, frames)) n++;
        }
        return n > 0;
      });
      return;
    }
    app.edit(`Add ${i.name}`, (s) => {
      for (const id of ids) {
        const c = findClip(s, id)?.clip;
        if (!c) continue;
        if (i.kind === 'preset') PRESETS.find((p) => p.id === i.id)?.apply(c, s);
        else c.effects.push(makeEffect(i.id));
      }
    });
    app.layout.show(i.id === 'lumetri' ? 'lumetri' : 'effectControls');
  }
}
