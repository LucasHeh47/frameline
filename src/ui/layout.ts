// The window's panels, arranged like Premiere's Editing workspace: Source / Effect Controls / Lumetri
// / Audio Mixer at the top left, the Program monitor at the top right, Project / Effects / Markers /
// History at the bottom left, then the tools, the Timeline and the master meters. The splits can be
// dragged; workspaces (Editing, Color, Audio, Effects) bring the right tabs forward.
import type { App, Workspace } from './app';
import { h } from './dom';
import { EffectControls } from './panels/effectControls';
import { EffectsPanel } from './panels/effects';
import { HistoryPanel } from './panels/history';
import { LumetriPanel } from './panels/lumetri';
import { MarkersPanel } from './panels/markers';
import { MasterMeters, MixerPanel } from './panels/mixer';
import { ProgramMonitor } from './panels/program';
import { ProjectPanel } from './panels/project';
import { SourceMonitor } from './panels/source';
import { Timeline } from './timeline/Timeline';
import { ToolsStrip } from './timeline/tools';

export interface Panel {
  readonly id: string;
  readonly title: string;
  readonly el: HTMLElement;
  /** The panel became visible (its tab was chosen). */
  shown?(): void;
}

const WORKSPACE_TABS: Record<Workspace, Record<string, string>> = {
  editing: { topLeft: 'source', bottomLeft: 'project' },
  color: { topLeft: 'lumetri', bottomLeft: 'project' },
  audio: { topLeft: 'mixer', bottomLeft: 'project' },
  effects: { topLeft: 'effectControls', bottomLeft: 'effects' },
};

export const WORKSPACES: [Workspace, string][] = [
  ['editing', 'Editing'],
  ['color', 'Color'],
  ['audio', 'Audio'],
  ['effects', 'Effects'],
];

class TabGroup {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private body: HTMLElement;
  current: Panel;

  constructor(
    readonly id: string,
    readonly panels: Panel[],
    private onSwitch: (p: Panel) => void,
  ) {
    this.bar = h('div', { class: 'tabs-bar', role: 'tablist' });
    this.body = h('div', { class: 'tabs-body' });
    this.el = h('section', { class: `panel-group group-${id}` }, this.bar, this.body);
    for (const p of panels) {
      p.el.classList.add('panel');
      this.body.append(p.el);
    }
    this.current = panels[0];
    this.render();
  }

  show(id: string): void {
    const p = this.panels.find((x) => x.id === id);
    if (!p) return;
    this.current = p;
    this.render();
    this.onSwitch(p);
    p.shown?.();
  }

  private render(): void {
    this.bar.replaceChildren(
      ...this.panels.map((p) =>
        h('button', { class: `tab-btn${p === this.current ? ' on' : ''}`, role: 'tab', 'aria-selected': p === this.current ? 'true' : 'false', onclick: () => this.show(p.id) }, p.title),
      ),
    );
    for (const p of this.panels) p.el.hidden = p !== this.current;
  }
}

export class Layout {
  readonly el: HTMLElement;
  readonly source: SourceMonitor;
  readonly effectControls: EffectControls;
  readonly lumetri: LumetriPanel;
  readonly mixer: MixerPanel;
  readonly program: ProgramMonitor;
  readonly project: ProjectPanel;
  readonly effects: EffectsPanel;
  readonly markers: MarkersPanel;
  readonly history: HistoryPanel;
  readonly timeline: Timeline;
  readonly tools: ToolsStrip;
  readonly meters: MasterMeters;
  private groups: TabGroup[];
  /** The panel clicked last (keys like I, O and Space go to the Source monitor after it's clicked). */
  lastPanel = 'timeline';
  private top: HTMLElement;
  private bottom: HTMLElement;
  private topLeftEl: HTMLElement;
  private bottomLeftEl: HTMLElement;

