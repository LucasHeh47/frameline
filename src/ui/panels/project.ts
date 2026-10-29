// The Project panel: the files imported into the project (with thumbnails you can scrub by moving
// the mouse across them), bins to sort them into, and the project's sequences. Drag files to the
// timeline, or double-click one to watch it in the Source monitor.
import * as L from 'lucide';
import { allTracks, newSequence, uid, type Bin, type MediaItem, type Sequence } from '../../core/project';
import { clockTime } from '../../core/time';
import { probeMedia } from '../../media/probe';
import type { App } from '../app';
import { h, icon } from '../dom';
import type { Panel } from '../layout';
import { platform } from '../platform';
import { confirmDialog, dialog, promptDialog, showMenu, toast, tooltip, type MenuItem } from '../widgets';

type Entry = { kind: 'bin'; bin: Bin } | { kind: 'seq'; seq: Sequence } | { kind: 'media'; m: MediaItem };

const entryId = (e: Entry) => (e.kind === 'bin' ? e.bin.id : e.kind === 'seq' ? e.seq.id : e.m.id);

export class ProjectPanel implements Panel {
  readonly id = 'project';
  readonly title = 'Project';
  readonly el: HTMLElement;
  private list: HTMLElement;
  private crumbs: HTMLElement;
  private search: HTMLInputElement;
  private bin: string | null = null;
  private selected = new Set<string>();
  private queued = false;

