// The Frameline window: one project at a time, with the panels (Project, Source, Effect Controls,
// Lumetri, Audio Mixer, Program monitor, Timeline…), the menus and the start page. Owns the project,
// its undo history, the selection and the player, and tells the panels when things change.
import { addTrack, applyTransition, audioTrackFor, cloneClip, placeClips, type PlaceMode } from '../core/edit';
import { History } from '../core/history';
import {
  activeSequence,
  allTracks,
  clipEnd,
  clipFromMedia,
  findClip,
  generatedClip,
  linkedClips,
  newProject,
  readProject,
  titleFor,
  uid,
  writeProject,
  type Clip,
  type MediaItem,
  type Project,
  type Sequence,
  type Track,
} from '../core/project';
import { secondsToFrames } from '../core/time';
import { MediaLibrary } from '../media/library';
import { Player } from '../media/player';
import { probeMedia } from '../media/probe';
import type { MediaFileInfo } from '../shared/api';
import { Commands, eventKey } from './commands';
import { h } from './dom';
import { HomeView, type HomeSection } from './home';
import { Layout } from './layout';
import { isDesktop, platform } from './platform';
import { SettingsView } from './settings/SettingsView';
import { ACCENTS, SETTINGS } from './settings/schema';
import { Settings, type Refresh } from './settings/store';
import { StatusBar } from './statusBar';
import { TitleBar } from './titleBar';
import { Updates } from './updates';
import { closePopovers, dialog, setFocusFallback, toast } from './widgets';

export type ToolId = 'select' | 'trackSelect' | 'ripple' | 'roll' | 'stretch' | 'razor' | 'slip' | 'slide' | 'hand' | 'zoom' | 'text';

export type ChangeKind = 'project' | 'selection' | 'playhead' | 'media' | 'history' | 'tool' | 'sequence' | 'settings';

export type Workspace = 'editing' | 'color' | 'audio' | 'effects';

export interface Prefs {
  workspace: Workspace;
  /** Panel sizes: the top row's share of the height, and the left columns' shares of the width. */
  topRow: number;
  topLeft: number;
  bottomLeft: number;
  /** The tab shown in each panel group, per workspace. */
  tabs: Record<string, string>;
  snap: boolean;
  linked: boolean;
  recentCommands: string[];
  /** Last choices in the export dialog. */
  export?: Record<string, unknown>;
  /** Last sequence preset used for new projects. */
  preset: string;
  projectSort: 'name' | 'type' | 'duration' | 'added';
  /** Heights of tracks the user resized, by track id. */
  trackHeights: Record<string, number>;
}

const PREFS_KEY = 'frameline.prefs';

const DEFAULT_PREFS: Prefs = {
  workspace: 'editing',
  topRow: 0.56,
  topLeft: 0.4,
  bottomLeft: 0.27,
  tabs: {},
  snap: true,
  linked: true,
  recentCommands: [],
  preset: 'hd30',
  projectSort: 'added',
  trackHeights: {},
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function shade(hex: string, amt: number): string {
  const to = amt < 0 ? 0 : 255;
  const a = Math.abs(amt);
  return '#' + hexToRgb(hex).map((c) => Math.round(c + (to - c) * a).toString(16).padStart(2, '0')).join('');
}

export function isTyping(t: EventTarget | null = document.activeElement): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t.isContentEditable) return true;
  if (t instanceof HTMLInputElement) return !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type);
  return t instanceof HTMLSelectElement;
}

/** An edit made while dragging: one undo step for the whole drag. */
export interface LiveEdit {
  update(fn: (s: Sequence, p: Project) => void): void;
  end(): void;
  cancel(): void;
}

/** Copied clips: where they were relative to the first one, and on which track. */
interface ClipboardItem {
  clip: Clip;
  kind: 'video' | 'audio';
  track: number;
  offset: number;
}