  constructor(private app: App) {
    this.source = new SourceMonitor(app);
    this.effectControls = new EffectControls(app);
    this.lumetri = new LumetriPanel(app);
    this.mixer = new MixerPanel(app);
    this.program = new ProgramMonitor(app);
    this.project = new ProjectPanel(app);
    this.effects = new EffectsPanel(app);
    this.markers = new MarkersPanel(app);
    this.history = new HistoryPanel(app);
    this.timeline = new Timeline(app);
    this.tools = new ToolsStrip(app);
    this.meters = new MasterMeters(app);

    const remember = (g: TabGroup) => (p: Panel) => {
      app.prefs.tabs[`${app.prefs.workspace}:${g.id}`] = p.id;
      app.savePrefs();
    };
    const topLeft: TabGroup = new TabGroup('topLeft', [this.source, this.effectControls, this.lumetri, this.mixer], (p) => remember(topLeft)(p));
    const bottomLeft: TabGroup = new TabGroup('bottomLeft', [this.project, this.effects, this.markers, this.history], (p) => remember(bottomLeft)(p));
    const program = new TabGroup('program', [this.program], () => undefined);
    const timeline = new TabGroup('timeline', [this.timeline], () => undefined);
    this.groups = [topLeft, bottomLeft, program, timeline];
    for (const g of this.groups) g.el.addEventListener('pointerdown', () => (this.lastPanel = g.current.id), true);

    this.topLeftEl = topLeft.el;
    this.bottomLeftEl = bottomLeft.el;
    const vSplitTop = this.splitter('col', (dx) => this.resize('topLeft', dx));
    const vSplitBottom = this.splitter('col', (dx) => this.resize('bottomLeft', dx));
    const hSplit = this.splitter('row', (_dx, dy) => this.resize('top', dy));
    this.top = h('div', { class: 'ws-row ws-top' }, topLeft.el, vSplitTop, program.el);
    this.bottom = h('div', { class: 'ws-row ws-bottom' }, bottomLeft.el, vSplitBottom, this.tools.el, timeline.el, this.meters.el);
    this.el = h('main', { class: 'workspace' }, this.top, hSplit, this.bottom);
    this.applySizes();
    this.setWorkspace(app.prefs.workspace, false);
    window.addEventListener('resize', () => this.applySizes());
  }

  /** Brings a panel forward (its tab). */
  show(id: string): void {
    for (const g of this.groups) if (g.panels.some((p) => p.id === id)) g.show(id);
  }

  isShown(id: string): boolean {
    return this.groups.some((g) => g.current.id === id);
  }

  setWorkspace(w: Workspace, save = true): void {
    this.app.prefs.workspace = w;
    for (const g of this.groups) {
      const want = this.app.prefs.tabs[`${w}:${g.id}`] ?? WORKSPACE_TABS[w][g.id];
      if (want) g.show(want);
    }
    if (save) this.app.savePrefs();
    this.app.emit('settings');
  }

  private splitter(dir: 'row' | 'col', onDrag: (dx: number, dy: number) => void): HTMLElement {
    const el = h('div', { class: `splitter splitter-${dir}`, role: 'separator', 'aria-orientation': dir === 'row' ? 'horizontal' : 'vertical' });
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      let x = e.clientX;
      let y = e.clientY;
      el.classList.add('on');
      const move = (ev: PointerEvent) => {
        onDrag(ev.clientX - x, ev.clientY - y);
        x = ev.clientX;
        y = ev.clientY;
      };
      const up = () => {
        el.classList.remove('on');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        this.app.savePrefs();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    return el;
  }

  private resize(which: 'top' | 'topLeft' | 'bottomLeft', d: number): void {
    const p = this.app.prefs;
    const W = Math.max(1, this.el.clientWidth);
    const H = Math.max(1, this.el.clientHeight);
    if (which === 'top') p.topRow = Math.max(0.2, Math.min(0.8, p.topRow + d / H));
    else if (which === 'topLeft') p.topLeft = Math.max(0.15, Math.min(0.7, p.topLeft + d / W));
    else p.bottomLeft = Math.max(0.12, Math.min(0.6, p.bottomLeft + d / W));
    this.applySizes();
  }

  private applySizes(): void {
    const p = this.app.prefs;
    this.top.style.flex = `${p.topRow} 1 0`;
    this.bottom.style.flex = `${1 - p.topRow} 1 0`;
    this.topLeftEl.style.flex = `0 0 ${(p.topLeft * 100).toFixed(2)}%`;
    this.bottomLeftEl.style.flex = `0 0 ${(p.bottomLeft * 100).toFixed(2)}%`;
    this.app.emit('settings');
  }
}