  constructor(private app: App) {
    this.search = h('input', { class: 'input proj-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search media' }) as HTMLInputElement;
    this.search.addEventListener('input', () => this.request());
    const importBtn = h('button', { class: 'btn icon-only', 'aria-label': 'Import media', onclick: () => void app.importFiles(undefined, this.bin ?? undefined) }, icon(L.FolderInput, 16));
    tooltip(importBtn, 'Import media', 'Ctrl+I');
    const newBtn = h('button', { class: 'btn icon-only', 'aria-label': 'New item', onclick: (e: MouseEvent) => this.newMenu(e.currentTarget as HTMLElement) }, icon(L.FilePlus2, 16));
    tooltip(newBtn, 'New sequence, title, color matte, adjustment layer or bin');
    const viewBtn = h('button', { class: 'btn icon-only', 'aria-label': 'List or thumbnails', onclick: () => app.settings.set('media.binView', app.settings.str('media.binView') === 'grid' ? 'list' : 'grid') }, icon(L.LayoutGrid, 16));
    tooltip(viewBtn, 'Show as a list or as thumbnails');
    const sortBtn = h('button', { class: 'btn icon-only', 'aria-label': 'Sort', onclick: (e: MouseEvent) => this.sortMenu(e.currentTarget as HTMLElement) }, icon(L.ArrowDownWideNarrow, 16));
    tooltip(sortBtn, 'Sort');
    this.crumbs = h('div', { class: 'proj-crumbs' });
    this.list = h('div', { class: 'proj-list', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true' });
    this.el = h('div', { class: 'project-panel' }, h('div', { class: 'proj-bar' }, this.search, importBtn, newBtn, sortBtn, viewBtn), this.crumbs, this.list);
    for (const k of ['project', 'media', 'settings', 'sequence'] as const) app.on(k, () => this.request());
    this.list.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        void this.deleteSelected();
      } else if (e.key === 'Enter') {
        const first = [...this.selected][0];
        if (first) this.openEntry(first);
      } else if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        this.selected = new Set(this.entries().map(entryId));
        this.request();
      }
    });
    this.list.addEventListener('pointerdown', (e) => {
      if (e.target === this.list) {
        this.selected.clear();
        this.request();
      }
    });
    this.list.addEventListener('contextmenu', (e) => {
      if (e.target !== this.list) return;
      e.preventDefault();
      showMenu(this.newItems(), { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY });
    });
    // Files dropped here are imported into the bin that's open
    this.list.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files') || e.dataTransfer?.types.includes('application/x-frameline-media')) {
        e.preventDefault();
        e.dataTransfer!.dropEffect = e.dataTransfer!.types.includes('Files') ? 'copy' : 'move';
      }
    });
    this.list.addEventListener('drop', (e) => {
      if (e.dataTransfer?.files.length) {
        e.preventDefault();
        void platform.droppedFiles([...e.dataTransfer.files]).then((infos) => app.importFiles(infos, this.bin ?? undefined));
      } else {
        const raw = e.dataTransfer?.getData('application/x-frameline-media');
        if (raw && e.target === this.list) {
          e.preventDefault();
          this.moveToBin((JSON.parse(raw) as { ids: string[] }).ids, this.bin);
        }
      }
    });
    this.request();
  }

  request(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  /** Shows a file in the panel (opening its bin) and selects it. */
  reveal(mediaId: string): void {
    const m = this.app.mediaById(mediaId);
    if (!m) return;
    this.app.layout.show('project');
    this.bin = m.bin ?? null;
    this.search.value = '';
    this.selected = new Set([m.id]);
    this.render();
    this.list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  private entries(): Entry[] {
    const p = this.app.project;
    if (!p) return [];
    const q = this.search.value.trim().toLowerCase();
    const inBin = (b: string | undefined) => (q ? true : (b ?? null) === this.bin);
    const out: Entry[] = [];
    for (const b of p.bins) if (inBin(b.parent) && (!q || b.name.toLowerCase().includes(q))) out.push({ kind: 'bin', bin: b });
    if (!this.bin || q) for (const s of p.sequences) if (!q || s.name.toLowerCase().includes(q)) out.push({ kind: 'seq', seq: s });
    const media = p.media.filter((m) => inBin(m.bin) && (!q || m.name.toLowerCase().includes(q)));
    const sort = this.app.prefs.projectSort;
    if (sort === 'name') media.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    else if (sort === 'type') media.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    else if (sort === 'duration') media.sort((a, b) => b.duration - a.duration);
    for (const m of media) out.push({ kind: 'media', m });
    return out;
  }

  private render(): void {
    const p = this.app.project;
    const app = this.app;
    if (!p) {
      this.list.replaceChildren();
      return;
    }
    if (this.bin && !p.bins.some((b) => b.id === this.bin)) this.bin = null;
    // Breadcrumbs for bins inside bins
    const trail: Bin[] = [];
    for (let b = p.bins.find((x) => x.id === this.bin); b; b = p.bins.find((x) => x.id === b!.parent)) trail.unshift(b);
    this.crumbs.hidden = !trail.length;
    this.crumbs.replaceChildren(
      h('button', { class: 'btn text small', onclick: () => this.openBin(null) }, icon(L.FolderOpen, 13), p.name),
      ...trail.flatMap((b) => [h('span', { class: 'crumb-sep' }, '›'), h('button', { class: 'btn text small', onclick: () => this.openBin(b.id) }, b.name)]),
    );
    const entries = this.entries();
    const grid = app.settings.str('media.binView') === 'grid';
    this.list.classList.toggle('grid', grid);
    if (!entries.length) {
      this.list.replaceChildren(
        h('div', { class: 'proj-empty' }, icon(L.FolderInput, 26), h('p', null, this.search.value ? 'Nothing matches.' : 'Import video, sound and pictures.'), this.search.value ? null : h('button', { class: 'btn primary small', onclick: () => void app.importFiles(undefined, this.bin ?? undefined) }, 'Import…'), this.search.value ? null : h('p', { class: 'hint' }, 'Or drop files here.')),
      );
      return;
    }
    this.list.replaceChildren(...entries.map((e) => (grid ? this.tile(e) : this.row(e))));
  }

  private used(m: MediaItem): number {
    let n = 0;
    for (const s of this.app.project!.sequences) for (const t of allTracks(s)) for (const c of t.clips) if (c.mediaId === m.id) n++;
    return n;
  }

  private tile(e: Entry): HTMLElement {
    const id = entryId(e);
    const thumb = h('div', { class: 'proj-thumb' });
    let name = '';
    let badge = '';
    if (e.kind === 'bin') {
      name = e.bin.name;
      thumb.append(icon(L.Folder, 34));
    } else if (e.kind === 'seq') {
      name = e.seq.name;
      thumb.append(icon(L.Clapperboard, 30));
      badge = `${e.seq.width}×${e.seq.height}`;
    } else {
      const m = e.m;
      name = m.name;
      badge = m.kind === 'image' ? 'Picture' : clockTime(m.duration);
      if (this.app.library.missing.has(m.id)) thumb.append(h('span', { class: 'proj-missing' }, icon(L.TriangleAlert, 14), 'Missing'));
      else if (m.kind === 'audio') thumb.append(icon(L.AudioLines, 30));
      else {
        const c = h('canvas', { class: 'proj-canvas' }) as HTMLCanvasElement;
        thumb.append(c);
        this.paintThumb(c, m, m.kind === 'image' ? 0 : Math.min(m.duration * 0.15, 3));
        // Moving across the thumbnail shows the video's frames
        if (m.kind === 'video') {
          thumb.addEventListener('pointermove', (ev) => {
            const r = thumb.getBoundingClientRect();
            this.paintThumb(c, m, ((ev.clientX - r.left) / r.width) * m.duration);
          });
          thumb.addEventListener('pointerleave', () => this.paintThumb(c, m, Math.min(m.duration * 0.15, 3)));
        }
      }
    }
    const el = h(
      'div',
      { class: `proj-tile kind-${e.kind === 'media' ? e.m.kind : e.kind}${this.selected.has(id) ? ' on' : ''}`, role: 'option', 'aria-selected': this.selected.has(id) ? 'true' : 'false', title: e.kind === 'media' ? e.m.path : name },
      thumb,
      badge ? h('span', { class: 'proj-badge' }, badge) : null,
      h('div', { class: 'proj-name' }, name),
    );
    this.wire(el, e);
    return el;
  }

  private paintThumb(c: HTMLCanvasElement, m: MediaItem, t: number): void {
    const th = this.app.library.thumbAt(m, t);
    const w = 160;
    const hh = 90;
    c.width = w;
    c.height = hh;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, hh);
    if (!th) return;
    const k = Math.min(w / th.sw, hh / th.sh);
    const dw = th.sw * k;
    const dh = th.sh * k;
    ctx.drawImage(th.sheet, th.sx, th.sy, th.sw, th.sh, (w - dw) / 2, (hh - dh) / 2, dw, dh);
  }

  private row(e: Entry): HTMLElement {
    const id = entryId(e);
    let cells: (string | Node)[];
    if (e.kind === 'bin') cells = [icon(L.Folder, 15), e.bin.name, 'Bin', '', ''];
    else if (e.kind === 'seq') cells = [icon(L.Clapperboard, 15), e.seq.name, 'Sequence', `${e.seq.width}×${e.seq.height}`, `${e.seq.fps} fps`];
    else {
      const m = e.m;
      const missing = this.app.library.missing.has(m.id);
      cells = [
        icon(missing ? L.TriangleAlert : m.kind === 'video' ? L.Film : m.kind === 'audio' ? L.AudioLines : L.Image, 15),
        m.name,
        missing ? 'Missing' : m.kind === 'video' ? 'Video' : m.kind === 'audio' ? 'Audio' : 'Picture',
        m.kind === 'audio' ? `${m.channels === 1 ? 'Mono' : 'Stereo'}` : m.width ? `${m.width}×${m.height}` : '',
        m.kind === 'image' ? '' : `${clockTime(m.duration)}${m.fps ? ` · ${Math.round(m.fps * 100) / 100} fps` : ''}`,
      ];
    }
    const el = h('div', { class: `proj-row${this.selected.has(id) ? ' on' : ''}`, role: 'option', title: e.kind === 'media' ? e.m.path : '' }, ...cells.map((c, i) => h('span', { class: `proj-cell c${i}` }, c)));
    this.wire(el, e);
    return el;
  }

  private wire(el: HTMLElement, e: Entry): void {
    const id = entryId(e);
    const app = this.app;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button === 2 && this.selected.has(id)) return;
      if (ev.ctrlKey) {
        if (this.selected.has(id)) this.selected.delete(id);
        else this.selected.add(id);
      } else if (ev.shiftKey && this.selected.size) {
        const all = this.entries().map(entryId);
        const a = all.indexOf([...this.selected].pop()!);
        const b = all.indexOf(id);
        for (const x of all.slice(Math.min(a, b), Math.max(a, b) + 1)) this.selected.add(x);
      } else if (!this.selected.has(id)) this.selected = new Set([id]);
      this.list.focus({ preventScroll: true });
      this.render();
    });
    el.addEventListener('dblclick', () => this.openEntry(id));
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showMenu(this.itemMenu(e), { left: ev.clientX, top: ev.clientY, right: ev.clientX, bottom: ev.clientY });
    });
    if (e.kind === 'media' || e.kind === 'bin') {
      el.draggable = true;
      el.addEventListener('dragstart', (ev) => {
        const ids = this.selected.has(id) ? [...this.selected] : [id];
        const media = ids.map((x) => app.mediaById(x)).filter((m): m is MediaItem => !!m);
        ev.dataTransfer!.setData('application/x-frameline-media', JSON.stringify({ ids: media.map((m) => m.id), binIds: ids.filter((x) => app.project!.bins.some((b) => b.id === x)) }));
        ev.dataTransfer!.effectAllowed = 'copyMove';
        const frames = media.reduce((n, m) => n + (m.kind === 'image' ? app.stillFrames : Math.round(m.duration * app.fps)), 0);
        window.__framelineDrag = { frames, label: media.length === 1 ? media[0].name : `${media.length} files` };
      });
    }
    if (e.kind === 'bin') {
      el.addEventListener('dragover', (ev) => {
        if (ev.dataTransfer?.types.includes('application/x-frameline-media')) {
          ev.preventDefault();
          el.classList.add('drop');
        }
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (ev) => {
        el.classList.remove('drop');
        const raw = ev.dataTransfer?.getData('application/x-frameline-media');
        if (!raw) return;
        ev.preventDefault();
        ev.stopPropagation();
        const d = JSON.parse(raw) as { ids: string[]; binIds?: string[] };
        this.moveToBin([...d.ids, ...(d.binIds ?? []).filter((b) => b !== e.bin.id)], e.bin.id);
      });
    }
  }

  private openEntry(id: string): void {
    const app = this.app;
    const p = app.project!;
    const bin = p.bins.find((b) => b.id === id);
    if (bin) return this.openBin(bin.id);
    const s = p.sequences.find((x) => x.id === id);
    if (s) {
      if (p.active !== s.id) {
        app.player.pause();
        p.active = s.id;
        app.selection.clear();
        app.player.frame = s.playhead ?? 0;
        app.emit('sequence', 'project', 'selection', 'playhead');
        app.player.refresh();
      }
      return;
    }
    const m = app.mediaById(id);
    if (!m) return;
    if (app.library.missing.has(m.id)) void this.relink(m);
    else app.layout.source.open(m.id);
  }

  private openBin(id: string | null): void {
    this.bin = id;
    this.selected.clear();
    this.search.value = '';
    this.render();
  }

  private moveToBin(ids: string[], bin: string | null): void {
    const p = this.app.project!;
    // A bin can't go inside itself
    const isInside = (b: string | null, target: string): boolean => {
      for (let x = b; x; x = p.bins.find((y) => y.id === x)?.parent ?? null) if (x === target) return true;
      return false;
    };
    this.app.edit('Move to bin', (_s, proj) => {
      let n = 0;
      for (const id of ids) {
        const m = proj.media.find((x) => x.id === id);
        if (m && (m.bin ?? null) !== bin) {
          if (bin) m.bin = bin;
          else delete m.bin;
          n++;
        }
        const b = proj.bins.find((x) => x.id === id);
        if (b && !isInside(bin, b.id) && (b.parent ?? null) !== bin) {
          if (bin) b.parent = bin;
          else delete b.parent;
          n++;
        }
      }
      return n > 0;
    });
  }

  private newItems(): MenuItem[] {
    const app = this.app;
    return [
      { label: 'Sequence…', icon: L.Clapperboard, hint: 'Ctrl+N', run: () => app.commands.run('file.newSequence') },
      { label: 'Bin', icon: L.FolderPlus, hint: 'Ctrl+B', run: () => void this.newBin() },
      { separator: true },
      { label: 'Title', icon: L.Type, hint: 'Ctrl+T', run: () => app.commands.run('graphics.title') },
      { label: 'Color matte…', icon: L.Square, run: () => app.commands.run('graphics.colorMatte') },
      { label: 'Adjustment layer', icon: L.Layers, run: () => app.commands.run('graphics.adjustment') },
      { separator: true },
      { label: 'Import…', icon: L.FolderInput, hint: 'Ctrl+I', run: () => void app.importFiles(undefined, this.bin ?? undefined) },
    ];
  }

  private newMenu(at: HTMLElement): void {
    showMenu(this.newItems(), at);
  }

  async newBin(): Promise<void> {
    const name = await promptDialog('New bin', 'Name', 'Bin');
    if (!name?.trim()) return;
    const parent = this.bin ?? undefined;
    this.app.edit('New bin', (_s, p) => {
      p.bins.push({ id: uid('b'), name: name.trim(), parent });
    });
  }

  private sortMenu(at: HTMLElement): void {
    const app = this.app;
    const set = (v: typeof app.prefs.projectSort) => () => {
      app.prefs.projectSort = v;
      app.savePrefs();
      this.render();
    };
    const cur = app.prefs.projectSort;
    showMenu(
      [
        { label: 'Order added', checked: cur === 'added', run: set('added') },
        { label: 'Name', checked: cur === 'name', run: set('name') },
        { label: 'Type', checked: cur === 'type', run: set('type') },
        { label: 'Length', checked: cur === 'duration', run: set('duration') },
      ],
      at,
    );
  }

  private itemMenu(e: Entry): MenuItem[] {
    const app = this.app;
    if (e.kind === 'bin') {
      return [
        { label: 'Open', run: () => this.openBin(e.bin.id) },
        { label: 'Rename…', run: () => void this.rename(e) },
        { separator: true },
        { label: 'Delete bin', icon: L.Trash2, run: () => void this.deleteSelected([e.bin.id]) },
      ];
    }
    if (e.kind === 'seq') {
      const p = app.project!;
      return [
        { label: 'Open in the timeline', run: () => this.openEntry(e.seq.id) },
        { label: 'Sequence settings…', run: () => {
          this.openEntry(e.seq.id);
          app.commands.run('sequence.settings');
        } },
        { label: 'Rename…', run: () => void this.rename(e) },
        { label: 'Duplicate', run: () => app.edit('Duplicate sequence', (_s, proj) => {
          const copy = structuredClone(e.seq);
          copy.id = uid('s');
          copy.name = `${e.seq.name} copy`;
          proj.sequences.push(copy);
        }) },
        { separator: true },
        { label: 'Delete sequence', icon: L.Trash2, disabled: p.sequences.length <= 1, run: () => void this.deleteSelected([e.seq.id]) },
      ];
    }
    const m = e.m;
    const missing = app.library.missing.has(m.id);
    return [
      { label: 'Open in Source monitor', disabled: missing, run: () => app.layout.source.open(m.id) },
      { label: 'Insert at the playhead', hint: ',', disabled: missing, run: () => void app.placeMedia([m], app.playhead, null, 'insert') },
      { label: 'Overwrite at the playhead', hint: '.', disabled: missing, run: () => void app.placeMedia([m], app.playhead, null, 'overwrite') },
      { label: 'New sequence from this clip', disabled: m.kind !== 'video', run: () => this.sequenceFrom(m) },
      { separator: true },
      { label: missing ? 'Locate…' : 'Replace with another file…', icon: L.Link, run: () => void this.relink(m) },
      { label: 'Show in folder', icon: L.FolderSearch, disabled: missing || !platform.isDesktop, run: () => platform.showInFolder(m.path) },
      { label: 'Properties', icon: L.Info, run: () => this.properties(m) },
      { label: 'Rename…', run: () => void this.rename(e) },
      { separator: true },
      { label: 'Remove from project', icon: L.Trash2, run: () => void this.deleteSelected(this.selected.has(m.id) ? undefined : [m.id]) },
    ];
  }

  private sequenceFrom(m: MediaItem): void {
    const app = this.app;
    app.edit('New sequence from clip', (_s, p) => {
      const s = newSequence(m.name.replace(/\.[^.]+$/, ''), m.width, m.height, Math.round(m.fps * 1000) / 1000 || 30);
      p.sequences.push(s);
      p.active = s.id;
    });
    app.player.frame = 0;
    app.emit('sequence');
    void app.placeMedia([m], 0, null, 'overwrite');
  }

  private async rename(e: Entry): Promise<void> {
    const cur = e.kind === 'bin' ? e.bin.name : e.kind === 'seq' ? e.seq.name : e.m.name;
    const name = await promptDialog('Rename', 'Name', cur);
    if (!name?.trim() || name.trim() === cur) return;
    const id = entryId(e);
    this.app.edit('Rename', (_s, p) => {
      const b = p.bins.find((x) => x.id === id);
      const s = p.sequences.find((x) => x.id === id);
      const m = p.media.find((x) => x.id === id);
      if (b) b.name = name.trim();
      if (s) s.name = name.trim();
      if (m) m.name = name.trim();
    });
    if (e.kind === 'seq') this.app.emit('sequence');
  }

  private properties(m: MediaItem): void {
    const rows: [string, string][] = [
      ['File', m.path],
      ['Type', m.kind === 'video' ? 'Video' : m.kind === 'audio' ? 'Audio' : 'Picture'],
    ];
    if (m.width) rows.push(['Size', `${m.width} × ${m.height} pixels`]);
    if (m.kind !== 'image') rows.push(['Length', `${clockTime(m.duration)} (${m.duration.toFixed(2)} seconds)`]);
    if (m.fps) rows.push(['Frame rate', `${Math.round(m.fps * 1000) / 1000} fps`]);
    if (m.hasAudio) rows.push(['Sound', `${m.channels === 1 ? 'Mono' : m.channels === 2 ? 'Stereo' : `${m.channels} channels`}, ${(m.sampleRate / 1000).toFixed(1)} kHz`]);
    if (m.streams?.length) rows.push(['Sound tracks', `${m.streams.length}: ${m.streams.map((x) => x.name).join(', ')}`]);
    if (m.size) rows.push(['File size', m.size > 1e9 ? `${(m.size / 1e9).toFixed(2)} GB` : `${(m.size / 1e6).toFixed(1)} MB`]);
    const used = this.used(m);
    rows.push(['Used', used ? `${used} time${used === 1 ? '' : 's'} in the project's sequences` : 'Not on any timeline yet']);
    const body = h('div', { class: 'props-table' }, ...rows.flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]));
    void dialog(m.name, body, [{ label: 'Close', value: true, primary: true }]);
  }

  /** Points a media item at a different file (a missing one found, or a replacement). */
  async relink(m: MediaItem): Promise<void> {
    const app = this.app;
    const f = await platform.relinkDialog(m.name);
    if (!f) return;
    try {
      const probed = await probeMedia(f);
      app.library.forget(m.id);
      app.edit(`Locate ${m.name}`, (_s, p) => {
        const x = p.media.find((y) => y.id === m.id);
        if (!x) return false;
        Object.assign(x, { ...probed, name: x.name === m.name ? probed.name : x.name, bin: x.bin });
      });
      await app.checkMedia();
      toast(`${m.name} now uses ${f.name}.`, { kind: 'success' });
    } catch (err) {
      app.error(err);
    }
  }

  private async deleteSelected(ids = [...this.selected]): Promise<void> {
    const app = this.app;
    const p = app.project!;
    if (!ids.length) return;
    // Media in the bins being deleted goes too
    const bins = new Set(ids);
    for (let grew = true; grew; ) {
      grew = false;
      for (const b of p.bins) if (b.parent && bins.has(b.parent) && !bins.has(b.id)) {
        bins.add(b.id);
        grew = true;
      }
    }
    const media = p.media.filter((m) => ids.includes(m.id) || (m.bin && bins.has(m.bin)));
    const used = media.reduce((n, m) => n + this.used(m), 0);
    const seqs = ids.filter((id) => p.sequences.some((s) => s.id === id));
    if (seqs.length >= p.sequences.length) {
      toast('A project keeps at least one sequence.');
      return;
    }
    if (used && !(await confirmDialog('Remove media that’s in use?', `${used} clip${used === 1 ? ' uses' : 's use'} ${media.length === 1 ? 'this file' : 'these files'}. They'll be taken off the timeline too.`, 'Remove', true))) return;
    app.edit('Remove from project', (_s, proj) => {
      const gone = new Set(ids);
      // Bins go with what's in them
      let grew = true;
      while (grew) {
        grew = false;
        for (const b of proj.bins) if (b.parent && gone.has(b.parent) && !gone.has(b.id)) {
          gone.add(b.id);
          grew = true;
        }
      }
      for (const m of proj.media) if (m.bin && gone.has(m.bin)) gone.add(m.id);
      proj.media = proj.media.filter((m) => !gone.has(m.id));
      proj.bins = proj.bins.filter((b) => !gone.has(b.id));
      proj.sequences = proj.sequences.filter((s) => !gone.has(s.id));
      if (!proj.sequences.some((s) => s.id === proj.active)) proj.active = proj.sequences[0].id;
      for (const s of proj.sequences) for (const t of allTracks(s)) t.clips = t.clips.filter((c) => !c.mediaId || !gone.has(c.mediaId));
    });
    this.selected.clear();
    app.emit('sequence');
  }

  shown(): void {
    this.request();
  }
}