export class App {
  readonly root: HTMLElement;
  readonly settings = new Settings(SETTINGS);
  prefs: Prefs;
  readonly commands: Commands;
  readonly titlebar: TitleBar;
  readonly statusbar: StatusBar;
  readonly updates: Updates;
  readonly library = new MediaLibrary();
  readonly player: Player;
  readonly layout: Layout;
  readonly history = new History<Project>(200);
  project: Project | null = null;
  projectPath: string | null = null;
  /** Selected clips (ids). */
  selection = new Set<string>();
  /** A selected transition: the clip it belongs to and which end. */
  transitionSel: { clipId: string; side: 'in' | 'out' } | null = null;
  tool: ToolId = 'select';
  clipboard: ClipboardItem[] | null = null;
  private listeners = new Map<ChangeKind, Set<() => void>>();
  private home: HomeView | null = null;
  private settingsView: SettingsView | null = null;
  private systemDark = matchMedia('(prefers-color-scheme: dark)');
  private recoveryId = `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  private recoveredAt = -1;

  constructor(root: HTMLElement) {
    this.root = root;
    this.prefs = this.loadPrefs();
    this.history.limit = this.settings.num('files.undoSteps');
    this.player = new Player({ project: () => this.project!, seq: () => this.seq, library: this.library });
    this.commands = new Commands(this);
    this.titlebar = new TitleBar(this);
    this.statusbar = new StatusBar(this);
    this.updates = new Updates(this);
    this.layout = new Layout(this);
    root.append(this.titlebar.el, this.layout.el, this.statusbar.el);

    for (const d of this.settings.defs) if (d.apply) d.apply(this.settings.get(d.id) as never, this);
    this.settings.onChange((id) => this.onSettingChanged(id));
    this.systemDark.addEventListener('change', () => {
      if (this.settings.str('appearance.theme') === 'system') this.applyTheme();
    });
    this.applyTheme();
    this.applyChrome();
    setFocusFallback(() => this.layout.timeline.focus());

    this.player.onFrame = () => this.emit('playhead');
    this.player.onStop = () => this.emit('playhead');
    this.library.onChange(() => this.emit('media'));
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.setupDrop();
    platform.onRequestClose(() => {
      void this.confirmDiscard('closing').then((ok) => {
        if (ok) {
          void platform.recovery.remove(this.recoveryId);
          platform.confirmClose();
        }
      });
    });
    platform.onOpenPaths((paths) => void this.openPaths(paths));
    platform.onNewProject((o) => this.newFromOptions(o));
    window.addEventListener('beforeunload', (e) => {
      if (!isDesktop && this.history.dirty && this.project) e.preventDefault();
    });

    const params = new URLSearchParams(location.search);
    const file = params.get('file');
    if (file) void this.openPaths([file]);
    else if (params.get('new')) this.newFromOptions(Object.fromEntries(params));
    else {
      this.newProject();
      if (this.settings.bool('files.restore')) this.openHome('home');
    }
    void this.updates.startup();
    this.startAutosave();
    this.startRecovery();
  }

  // ---------- events ----------

  on(kind: ChangeKind, fn: () => void): () => void {
    let set = this.listeners.get(kind);
    if (!set) this.listeners.set(kind, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(...kinds: ChangeKind[]): void {
    for (const k of kinds) for (const fn of this.listeners.get(k) ?? []) fn();
  }

  // ---------- state ----------

  get seq(): Sequence {
    return activeSequence(this.project!);
  }

  get fps(): number {
    return this.seq.fps;
  }

  get playhead(): number {
    return Math.round(this.player.frame);
  }

  setPlayhead(f: number): void {
    this.player.seek(Math.max(0, Math.round(f)));
    this.seq.playhead = this.playhead;
    this.emit('playhead');
  }

  mediaById(id: string | undefined): MediaItem | undefined {
    return id ? this.project?.media.find((m) => m.id === id) : undefined;
  }

  get stillFrames(): number {
    return Math.max(1, Math.round(this.settings.num('timeline.stillSeconds') * this.fps));
  }

  private loadPrefs(): Prefs {
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
      return { ...DEFAULT_PREFS, ...raw, tabs: { ...raw.tabs }, trackHeights: { ...raw.trackHeights }, recentCommands: [...(raw.recentCommands ?? [])] };
    } catch {
      return { ...DEFAULT_PREFS, tabs: {}, trackHeights: {}, recentCommands: [] };
    }
  }

  savePrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // storage unavailable
    }
  }

  error(err: unknown): void {
    console.error(err);
    toast(String((err as Error)?.message ?? err), { kind: 'error' });
  }

  // ---------- editing ----------

  /** Makes an undoable change. Returning false from `fn` means nothing changed. */
  edit(label: string, fn: (s: Sequence, p: Project) => unknown): boolean {
    const p = this.project;
    if (!p) return false;
    const before = structuredClone(p);
    let r: unknown;
    try {
      r = fn(this.seq, p);
    } catch (err) {
      this.project = before;
      this.error(err);
      this.changed();
      return false;
    }
    if (r === false) {
      this.project = before;
      return false;
    }
    this.history.record(label, before);
    this.changed();
    return true;
  }

  /** A change made bit by bit while dragging (a slider, a clip): one undo step when it ends. */
  liveEdit(label: string): LiveEdit {
    const before = structuredClone(this.project!);
    let changed = false;
    let done = false;
    return {
      update: (fn) => {
        if (done || !this.project) return;
        fn(this.seq, this.project);
        changed = true;
        this.changed(true);
      },
      end: () => {
        if (done) return;
        done = true;
        if (changed) {
          this.history.record(label, before);
          this.changed();
        }
      },
      cancel: () => {
        if (done) return;
        done = true;
        if (changed) {
          this.project = before;
          this.changed();
        }
      },
    };
  }

  /** The project changed: everything that shows it catches up. `live` skips the slower updates. */
  changed(live = false): void {
    if (!this.project) return;
    // Selected things may be gone
    const s = this.seq;
    for (const id of [...this.selection]) if (!findClip(s, id)) this.selection.delete(id);
    if (this.transitionSel) {
      const f = findClip(s, this.transitionSel.clipId);
      if (!f || !(this.transitionSel.side === 'in' ? f.clip.transIn : f.clip.transOut)) this.transitionSel = null;
    }
    this.player.refresh();
    this.emit('project');
    if (!live) {
      this.emit('history');
      platform.setDirty(this.history.dirty);
      this.titlebar.refresh();
      this.commands.refresh();
    }
  }

  undo(): void {
    if (!this.project) return;
    const prev = this.history.undo(this.project);
    if (!prev) return;
    this.project = prev;
    this.changed();
    this.statusbar.flash(`Undid ${this.history.redoLabel ?? 'the last change'}`);
  }

  redo(): void {
    if (!this.project) return;
    const next = this.history.redo(this.project);
    if (!next) return;
    this.project = next;
    this.changed();
    this.statusbar.flash(`Redid ${this.history.undoLabel ?? 'the change'}`);
  }

  /** Goes back or forward to a step of the History panel (0 is before the first change). */
  goToStep(n: number): void {
    while (this.history.undoCount > n && this.history.canUndo) this.undo();
    while (this.history.undoCount < n && this.history.canRedo) this.redo();
  }

  // ---------- selection ----------

  /** Selects clips; with linked selection on, their linked clips come too (Alt picks just one). */
  select(ids: string[], mode: 'replace' | 'add' | 'toggle' = 'replace', single = false): void {
    if (!this.project) return;
    const s = this.seq;
    const expand = (id: string): string[] => {
      const f = findClip(s, id);
      if (!f) return [];
      return this.prefs.linked && !single ? linkedClips(s, f.clip).map((c) => c.id) : [id];
    };
    if (mode === 'replace') this.selection = new Set(ids.flatMap(expand));
    else
      for (const id of ids) {
        const group = expand(id);
        if (mode === 'toggle' && this.selection.has(id)) for (const g of group) this.selection.delete(g);
        else for (const g of group) this.selection.add(g);
      }
    this.transitionSel = null;
    this.emit('selection');
    this.commands.refresh();
  }

  selectTransition(clipId: string, side: 'in' | 'out'): void {
    this.selection.clear();
    this.transitionSel = { clipId, side };
    this.emit('selection');
    this.commands.refresh();
  }

  clearSelection(): void {
    if (!this.selection.size && !this.transitionSel) return;
    this.selection.clear();
    this.transitionSel = null;
    this.emit('selection');
    this.commands.refresh();
  }

  /** Selected clips with their tracks, in timeline order. */
  selectedClips(): { clip: Clip; track: Track }[] {
    if (!this.project) return [];
    const out: { clip: Clip; track: Track }[] = [];
    for (const t of allTracks(this.seq)) for (const c of t.clips) if (this.selection.has(c.id)) out.push({ clip: c, track: t });
    return out.sort((a, b) => a.clip.start - b.clip.start);
  }

  /** The clip the panels show: the first selected picture clip, else the first selected one. */
  focusClip(): { clip: Clip; track: Track } | null {
    const list = this.selectedClips();
    return list.find((x) => x.track.kind === 'video') ?? list[0] ?? null;
  }

  setTool(t: ToolId): void {
    this.tool = t;
    this.emit('tool');
  }

  // ---------- media ----------

  /** Imports files (from the Import dialog when none are given). Files already in the project are reused. */
  async importFiles(infos?: MediaFileInfo[], bin?: string): Promise<MediaItem[]> {
    if (!this.project) this.newProject();
    infos ??= await platform.importDialog();
    if (!infos.length) return [];
    const out: MediaItem[] = [];
    const fresh: MediaItem[] = [];
    this.statusbar.setProgress(`Importing ${infos.length === 1 ? infos[0].name : `${infos.length} files`}…`, 0);
    let i = 0;
    for (const f of infos) {
      const have = this.project!.media.find((m) => m.path.toLowerCase() === f.path.toLowerCase());
      if (have) {
        out.push(have);
        continue;
      }
      try {
        const probed = await probeMedia(f);
        const item: MediaItem = { id: uid('m'), ...probed, bin };
        fresh.push(item);
        out.push(item);
      } catch (err) {
        toast(`Couldn't import ${f.name}: ${(err as Error).message}`, { kind: 'error' });
      }
      this.statusbar.setProgress('Importing…', (++i / infos.length) * 100);
    }
    this.statusbar.setProgress(null, 100);
    if (fresh.length) {
      this.edit(fresh.length === 1 ? `Import ${fresh[0].name}` : `Import ${fresh.length} files`, (_s, p) => {
        p.media.push(...fresh);
      });
      this.statusbar.flash(`Imported ${fresh.length} file${fresh.length === 1 ? '' : 's'}`);
    }
    this.emit('media');
    return out;
  }

  /** Offers to change an empty sequence to a clip's size and frame rate (Premiere's clip mismatch). */
  private async matchSequence(m: MediaItem): Promise<void> {
    const s = this.seq;
    if (!this.settings.bool('media.matchFirst') || m.kind !== 'video' || !m.width) return;
    if (allTracks(s).some((t) => t.clips.length)) return;
    const fps = Math.round(m.fps * 1000) / 1000;
    if (m.width === s.width && m.height === s.height && Math.abs(fps - s.fps) < 0.01) return;
    const v = await dialog<'match' | 'keep'>(
      'Match the sequence to this clip?',
      `${m.name} is ${m.width} × ${m.height} at ${fps} fps; the sequence is ${s.width} × ${s.height} at ${s.fps} fps. Changing the sequence keeps the clip sharp and its motion smooth.`,
      [
        { label: 'Change the sequence', value: 'match', primary: true },
        { label: 'Keep the sequence', value: 'keep' },
      ],
      { cancelValue: 'keep' },
    );
    if (v !== 'match') return;
    this.edit('Match sequence settings', (seq) => {
      seq.width = m.width;
      seq.height = m.height;
      seq.fps = fps > 0 ? fps : seq.fps;
      for (const t of seq.video) for (const c of t.clips) if (c.motion) {
        c.motion.x.v = seq.width / 2;
        c.motion.y.v = seq.height / 2;
      }
    });
    this.emit('sequence');
  }

  /**
   * Puts media on the timeline at a frame, one after another: pictures on a video track, sounds on
   * the matching audio track (linked together). `track` is a video or audio track to place on.
   */
  async placeMedia(items: MediaItem[], at: number, track: Track | null, mode: PlaceMode, parts: 'both' | 'video' | 'audio' = 'both', range?: { in: number; out: number }): Promise<void> {
    if (!items.length || !this.project) return;
    await this.matchSequence(items[0]);
    const fit = this.settings.str('media.fit') as Clip['fit'];
    const placed: string[] = [];
    this.edit(items.length === 1 ? `Add ${items[0].name}` : `Add ${items.length} clips`, (s) => {
      let f = Math.max(0, Math.round(at));
      const vt = track?.kind === 'video' ? track : track ? s.video[Math.min(s.video.length - 1, s.audio.indexOf(track))] ?? s.video[0] : s.video[0];
      const at2 = track?.kind === 'audio' ? track : audioTrackFor(s, vt);
      const items2: { track: Track; clip: Clip }[] = [];
      for (const m of items) {
        const inSec = range && items.length === 1 ? range.in : 0;
        const outSec = range && items.length === 1 ? range.out : m.duration;
        const dur = m.kind === 'image' ? this.stillFrames : Math.max(1, secondsToFrames(outSec - inSec, s.fps));
        const link = m.hasVideo && m.hasAudio && parts === 'both' ? uid('l') : undefined;
        if (m.hasVideo && parts !== 'audio') {
          // A picture smaller than the frame (a logo) keeps its size instead of being blown up
          const small = m.kind === 'image' && m.width <= s.width && m.height <= s.height;
          const c = clipFromMedia(m, s, { start: f, duration: dur, fit: small ? 'none' : fit }, 'video');
          c.in = inSec;
          c.linkId = link;
          items2.push({ track: vt, clip: c });
        }
        if (m.hasAudio && parts !== 'video') {
          const c = clipFromMedia(m, s, { start: f, duration: dur }, 'audio');
          c.in = inSec;
          c.linkId = link;
          items2.push({ track: at2, clip: c });
        }
        f += dur;
      }
      if (!items2.length) return false;
      placeClips(s, items2, mode);
      placed.push(...items2.map((x) => x.clip.id));
    });
    if (placed.length) {
      this.selection = new Set(placed);
      this.emit('selection');
    }
  }

  /** A free video track over a range (above V1 when V1 is busy), added when every one is busy. */
  private freeVideoTrack(s: Sequence, a: number, b: number): Track {
    const free = s.video.find((t, i) => i > 0 && !t.locked && t.clips.every((c) => clipEnd(c) <= a || c.start >= b));
    if (free) return free;
    const v1 = s.video[0];
    if (v1 && !v1.locked && v1.clips.every((c) => clipEnd(c) <= a || c.start >= b)) return v1;
    return addTrack(s, 'video');
  }

  /** Adds a title (from a preset) at the playhead, above the video there. */
  newTitle(preset: Partial<import('../core/project').TitleStyle> = {}, name = 'Title'): void {
    const f = this.playhead;
    let id = '';
    this.edit(`Add ${name.toLowerCase()}`, (s) => {
      const t = this.freeVideoTrack(s, f, f + this.stillFrames);
      const c = generatedClip('title', s, f, this.stillFrames, { title: titleFor(s, preset), name });
      t.clips.push(c);
      t.clips.sort((x, y) => x.start - y.start);
      id = c.id;
    });
    if (id) this.select([id]);
  }

  newGenerated(kind: 'color' | 'adjustment', color = '#000000'): void {
    const f = this.playhead;
    let id = '';
    this.edit(kind === 'color' ? 'Add color matte' : 'Add adjustment layer', (s) => {
      // A matte usually goes under everything; an adjustment layer over it
      const t = kind === 'color' && s.video[0].clips.every((c) => clipEnd(c) <= f || c.start >= f + this.stillFrames) ? s.video[0] : this.freeVideoTrack(s, f, f + this.stillFrames);
      const c = generatedClip(kind, s, f, this.stillFrames, kind === 'color' ? { color } : {});
      t.clips.push(c);
      t.clips.sort((x, y) => x.start - y.start);
      id = c.id;
    });
    if (id) this.select([id]);
  }

  // ---------- clipboard ----------

  copy(cut = false): void {
    const list = this.selectedClips();
    if (!list.length) return;
    const first = Math.min(...list.map((x) => x.clip.start));
    this.clipboard = list.map(({ clip, track }) => ({ clip: structuredClone(clip), kind: track.kind, track: (track.kind === 'video' ? this.seq.video : this.seq.audio).indexOf(track), offset: clip.start - first }));
    if (cut) this.commands.run('edit.clear');
    else this.statusbar.flash(`Copied ${list.length} clip${list.length === 1 ? '' : 's'}`);
  }

  /** Pastes copied clips at the playhead, on the tracks they came from. */
  paste(mode: PlaceMode = 'overwrite'): void {
    const items = this.clipboard;
    if (!items?.length) return;
    const f = this.playhead;
    const ids: string[] = [];
    this.edit('Paste', (s) => {
      const links = new Map<string, string>();
      const placed = items.map((it) => {
        const list = it.kind === 'video' ? s.video : s.audio;
        while (list.length <= it.track) addTrack(s, it.kind);
        const c = cloneClip(it.clip);
        c.start = f + it.offset;
        if (c.linkId) {
          if (!links.has(c.linkId)) links.set(c.linkId, uid('l'));
          c.linkId = links.get(c.linkId);
        }
        ids.push(c.id);
        return { track: list[it.track], clip: c };
      });
      placeClips(s, placed, mode);
      const end = Math.max(...placed.map((p) => clipEnd(p.clip)));
      this.player.seek(end);
    });
    this.select(ids);
  }

  /** Copies the copied clip's motion, opacity, effects and volume onto the selected clips. */
  async pasteAttributes(): Promise<void> {
    const src = this.clipboard?.[0]?.clip;
    if (!src || !this.selection.size) return;
    const boxes = { motion: true, opacity: true, effects: true, volume: true, speed: false };
    const body = h(
      'div',
      { class: 'form' },
      h('p', { class: 'hint' }, `From ${src.name} onto ${this.selection.size} selected clip${this.selection.size === 1 ? '' : 's'}:`),
      ...(Object.keys(boxes) as (keyof typeof boxes)[]).map((k) => {
        const input = h('input', { type: 'checkbox', checked: boxes[k] }) as HTMLInputElement;
        input.addEventListener('change', () => (boxes[k] = input.checked));
        return h('label', { class: 'check' }, input, h('span', null, { motion: 'Motion (position, scale, rotation)', opacity: 'Opacity and blend mode', effects: 'Effects', volume: 'Volume and balance', speed: 'Speed' }[k]));
      }),
    );
    if (!(await dialog('Paste attributes', body, [{ label: 'Paste', value: true, primary: true }, { label: 'Cancel', value: false }]))) return;
    this.edit('Paste attributes', () => {
      for (const { clip, track } of this.selectedClips()) {
        if (track.kind === 'video' && clip.kind !== 'audio') {
          if (boxes.motion && src.motion) clip.motion = structuredClone(src.motion);
          if (boxes.opacity && src.opacity) {
            clip.opacity = structuredClone(src.opacity);
            clip.blend = src.blend;
          }
          if (boxes.effects) clip.effects = [...clip.effects, ...structuredClone(src.effects.filter((e) => !['gain', 'eq', 'highpass', 'lowpass', 'compressor', 'reverb', 'delay', 'channels'].includes(e.type)))].map((e) => ({ ...e, id: uid('fx') }));
        } else {
          if (boxes.volume && src.volume) {
            clip.volume = structuredClone(src.volume);
            clip.pan = structuredClone(src.pan);
          }
          if (boxes.effects) clip.effects = [...clip.effects, ...structuredClone(src.effects.filter((e) => ['gain', 'eq', 'highpass', 'lowpass', 'compressor', 'reverb', 'delay', 'channels'].includes(e.type)))].map((e) => ({ ...e, id: uid('fx') }));
        }
      }
    });
  }

  /** Adds the default transition where the playhead is, or at the selected clips' ends. */
  addDefaultTransition(kind: 'video' | 'audio'): void {
    const type = kind === 'video' ? this.settings.str('timeline.defaultTransition') : 'constantPower';
    const frames = Math.max(1, Math.round(this.settings.num(kind === 'video' ? 'timeline.transitionSeconds' : 'timeline.audioTransitionSeconds') * this.fps));
    const f = this.playhead;
    const done = this.edit(kind === 'video' ? 'Add video transition' : 'Add audio transition', (s) => {
      let n = 0;
      const sel = this.selectedClips().filter((x) => x.track.kind === kind);
      if (sel.length) {
        for (const { clip } of sel) {
          if (applyTransition(s, clip.id, 'in', type, frames)) n++;
          if (applyTransition(s, clip.id, 'out', type, frames)) n++;
        }
        return n > 0;
      }
      // The cut nearest the playhead on each track of that kind
      for (const t of kind === 'video' ? s.video : s.audio) {
        if (t.locked) continue;
        let best: { c: Clip; side: 'in' | 'out'; d: number } | null = null;
        for (const c of t.clips) {
          for (const side of ['in', 'out'] as const) {
            const edge = side === 'in' ? c.start : clipEnd(c);
            const d = Math.abs(edge - f);
            if (d <= Math.max(2, this.fps) && (!best || d < best.d)) best = { c, side, d };
          }
        }
        if (best && applyTransition(s, best.c.id, best.side, type, frames)) n++;
      }
      return n > 0;
    });
    if (!done) toast('Put the playhead on a cut, or select clips, to add a transition there.');
  }

  // ---------- projects ----------

  /** Starts a new, empty project (nothing is asked; callers check for unsaved work first). */
  newProject(opts: { name?: string; width?: number; height?: number; fps?: number } = {}): void {
    this.player.reset();
    const p = newProject(opts.name ?? 'Untitled', { width: opts.width ?? 1920, height: opts.height ?? 1080, fps: opts.fps ?? 30 });
    this.setProject(p, null);
  }

  /** A new project asked for from outside (Baseline): { new: '1920x1080', fps, name }. */
  newFromOptions(o: Record<string, string>): void {
    const m = /^(\d{2,5})x(\d{2,5})$/.exec(o.new ?? '');
    if (!m) return;
    void this.confirmDiscard().then((ok) => {
      if (!ok) return;
      const fps = Number(o.fps) > 0 ? Number(o.fps) : 30;
      this.newProject({ name: o.name?.trim() || 'Untitled', width: Math.min(8192, +m[1]), height: Math.min(8192, +m[2]), fps });
      this.closeHome();
    });
  }

  private setProject(p: Project, path: string | null): void {
    this.project = p;
    this.projectPath = path;
    this.selection.clear();
    this.transitionSel = null;
    this.history.clear();
    this.history.markSaved();
    this.recoveredAt = -1;
    this.player.frame = this.seq.playhead ?? 0;
    this.emit('sequence', 'project', 'history', 'media', 'selection', 'playhead');
    this.titlebar.refresh();
    this.commands.refresh();
    platform.setDirty(false);
    void this.checkMedia();
    this.player.refresh();
  }

  /** Media paths next to the project, for files that moved along with it. */
  private movedCandidates = new Map<string, string>();

  /** Notes media files that aren't where the project says (finding ones that moved with the project). */
  async checkMedia(): Promise<void> {
    const p = this.project;
    if (!p || !isDesktop || !p.media.length) return;
    let found = await platform.checkMedia(p.media.map((m) => m.path));
    const moved = p.media.filter((m) => !found[m.path] && this.movedCandidates.has(m.id));
    if (moved.length) {
      const there = await platform.checkMedia(moved.map((m) => this.movedCandidates.get(m.id)!));
      for (const m of moved) {
        const c = this.movedCandidates.get(m.id)!;
        if (there[c]) m.path = c;
      }
      found = await platform.checkMedia(p.media.map((m) => m.path));
    }
    let missing = 0;
    for (const m of p.media) {
      if (found[m.path]) this.library.missing.delete(m.id);
      else {
        this.library.missing.add(m.id);
        missing++;
      }
    }
    this.emit('media');
    if (missing) toast(`${missing} media file${missing === 1 ? ' is' : 's are'} missing. Find ${missing === 1 ? 'it' : 'them'} in the Project panel (right-click → Locate).`, { kind: 'error', ms: 9000 });
  }

  /** Before quitting to install an update. */
  saveBeforeQuit(): Promise<boolean> {
    return this.confirmDiscard('closing');
  }

  /** Asks to save unsaved work. Returns false when the user cancels. */
  async confirmDiscard(why: 'closing' | 'other' = 'other'): Promise<boolean> {
    if (!this.project || !this.history.dirty || !this.history.undoCount) return true;
    const choice = await dialog<'save' | 'discard' | 'cancel'>(
      'Save changes?',
      `Do you want to save the changes to "${this.project.name}"${why === 'closing' ? ' before closing' : ''}?`,
      [
        { label: 'Save', value: 'save', primary: true },
        { label: "Don't save", value: 'discard' },
        { label: 'Cancel', value: 'cancel' },
      ],
      { cancelValue: 'cancel' },
    );
    if (choice === 'cancel') return false;
    if (choice === 'save') return this.save();
    return true;
  }

  async openDialog(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const f = await platform.openProjectDialog();
    if (f) this.loadProject(f.text, f.path);
  }

  /** Files from Explorer or a drop: a project opens; media is imported. */
  async openPaths(paths: string[]): Promise<void> {
    const project = paths.find((p) => /\.frameline$/i.test(p));
    if (project) {
      if (!(await this.confirmDiscard())) return;
      try {
        const f = await platform.openProject(project);
        if (f) this.loadProject(f.text, f.path);
      } catch (err) {
        this.error(err);
      }
    }
    const media = paths.filter((p) => !/\.frameline$/i.test(p));
    if (media.length) {
      this.closeHome();
      const list = Object.values(await platform.checkMedia(media)).filter((x): x is MediaFileInfo => !!x);
      if (list.length) await this.importFiles(list);
    }
  }

  async openRecent(path: string): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    try {
      const f = await platform.openProject(path);
      if (f) this.loadProject(f.text, f.path);
    } catch (err) {
      this.error(err);
      void platform.removeRecentFile(path);
    }
  }

  loadProject(text: string, path: string | null): void {
    try {
      const p = readProject(text);
      // Where media would be if it moved along with the project's folder
      const rel = (JSON.parse(text) as { relative?: Record<string, string> }).relative ?? {};
      const dir = path?.replace(/[\\/][^\\/]*$/, '');
      this.movedCandidates = new Map(dir ? Object.entries(rel).map(([id, r]) => [id, `${dir}\\${r}`]) : []);
      this.player.reset();
      this.setProject(p, path);
      this.closeHome();
      this.statusbar.flash(`Opened ${p.name}`);
    } catch (err) {
      this.error(err);
    }
  }

  private relativePaths(projectPath: string): Record<string, string> {
    const dir = projectPath.replace(/[\\/][^\\/]*$/, '').toLowerCase();
    const out: Record<string, string> = {};
    for (const m of this.project?.media ?? []) {
      if (m.path.toLowerCase().startsWith(dir + '\\') || m.path.toLowerCase().startsWith(dir + '/')) out[m.id] = m.path.slice(dir.length + 1);
    }
    return out;
  }

  async save(): Promise<boolean> {
    if (!this.project) return false;
    if (!this.projectPath) return this.saveAs();
    return this.writeTo(this.projectPath);
  }

  async saveAs(): Promise<boolean> {
    if (!this.project) return false;
    const path = await platform.saveProjectDialog(`${this.project.name || 'Untitled'}.frameline`);
    if (!path) return false;
    return this.writeTo(path);
  }

  private async writeTo(path: string, quiet = false): Promise<boolean> {
    const p = this.project!;
    p.name = path.split(/[\\/]/).pop()!.replace(/\.frameline$/i, '') || p.name;
    this.seq.playhead = this.playhead;
    const res = await platform.saveProject(path, writeProject(p, this.relativePaths(path)));
    if (!res.ok) {
      toast(res.error ?? "Couldn't save the project.", { kind: 'error' });
      return false;
    }
    this.projectPath = path;
    this.history.markSaved();
    platform.setDirty(false);
    void platform.recovery.remove(this.recoveryId);
    this.titlebar.refresh();
    this.emit('history');
    if (!quiet) this.statusbar.flash(`Saved ${p.name}`);
    return true;
  }

  // ---------- automatic saving and recovery ----------

  private autosaveTimer: number | undefined;
  private recoveryTimer: number | undefined;

  startAutosave(): void {
    clearInterval(this.autosaveTimer);
    const minutes = this.settings.num('files.autosaveMinutes');
    if (!isDesktop || !minutes) return;
    this.autosaveTimer = window.setInterval(() => {
      if (this.project && this.projectPath && this.history.dirty) void this.writeTo(this.projectPath, true).then((ok) => ok && this.statusbar.flash('Saved automatically'));
    }, minutes * 60_000);
  }

  startRecovery(): void {
    clearInterval(this.recoveryTimer);
    const minutes = this.settings.num('files.recoveryMinutes');
    if (!isDesktop || !minutes) return;
    this.recoveryTimer = window.setInterval(() => {
      const p = this.project;
      if (!p || !this.history.dirty || this.recoveredAt === this.history.current) return;
      this.recoveredAt = this.history.current;
      void platform.recovery.save(this.recoveryId, writeProject(p), { name: p.name, filePath: this.projectPath });
    }, minutes * 60_000);
  }

  async restoreRecovered(id: string, name: string, filePath: string | null): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const text = await platform.recovery.read(id);
    if (!text) {
      toast("That copy couldn't be read.", { kind: 'error' });
      return;
    }
    this.loadProject(text, filePath);
    this.history.markUnsaved();
    platform.setDirty(true);
    this.titlebar.refresh();
    await platform.recovery.remove(id);
    toast(`Recovered "${name}". Save it to keep it.`, { kind: 'success' });
  }

  // ---------- start page and settings ----------

  get homeOpen(): boolean {
    return !!this.home;
  }

  openHome(section: HomeSection = 'home'): void {
    closePopovers();
    this.player.pause();
    if (this.home) {
      this.home.show(section);
      return;
    }
    this.home = new HomeView(this, section, () => {
      this.home = null;
      this.layout.timeline.focus();
    });
    document.body.append(this.home.el);
  }

  closeHome(): void {
    this.home?.close();
  }

  openSettings(section?: string): void {
    closePopovers();
    if (this.settingsView) {
      this.settingsView.show(section);
      return;
    }
    this.settingsView = new SettingsView(this, section, () => {
      this.settingsView = null;
    });
    document.body.append(this.settingsView.el);
  }

  // ---------- theme ----------

  get isDark(): boolean {
    const t = this.settings.str('appearance.theme');
    return t === 'system' ? this.systemDark.matches : t === 'dark';
  }

  applyTheme(): void {
    const root = document.documentElement;
    const dark = this.isDark;
    root.dataset.theme = dark ? 'dark' : 'light';
    const pair = ACCENTS[this.settings.str('appearance.accent')] ?? ACCENTS.red;
    const a = dark ? pair[0] : pair[1];
    const [r, g, b] = hexToRgb(a);
    const vars: Record<string, string> = {
      '--accent': a,
      '--accent-strong': shade(a, dark ? -0.15 : -0.2),
      '--accent-soft': `rgba(${r}, ${g}, ${b}, ${dark ? 0.16 : 0.12})`,
      '--accent-text': dark ? '#1a0508' : '#ffffff',
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    platform.setTheme({ dark, bar: dark ? '#16181d' : '#f6f7f9', symbol: dark ? '#c9ced8' : '#3c4350' });
    this.titlebar.refresh();
    this.emit('settings');
  }

  applyChrome(): void {
    const s = this.settings;
    const root = document.documentElement;
    root.classList.toggle('is-desktop', isDesktop);
    root.classList.toggle('reduce-motion', s.bool('appearance.reduceMotion'));
    this.statusbar.el.hidden = !s.bool('appearance.showStatusBar');
  }

  private onSettingChanged(id: string): void {
    const d = this.settings.byId.get(id);
    if (!d) return;
    d.apply?.(this.settings.get(id) as never, this);
    const r = new Set<Refresh>(d.refresh ?? []);
    if (r.has('theme')) this.applyTheme();
    if (r.has('chrome')) this.applyChrome();
    if (r.has('titlebar')) this.titlebar.rebuild();
    this.emit('settings');
  }

  // ---------- keyboard and dropping files ----------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    if (document.querySelector('.modal-backdrop') || this.settingsView) return;
    if (isTyping(e.target)) {
      const c = this.commands.match(e);
      if (c?.global) {
        e.preventDefault();
        this.commands.run(c.id);
      }
      return;
    }
    if (this.home) {
      const c = this.commands.match(e);
      if (c && (c.category === 'File' || c.global)) {
        e.preventDefault();
        this.commands.run(c.id);
      }
      return;
    }
    if (document.querySelector('.popover')) return;
    const c = this.commands.match(e);
    if (c) {
      e.preventDefault();
      this.commands.run(c.id);
      return;
    }
    // Alt alone would focus the window menu in some shells
    if (eventKey(e) === 'Alt') e.preventDefault();
  }

  private setupDrop(): void {
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    window.addEventListener('drop', (e) => {
      // Drops on the timeline place clips there; anywhere else imports them
      if (!e.dataTransfer?.files.length || e.defaultPrevented) return;
      e.preventDefault();
      void this.dropFiles([...e.dataTransfer.files]);
    });
  }

  /** Files dropped from Explorer: projects open, media is imported. */
  async dropFiles(files: File[]): Promise<MediaItem[]> {
    const project = files.find((f) => /\.frameline$/i.test(f.name));
    if (project) {
      const [info] = await platform.droppedFiles([project]);
      if (info) await this.openPaths([info.path]);
      else if (!isDesktop) this.loadProject(await project.text(), null);
      return [];
    }
    const infos = await platform.droppedFiles(files.filter((f) => !/\.frameline$/i.test(f.name)));
    this.closeHome();
    return this.importFiles(infos);
  }
}
