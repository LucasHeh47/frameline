// The top bar: the app switcher and logo, the menus (File, Edit, Clip, Sequence…), undo / redo,
// the workspaces (Editing, Color, Audio, Effects), command search, settings and the theme button.
// Menus are built from commands each time they open, so checks and disabled items are current.
import * as L from 'lucide';
import { TITLE_PRESETS } from '../core/project';
import type { App } from './app';
import { h, icon, kbd } from './dom';
import { WORKSPACES } from './layout';
import { openPalette } from './palette';
import { isDesktop, platform } from './platform';
import { suiteButton } from './suiteMenu';
import { showMenu, tooltip, type MenuItem, type Popover } from './widgets';

type MenuSpec = (string | '-' | { label: string; icon?: L.IconNode; items: () => MenuSpec })[];

export class TitleBar {
  readonly el: HTMLElement;
  private themeBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private workspaces!: HTMLElement;
  private menus: { label: string; spec: () => MenuSpec; btn?: HTMLButtonElement }[];
  private open: { index: number; pop: Popover } | null = null;

  constructor(private app: App) {
    this.el = h('header', { class: 'titlebar' });
    this.menus = [
      { label: 'File', spec: () => ['file.new', 'file.newSequence', 'file.open', 'file.home', '-', 'file.save', 'file.saveAs', '-', 'file.import', { label: 'Captions', icon: L.Captions, items: () => ['file.importCaptions', 'file.exportCaptions'] }, '-', 'file.export', 'file.exportFrame', '-', 'file.showInFolder', 'file.newWindow', '-', 'app.settings'] },
      { label: 'Edit', spec: () => ['edit.undo', 'edit.redo', '-', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.pasteInsert', 'edit.pasteAttributes', '-', 'edit.clear', 'edit.rippleDelete', 'edit.duplicate', '-', 'edit.selectAll', 'edit.deselect', '-', 'app.settings'] },
      {
        label: 'Clip',
        spec: () => ['clip.speed', 'clip.frameHold', '-', 'clip.enable', 'clip.link', 'clip.rename', '-', 'clip.audioGain', 'clip.normalize', '-', 'clip.scenes', '-', 'clip.insert', 'clip.overwrite', 'clip.matchFrame', '-', 'clip.nudgeLeft', 'clip.nudgeRight'],
      },
      {
        label: 'Sequence',
        spec: () => [
          'sequence.settings',
          '-',
          'sequence.razor',
          'sequence.razorAll',
          'sequence.trimPrev',
          'sequence.trimNext',
          '-',
          'sequence.transition',
          'sequence.audioTransition',
          'sequence.transitionsSelected',
          '-',
          'edit.lift',
          'edit.extract',
          'sequence.closeGap',
          '-',
          'sequence.addVideoTrack',
          'sequence.addAudioTrack',
          '-',
          'timeline.snap',
          'timeline.linked',
        ],
      },
      { label: 'Markers', spec: () => ['mark.in', 'mark.out', 'mark.clip', '-', 'go.in', 'go.out', '-', 'mark.clearIn', 'mark.clearOut', 'mark.clear', '-', 'marker.add', 'marker.next', 'marker.prev', 'marker.clear', 'marker.clearAll'] },
      { label: 'Graphics', spec: () => ['graphics.title', { label: 'New title from a style', icon: L.Type, items: () => TITLE_PRESETS.slice(1).map((p) => `graphics.title.${p.id}`) }, '-', 'graphics.colorMatte', 'graphics.adjustment', '-', 'file.importCaptions', 'file.exportCaptions'] },
      {
        label: 'View',
        spec: () => [
          'play.toggle',
          'play.inOut',
          'play.loop',
          '-',
          { label: 'Playback resolution', icon: L.MonitorPlay, items: () => ['view.res1', 'view.res0.5', 'view.res0.25'] },
          'view.safeMargins',
          '-',
          'view.zoomIn',
          'view.zoomOut',
          'view.fit',
          '-',
          { label: 'Workspace', icon: L.LayoutDashboard, items: () => WORKSPACES.map(([w]) => `workspace.${w}`) },
          { label: 'Panels', icon: L.PanelsTopLeft, items: () => ['panel.project', 'panel.source', 'panel.effectControls', 'panel.lumetri', 'panel.mixer', 'panel.effects', 'panel.markers', 'panel.history'] },
          '-',
          'view.theme',
          'view.fullscreen',
        ],
      },
      { label: 'Help', spec: () => ['help.palette', 'help.shortcuts', '-', 'help.whatsNew', 'help.updates', '-', 'help.about'] },
    ];
    this.rebuild();
    app.commands.onRefresh(() => this.refresh());
    app.on('settings', () => this.renderWorkspaces());
  }

  rebuild(): void {
    const app = this.app;
    const brand = h('button', { class: 'brand', 'aria-label': 'Frameline start page', onclick: () => app.openHome('home') }, h('span', { class: 'brand-mark' }, icon(L.Clapperboard, 14)), 'Frameline');
    tooltip(brand, 'Start page: new and recent projects');
    const bar = h('nav', { class: 'menubar', role: 'menubar' });
    this.menus.forEach((m, i) => {
      const b = h('button', { class: 'menubar-item', role: 'menuitem', 'aria-haspopup': 'menu', onclick: () => this.openMenu(i) }, m.label) as HTMLButtonElement;
      b.addEventListener('mouseenter', () => {
        if (this.open && this.open.index !== i && this.open.pop.isOpen) this.openMenu(i);
      });
      m.btn = b;
      bar.append(b);
    });
    this.undoBtn = h('button', { class: 'btn', 'aria-label': 'Undo', onclick: () => app.commands.run('edit.undo') }, icon(L.Undo2, 16)) as HTMLButtonElement;
    tooltip(this.undoBtn, () => (app.history.undoLabel ? `Undo ${app.history.undoLabel}` : 'Undo'), 'Ctrl+Z');
    this.redoBtn = h('button', { class: 'btn', 'aria-label': 'Redo', onclick: () => app.commands.run('edit.redo') }, icon(L.Redo2, 16)) as HTMLButtonElement;
    tooltip(this.redoBtn, () => (app.history.redoLabel ? `Redo ${app.history.redoLabel}` : 'Redo'), 'Ctrl+Shift+Z');
    const search = app.settings.bool('appearance.showSearch')
      ? h('div', { class: 'cmd-search', role: 'button', tabindex: '0', onclick: () => openPalette(app) }, icon(L.Search, 14), h('span', { class: 'label' }, 'Search commands…'), kbd('Ctrl+Shift+P'))
      : null;
    this.workspaces = h('div', { class: 'ws-switch', role: 'tablist', 'aria-label': 'Workspaces' });
    this.renderWorkspaces();
    this.themeBtn = h('button', { class: 'btn', 'aria-label': 'Switch light / dark theme', onclick: () => app.commands.run('view.theme') }) as HTMLButtonElement;
    tooltip(this.themeBtn, 'Switch light / dark theme');
    const settings = h('button', { class: 'btn', 'aria-label': 'Settings', onclick: () => app.openSettings() }, icon(L.Settings, 16));
    tooltip(settings, 'Settings', 'Ctrl+,');
    const exportBtn = h('button', { class: 'btn primary small export-btn', onclick: () => app.commands.run('file.export') }, icon(L.Upload, 14), 'Export');
    tooltip(exportBtn, 'Export the video', 'Ctrl+M');
    this.el.replaceChildren(
      ...[
        suiteButton(),
        brand,
        bar,
        h('div', { class: 'quick-access' }, this.undoBtn, this.redoBtn),
        h('div', { class: 'spacer' }),
        this.workspaces,
        h('div', { class: 'spacer' }),
        search,
        exportBtn,
        settings,
        this.themeBtn,
        isDesktop && platform.platform !== 'darwin' ? h('div', { class: 'controls-gap' }) : null,
      ].filter((x): x is HTMLElement => !!x),
    );
    this.refresh();
  }

  private renderWorkspaces(): void {
    if (!this.workspaces) return;
    const cur = this.app.prefs.workspace;
    this.workspaces.replaceChildren(
      ...WORKSPACES.map(([w, label], i) => {
        const b = h('button', { class: `ws-btn${w === cur ? ' on' : ''}`, role: 'tab', 'aria-selected': w === cur ? 'true' : 'false', onclick: () => this.app.layout.setWorkspace(w) }, label);
        tooltip(b, `${label} workspace`, `Alt+Shift+${i + 1}`);
        return b;
      }),
    );
  }

  refresh(): void {
    const app = this.app;
    if (!this.themeBtn) return;
    this.themeBtn.replaceChildren(icon(app.isDark ? L.Sun : L.Moon, 16));
    this.undoBtn.disabled = !app.history.canUndo;
    this.redoBtn.disabled = !app.history.canRedo;
    const p = app.project;
    const name = p ? (app.settings.bool('appearance.titlePath') && app.projectPath ? app.projectPath : p.name) : '';
    platform.setTitle(p ? `${name}${app.history.dirty && app.history.undoCount ? ' •' : ''} — Frameline` : 'Frameline');
  }

  private openMenu(i: number): void {
    const m = this.menus[i];
    if (!m.btn) return;
    this.open?.pop.close();
    this.menus.forEach((x) => x.btn?.classList.toggle('on', x === m));
    const pop = showMenu(this.items(m.spec()), m.btn, 'below');
    pop.onClose = ((prev) => () => {
      prev?.();
      m.btn?.classList.remove('on');
      if (this.open?.pop === pop) this.open = null;
    })(pop.onClose);
    this.open = { index: i, pop };
    pop.el.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      e.preventDefault();
      this.openMenu((i + (e.key === 'ArrowRight' ? 1 : -1) + this.menus.length) % this.menus.length);
      this.open?.pop.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    });
  }

  private items(spec: MenuSpec): MenuItem[] {
    const app = this.app;
    const out: MenuItem[] = [];
    for (const s of spec) {
      if (s === '-') {
        if (out.length && !('separator' in out[out.length - 1])) out.push({ separator: true });
        continue;
      }
      if (typeof s === 'object') {
        out.push({ label: s.label, icon: s.icon, submenu: () => this.items(s.items()) });
        continue;
      }
      const c = app.commands.get(s);
      if (!c) continue;
      out.push({ label: c.title, icon: c.checked ? undefined : c.icon, checked: c.checked?.(), hint: c.keys?.[0], disabled: !app.commands.isEnabled(c), run: () => app.commands.run(c.id) });
    }
    if (out.length && 'separator' in out[out.length - 1]) out.pop();
    return out;
  }
}
