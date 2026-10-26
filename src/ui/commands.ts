// Every action in the app, with keyboard shortcuts (Premiere's, where it has one). The menus, the
// command search and the keyboard all use these.
import * as L from 'lucide';
import type { IconNode } from 'lucide';
import { addFrameHold, addMarker, addTrack, closeGap, editPoints, liftRange, nudge, razor, removeClips, trimToPlayhead } from '../core/edit';
import { allTracks, clipEnd, findClip, sequenceDuration, sourceTimeAt, TITLE_PRESETS, uid } from '../core/project';
import type { App } from './app';
import { h } from './dom';
import { exportCaptions, importCaptions } from './dialogs/captions';
import { autoDuck } from './dialogs/ducking';
import { normalizeSelected, openAudioGain } from './dialogs/audioGain';
import { exportFrame, openExport } from './dialogs/export';
import { detectScenes } from './dialogs/scenes';
import { openSequenceSettings } from './dialogs/sequence';
import { openSpeed } from './dialogs/speed';
import { showAbout, showShortcuts } from './help';
import { WORKSPACES } from './layout';
import { openPalette } from './palette';
import { isDesktop, platform } from './platform';
import { TOOLS } from './timeline/tools';
import { colorPicker, dialog, promptDialog, toast } from './widgets';

export interface Command {
  id: string;
  title: string;
  category: string;
  keys?: string[];
  icon?: IconNode;
  keywords?: string;
  /** Runs even when focus is in a text field. */
  global?: boolean;
  /** Left out of menus and search (shortcut only). */
  hidden?: boolean;
  run: () => unknown;
  enabled?: () => boolean;
  checked?: () => boolean;
}

const CODE_KEYS: Record<string, string> = {
  Semicolon: ';',
  Equal: '=',
  Minus: '-',
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Quote: "'",
  NumpadAdd: '=',
  NumpadSubtract: '-',
  Space: 'Space',
};

/** Turns a keyboard event into a string like "Ctrl+Shift+K". */
export function eventKey(e: KeyboardEvent): string {
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key.replace(/^Arrow/, '');
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export class Commands {
  private list: Command[] = [];
  private byId = new Map<string, Command>();
  private byKey = new Map<string, Command>();
  private listeners = new Set<() => void>();

  constructor(private app: App) {
    this.register();
  }

  all(): Command[] {
    return this.list.filter((c) => !c.hidden);
  }

  get(id: string): Command | undefined {
    return this.byId.get(id);
  }

  match(e: KeyboardEvent): Command | undefined {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return undefined;
    return this.byKey.get(eventKey(e));
  }

  isEnabled(c: Command): boolean {
    if (!this.app.project) return c.category === 'File' || c.category === 'Help';
    return !c.enabled || c.enabled();
  }

  run(id: string): void {
    const c = this.byId.get(id);
    if (!c || !this.isEnabled(c)) return;
    if (this.app.settings.bool('keyboard.remember') && !c.hidden) {
      const recent = this.app.prefs.recentCommands.filter((x) => x !== id);
      recent.unshift(id);
      this.app.prefs.recentCommands = recent.slice(0, 8);
      this.app.savePrefs();
    }
    try {
      const r = c.run();
      if (r instanceof Promise) r.catch((err: Error) => this.app.error(err));
    } catch (err) {
      this.app.error(err);
    }
  }

  /** Enabled states may have changed (selection, history). */
  refresh(): void {
    for (const l of this.listeners) l();
  }

  onRefresh(fn: () => void): void {
    this.listeners.add(fn);
  }

  private add(c: Command): void {
    this.list.push(c);
    this.byId.set(c.id, c);
    for (const k of c.keys ?? []) this.byKey.set(k, c);
  }

  private register(): void {
    const app = this.app;
    const a = (c: Command) => this.add(c);
    const s = () => app.seq;
    const hasSel = () => app.selection.size > 0;
    const hasClipSel = () => app.selection.size > 0 || !!app.transitionSel;
    const fps = () => app.fps;
    const step = (n: number) => () => {
      app.player.pause();
      app.setPlayhead(app.playhead + n);
      app.layout.timeline.reveal(app.playhead);
    };
    const go = (f: number) => {
      app.player.pause();
      app.setPlayhead(f);
      app.layout.timeline.reveal(f);
    };
    /** The Source monitor takes I, O and friends when it was clicked last. */
    const source = () => app.layout.source.active && !!app.layout.source.current;

    // ---------- File ----------
    a({ id: 'file.new', title: 'New project…', category: 'File', icon: L.FilePlus, keys: ['Ctrl+Alt+N'], global: true, run: () => app.openHome('new') });
    a({ id: 'file.newSequence', title: 'New sequence…', category: 'File', icon: L.Clapperboard, keys: ['Ctrl+N'], run: () => openSequenceSettings(app, 'new') });
    a({ id: 'file.open', title: 'Open project…', category: 'File', icon: L.FolderOpen, keys: ['Ctrl+O'], global: true, run: () => app.openDialog() });
    a({ id: 'file.home', title: 'Start page', category: 'File', icon: L.House, run: () => app.openHome('home') });
    a({ id: 'file.save', title: 'Save', category: 'File', icon: L.Save, keys: ['Ctrl+S'], global: true, run: () => app.save() });
    a({ id: 'file.saveAs', title: 'Save as…', category: 'File', icon: L.SaveAll, keys: ['Ctrl+Shift+S'], global: true, run: () => app.saveAs() });
    a({ id: 'file.import', title: 'Import media…', category: 'File', icon: L.FolderInput, keys: ['Ctrl+I'], keywords: 'add video audio music pictures', run: () => app.importFiles() });
    a({ id: 'file.export', title: 'Export media…', category: 'File', icon: L.Upload, keys: ['Ctrl+M'], keywords: 'render mp4 webm youtube save video', run: () => openExport(app) });
    a({ id: 'file.exportFrame', title: 'Export frame…', category: 'File', icon: L.Camera, keys: ['Ctrl+Shift+E'], keywords: 'screenshot still png jpg thumbnail', run: () => exportFrame(app) });
    a({ id: 'file.importCaptions', title: 'Import captions…', category: 'File', icon: L.Captions, keywords: 'subtitles srt vtt', run: () => importCaptions(app) });
    a({ id: 'file.exportCaptions', title: 'Export captions…', category: 'File', icon: L.Captions, keywords: 'subtitles srt vtt', run: () => exportCaptions(app) });
    a({ id: 'file.showInFolder', title: 'Show project in folder', category: 'File', icon: L.FolderSearch, enabled: () => !!app.projectPath && isDesktop, run: () => platform.showInFolder(app.projectPath!) });
    a({ id: 'file.newWindow', title: 'New window', category: 'File', icon: L.AppWindow, keys: ['Ctrl+Shift+N'], run: () => platform.newWindow() });
    a({ id: 'app.settings', title: 'Settings', category: 'File', icon: L.Settings, keys: ['Ctrl+,'], global: true, run: () => app.openSettings() });

    // ---------- Edit ----------
    a({ id: 'edit.undo', title: 'Undo', category: 'Edit', icon: L.Undo2, keys: ['Ctrl+Z'], enabled: () => app.history.canUndo, run: () => app.undo() });
    a({ id: 'edit.redo', title: 'Redo', category: 'Edit', icon: L.Redo2, keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], enabled: () => app.history.canRedo, run: () => app.redo() });
    a({ id: 'edit.cut', title: 'Cut', category: 'Edit', icon: L.Scissors, keys: ['Ctrl+X'], enabled: hasSel, run: () => app.copy(true) });
    a({ id: 'edit.copy', title: 'Copy', category: 'Edit', icon: L.Copy, keys: ['Ctrl+C'], enabled: hasSel, run: () => app.copy() });
    a({ id: 'edit.paste', title: 'Paste', category: 'Edit', icon: L.ClipboardPaste, keys: ['Ctrl+V'], enabled: () => !!app.clipboard, run: () => app.paste('overwrite') });
    a({ id: 'edit.pasteInsert', title: 'Paste insert', category: 'Edit', keys: ['Ctrl+Shift+V'], enabled: () => !!app.clipboard, run: () => app.paste('insert') });
    a({ id: 'edit.pasteAttributes', title: 'Paste attributes…', category: 'Edit', keys: ['Ctrl+Alt+V'], keywords: 'copy effects motion', enabled: () => !!app.clipboard && hasSel(), run: () => app.pasteAttributes() });
    a({
      id: 'edit.clear',
      title: 'Delete',
      category: 'Edit',
      icon: L.Trash2,
      keys: ['Delete', 'Backspace'],
      enabled: hasClipSel,
      run: () => {
        const ts = app.transitionSel;
        if (ts) {
          app.edit('Delete transition', (seq) => {
            const f = findClip(seq, ts.clipId);
            if (!f) return false;
            if (ts.side === 'in') delete f.clip.transIn;
            else delete f.clip.transOut;
          });
          return;
        }
        const ids = new Set(app.selection);
        app.edit('Delete', (seq) => removeClips(seq, ids, false));
      },
    });
    a({ id: 'edit.rippleDelete', title: 'Ripple delete', category: 'Edit', keys: ['Shift+Delete', 'Shift+Backspace'], keywords: 'close gap remove', enabled: hasSel, run: () => {
      const ids = new Set(app.selection);
      app.edit('Ripple delete', (seq) => removeClips(seq, ids, true));
    } });
    a({ id: 'edit.duplicate', title: 'Duplicate', category: 'Edit', icon: L.CopyPlus, keys: ['Ctrl+Shift+/'], enabled: hasSel, run: () => {
      // A copy right after the selection, on the same tracks
      const list = app.selectedClips();
      const end = Math.max(...list.map((x) => clipEnd(x.clip)));
      app.copy();
      app.player.seek(end);
      app.paste('insert');
    } });
    a({ id: 'edit.selectAll', title: 'Select all', category: 'Edit', keys: ['Ctrl+A'], run: () => app.select(allTracks(s()).flatMap((t) => t.clips.map((c) => c.id))) });
    a({ id: 'edit.deselect', title: 'Deselect all', category: 'Edit', keys: ['Ctrl+Shift+A', 'Escape'], run: () => app.clearSelection() });
    a({ id: 'edit.lift', title: 'Lift (remove in to out, leave a gap)', category: 'Edit', icon: L.ArrowUpFromLine, keys: [';'], enabled: () => s().inPoint !== null && s().outPoint !== null, run: () => app.edit('Lift', (seq) => liftRange(seq, seq.inPoint!, seq.outPoint!, false)) });
    a({ id: 'edit.extract', title: 'Extract (remove in to out, close the gap)', category: 'Edit', icon: L.ArrowUpToLine, keys: ["'"], enabled: () => s().inPoint !== null && s().outPoint !== null, run: () => app.edit('Extract', (seq) => liftRange(seq, seq.inPoint!, seq.outPoint!, true)) });

    // ---------- Clip ----------
    a({ id: 'clip.speed', title: 'Speed / Duration…', category: 'Clip', icon: L.Gauge, keys: ['Ctrl+R'], keywords: 'slow motion fast reverse', enabled: hasSel, run: () => openSpeed(app) });
    a({ id: 'clip.enable', title: 'Enable / disable', category: 'Clip', icon: L.EyeOff, keys: ['Shift+E'], enabled: hasSel, run: () => {
      const on = !app.selectedClips().every((x) => x.clip.enabled);
      app.edit(on ? 'Enable clips' : 'Disable clips', () => {
        for (const { clip } of app.selectedClips()) clip.enabled = on;
      });
    } });
    a({ id: 'clip.link', title: 'Link / unlink', category: 'Clip', icon: L.Link, keys: ['Ctrl+L'], keywords: 'unlink audio video separate', enabled: hasSel, run: () => {
      const list = app.selectedClips();
      const linked = list.some((x) => x.clip.linkId);
      app.edit(linked ? 'Unlink' : 'Link', () => {
        const id = uid('l');
        for (const { clip } of app.selectedClips()) {
          if (linked) delete clip.linkId;
          else clip.linkId = id;
        }
      });
    } });
    a({ id: 'clip.frameHold', title: 'Add frame hold', category: 'Clip', icon: L.Snowflake, keywords: 'freeze frame still', enabled: () => app.selectedClips().some((x) => x.clip.kind === 'video'), run: () => {
      const c = app.selectedClips().find((x) => x.clip.kind === 'video' && x.clip.start <= app.playhead && clipEnd(x.clip) > app.playhead);
      if (!c) {
        toast('Put the playhead over the selected video clip, where the picture should freeze.');
        return;
      }
      app.edit('Add frame hold', (seq) => !!addFrameHold(seq, c.clip.id, app.playhead));
    } });
    a({ id: 'clip.scenes', title: 'Scene edit detection…', category: 'Clip', icon: L.ScanLine, keywords: 'cut detect shots split automatically', enabled: () => app.selectedClips().some((x) => x.clip.kind === 'video'), run: () => detectScenes(app) });
    a({ id: 'clip.audioGain', title: 'Audio gain…', category: 'Clip', icon: L.AudioLines, keys: ['G'], keywords: 'louder quieter volume normalize', enabled: () => app.selectedClips().some((x) => x.clip.kind === 'audio'), run: () => openAudioGain(app) });
    a({ id: 'clip.duck', title: 'Auto-duck music…', category: 'Clip', icon: L.AudioLines, keywords: 'ducking lower music under voice speech dialogue background', enabled: () => app.selectedClips().some((x) => x.clip.kind === 'audio'), run: () => autoDuck(app) });
    a({ id: 'clip.normalize', title: 'Normalize audio', category: 'Clip', icon: L.AudioWaveform, keywords: 'loudness level peak', enabled: () => app.selectedClips().some((x) => x.clip.kind === 'audio'), run: () => normalizeSelected(app, -1) });
    a({ id: 'clip.rename', title: 'Rename…', category: 'Clip', enabled: hasSel, run: async () => {
      const first = app.selectedClips()[0];
      const name = await promptDialog('Rename clip', 'Name', first.clip.name);
      if (name?.trim()) app.edit('Rename clip', () => {
        for (const { clip } of app.selectedClips()) clip.name = name.trim();
      });
    } });
    a({ id: 'clip.nudgeLeft', title: 'Nudge one frame left', category: 'Clip', keys: ['Alt+Left', 'Ctrl+Left'], enabled: hasSel, run: () => {
      const ids = new Set(app.selection);
      if (!app.edit('Nudge', (seq) => nudge(seq, ids, -1))) app.statusbar.flash('No room to move there');
    } });
    a({ id: 'clip.nudgeRight', title: 'Nudge one frame right', category: 'Clip', keys: ['Alt+Right', 'Ctrl+Right'], enabled: hasSel, run: () => {
      const ids = new Set(app.selection);
      if (!app.edit('Nudge', (seq) => nudge(seq, ids, 1))) app.statusbar.flash('No room to move there');
    } });
    const placeFromSource = (mode: 'insert' | 'overwrite') => {
      if (app.layout.source.current) void app.layout.source.place(mode);
      else toast('Open a file in the Source monitor first (double-click it in the Project panel).');
    };
    a({ id: 'clip.insert', title: 'Insert (from Source)', category: 'Clip', icon: L.ListPlus, keys: [','], run: () => placeFromSource('insert') });
    a({ id: 'clip.overwrite', title: 'Overwrite (from Source)', category: 'Clip', icon: L.ListEnd, keys: ['.'], run: () => placeFromSource('overwrite') });
    a({ id: 'clip.matchFrame', title: 'Match frame', category: 'Clip', keys: ['F'], keywords: 'source open original', run: () => {
      const f = app.playhead;
      const top = [...s().video].reverse().map((t) => t.clips.find((c) => c.start <= f && clipEnd(c) > f && c.mediaId)).find(Boolean);
      if (!top) return;
      app.layout.source.open(top.mediaId!, sourceTimeAt(top, f, fps()));
    } });

    // ---------- Sequence ----------
    a({ id: 'sequence.settings', title: 'Sequence settings…', category: 'Sequence', icon: L.Settings2, keywords: 'resolution frame rate size', run: () => openSequenceSettings(app, 'edit') });
    a({ id: 'sequence.razor', title: 'Add edit (cut at the playhead)', category: 'Sequence', icon: L.Scissors, keys: ['Ctrl+K'], keywords: 'razor split cut', run: () => {
      const f = app.playhead;
      const only = app.selection.size ? new Set(app.selection) : undefined;
      if (!app.edit('Add edit', (seq) => razor(seq, f, only) > 0)) app.statusbar.flash('No clip under the playhead to cut');
    } });
    a({ id: 'sequence.razorAll', title: 'Add edit to all tracks', category: 'Sequence', keys: ['Ctrl+Shift+K'], run: () => {
      const f = app.playhead;
      app.edit('Add edit to all tracks', (seq) => razor(seq, f) > 0);
    } });
    a({ id: 'sequence.trimPrev', title: 'Ripple trim start to playhead', category: 'Sequence', keys: ['Q'], run: () => app.edit('Ripple trim to playhead', (seq) => trimToPlayhead(seq, app.playhead, 'prev')) });
    a({ id: 'sequence.trimNext', title: 'Ripple trim end to playhead', category: 'Sequence', keys: ['W'], run: () => app.edit('Ripple trim to playhead', (seq) => trimToPlayhead(seq, app.playhead, 'next')) });
    a({ id: 'sequence.transition', title: 'Apply video transition', category: 'Sequence', icon: L.Blend, keys: ['Ctrl+D'], keywords: 'dissolve fade', run: () => app.addDefaultTransition('video') });
    a({ id: 'sequence.audioTransition', title: 'Apply audio transition', category: 'Sequence', keys: ['Ctrl+Shift+D'], keywords: 'crossfade', run: () => app.addDefaultTransition('audio') });
    a({ id: 'sequence.transitionsSelected', title: 'Apply transitions to selection', category: 'Sequence', keys: ['Shift+D'], enabled: hasSel, run: () => {
      app.addDefaultTransition('video');
      app.addDefaultTransition('audio');
    } });
    a({ id: 'sequence.closeGap', title: 'Close gap at playhead', category: 'Sequence', icon: L.FoldHorizontal, run: () => {
      const f = app.playhead;
      app.edit('Close gap', (seq) => seq.video.concat(seq.audio).some((t) => !t.locked && closeGap(seq, t, f)));
    } });
    a({ id: 'sequence.addVideoTrack', title: 'Add video track', category: 'Sequence', icon: L.Film, run: () => app.edit('Add video track', (seq) => void addTrack(seq, 'video')) });
    a({ id: 'sequence.addAudioTrack', title: 'Add audio track', category: 'Sequence', icon: L.AudioLines, run: () => app.edit('Add audio track', (seq) => void addTrack(seq, 'audio')) });
    a({ id: 'sequence.nextEdit', title: 'Go to next edit', category: 'Sequence', keys: ['Down'], run: () => {
      const n = editPoints(s()).find((x) => x > app.playhead);
      if (n !== undefined) go(n);
    } });
    a({ id: 'sequence.prevEdit', title: 'Go to previous edit', category: 'Sequence', keys: ['Up'], run: () => {
      const n = [...editPoints(s())].reverse().find((x) => x < app.playhead);
      if (n !== undefined) go(n);
    } });
    a({ id: 'timeline.snap', title: 'Snap', category: 'Sequence', icon: L.Magnet, keys: ['S'], checked: () => app.prefs.snap, run: () => {
      app.prefs.snap = !app.prefs.snap;
      app.savePrefs();
      app.statusbar.flash(app.prefs.snap ? 'Snapping on' : 'Snapping off');
      app.emit('settings');
    } });
    a({ id: 'timeline.linked', title: 'Linked selection', category: 'Sequence', icon: L.Link, checked: () => app.prefs.linked, run: () => {
      app.prefs.linked = !app.prefs.linked;
      app.savePrefs();
      app.emit('settings');
    } });

    // ---------- Markers ----------
    a({ id: 'mark.in', title: 'Mark in', category: 'Markers', icon: L.ArrowRightToLine, keys: ['I'], run: () => {
      if (source()) return app.layout.source.mark('in');
      const f = app.playhead;
      app.edit('Mark in', (seq) => {
        seq.inPoint = f;
        if (seq.outPoint !== null && seq.outPoint <= f) seq.outPoint = null;
      });
    } });
    a({ id: 'mark.out', title: 'Mark out', category: 'Markers', icon: L.ArrowLeftToLine, keys: ['O'], run: () => {
      if (source()) return app.layout.source.mark('out');
      const f = app.playhead + 1;
      app.edit('Mark out', (seq) => {
        seq.outPoint = f;
        if (seq.inPoint !== null && seq.inPoint >= f) seq.inPoint = null;
      });
    } });
    a({ id: 'mark.clip', title: 'Mark clip', category: 'Markers', keys: ['X'], keywords: 'in out selection', run: () => {
      const list = app.selectedClips();
      const f = app.playhead;
      const pool = list.length ? list.map((x) => x.clip) : allTracks(s()).flatMap((t) => t.clips.filter((c) => c.start <= f && clipEnd(c) > f));
      if (!pool.length) return;
      app.edit('Mark clip', (seq) => {
        seq.inPoint = Math.min(...pool.map((c) => c.start));
        seq.outPoint = Math.max(...pool.map(clipEnd));
      });
    } });
    a({ id: 'go.in', title: 'Go to in point', category: 'Markers', keys: ['Shift+I'], run: () => (source() ? app.layout.source.seek(app.layout.source.range().in) : s().inPoint !== null && go(s().inPoint!)) });
    a({ id: 'go.out', title: 'Go to out point', category: 'Markers', keys: ['Shift+O'], run: () => (source() ? app.layout.source.seek(app.layout.source.range().out) : s().outPoint !== null && go(s().outPoint! - 1)) });
    a({ id: 'mark.clearIn', title: 'Clear in', category: 'Markers', keys: ['Ctrl+Shift+I'], run: () => app.edit('Clear in', (seq) => void (seq.inPoint = null)) });
    a({ id: 'mark.clearOut', title: 'Clear out', category: 'Markers', keys: ['Ctrl+Shift+O'], run: () => app.edit('Clear out', (seq) => void (seq.outPoint = null)) });
    a({ id: 'mark.clear', title: 'Clear in and out', category: 'Markers', keys: ['Ctrl+Shift+X'], run: () => {
      if (source()) return app.layout.source.mark('clear');
      app.edit('Clear in and out', (seq) => {
        seq.inPoint = null;
        seq.outPoint = null;
      });
    } });
    a({ id: 'marker.add', title: 'Add marker', category: 'Markers', icon: L.Bookmark, keys: ['M'], run: () => {
      const f = app.playhead;
      app.edit('Add marker', (seq) => void addMarker(seq, f));
    } });
    a({ id: 'marker.next', title: 'Go to next marker', category: 'Markers', keys: ['Shift+M'], run: () => {
      const m = s().markers.find((x) => x.f > app.playhead);
      if (m) go(m.f);
    } });
    a({ id: 'marker.prev', title: 'Go to previous marker', category: 'Markers', keys: ['Ctrl+Shift+M'], run: () => {
      const m = [...s().markers].reverse().find((x) => x.f < app.playhead);
      if (m) go(m.f);
    } });
    a({ id: 'marker.clear', title: 'Clear marker at playhead', category: 'Markers', keys: ['Ctrl+Alt+M'], enabled: () => s().markers.some((m) => m.f === app.playhead), run: () => app.edit('Clear marker', (seq) => void (seq.markers = seq.markers.filter((m) => m.f !== app.playhead))) });
    a({ id: 'marker.clearAll', title: 'Clear all markers', category: 'Markers', enabled: () => s().markers.length > 0, run: () => app.edit('Clear all markers', (seq) => void (seq.markers = [])) });

    // ---------- Graphics ----------
    a({ id: 'graphics.title', title: 'New title', category: 'Graphics', icon: L.Type, keys: ['Ctrl+T'], keywords: 'text caption words', run: () => app.newTitle() });
    for (const p of TITLE_PRESETS.slice(1)) a({ id: `graphics.title.${p.id}`, title: `New title: ${p.name.toLowerCase()}`, category: 'Graphics', icon: L.Type, keywords: 'text', run: () => app.newTitle(p.style, p.name) });
    a({ id: 'graphics.colorMatte', title: 'New color matte…', category: 'Graphics', icon: L.Square, keywords: 'background solid color', run: async () => {
      let color = '#1b1e24';
      const picker = colorPicker((c) => c && (color = c), { current: color });
      if (await dialog('New color matte', h('div', null, h('p', { class: 'hint' }, 'A solid color, for backgrounds and fades.'), picker), [{ label: 'Add', value: true, primary: true }, { label: 'Cancel', value: false }])) app.newGenerated('color', color);
    } });
    a({ id: 'graphics.adjustment', title: 'New adjustment layer', category: 'Graphics', icon: L.Layers, keywords: 'grade color all clips effect', run: () => app.newGenerated('adjustment') });

    // ---------- Playback ----------
    a({ id: 'play.toggle', title: 'Play / stop', category: 'Playback', icon: L.Play, keys: ['Space'], run: () => {
      if (source()) return app.layout.source.toggle();
      if (app.voiceover.recording) return void app.voiceover.stop();
      if (app.player.playing) {
        app.player.pause();
        if (app.settings.bool('playback.returnOnStop')) app.setPlayhead(this.playStart);
      } else {
        this.playStart = app.playhead;
        app.player.play(1);
      }
    } });
    a({ id: 'play.forward', title: 'Play forward (faster each press)', category: 'Playback', keys: ['L'], run: () => {
      const p = app.player;
      p.play(p.playing && p.rate > 0 ? Math.min(8, p.rate * 2) : 1);
    } });
    a({ id: 'play.reverse', title: 'Play backward (faster each press)', category: 'Playback', keys: ['J'], run: () => {
      const p = app.player;
      p.play(p.playing && p.rate < 0 ? Math.max(-8, p.rate * 2) : -1);
    } });
    a({ id: 'play.stop', title: 'Stop', category: 'Playback', keys: ['K'], run: () => app.player.pause() });
    a({ id: 'play.inOut', title: 'Play in to out', category: 'Playback', keys: ['Ctrl+Shift+Space'], run: () => {
      const seq = s();
      app.player.loop = app.settings.bool('playback.loop');
      app.player.play(1, [seq.inPoint ?? 0, seq.outPoint ?? sequenceDuration(seq)]);
    } });
    a({ id: 'play.loop', title: 'Loop playback', category: 'Playback', icon: L.Repeat, checked: () => app.player.loop, run: () => {
      app.player.loop = !app.player.loop;
      app.emit('playhead');
    } });
    a({ id: 'play.back1', title: 'Back one frame', category: 'Playback', keys: ['Left'], run: () => (source() ? app.layout.source.step(-1) : step(-1)()) });
    a({ id: 'play.fwd1', title: 'Forward one frame', category: 'Playback', keys: ['Right'], run: () => (source() ? app.layout.source.step(1) : step(1)()) });
    a({ id: 'play.back5', title: 'Back five frames', category: 'Playback', keys: ['Shift+Left'], run: step(-5) });
    a({ id: 'play.fwd5', title: 'Forward five frames', category: 'Playback', keys: ['Shift+Right'], run: step(5) });
    a({ id: 'play.start', title: 'Go to the start', category: 'Playback', keys: ['Home'], run: () => go(0) });
    a({ id: 'play.end', title: 'Go to the end', category: 'Playback', keys: ['End'], run: () => go(sequenceDuration(s())) });

    // ---------- View ----------
    a({ id: 'view.zoomIn', title: 'Zoom in (timeline)', category: 'View', icon: L.ZoomIn, keys: ['='], run: () => app.layout.timeline.zoomBy(1.5) });
    a({ id: 'view.zoomOut', title: 'Zoom out (timeline)', category: 'View', icon: L.ZoomOut, keys: ['-'], run: () => app.layout.timeline.zoomBy(1 / 1.5) });
    a({ id: 'view.fit', title: 'Show the whole sequence', category: 'View', keys: ['\\'], run: () => app.layout.timeline.fit() });
    a({ id: 'view.safeMargins', title: 'Safe margins', category: 'View', checked: () => app.settings.bool('playback.safeMargins'), run: () => app.settings.set('playback.safeMargins', !app.settings.bool('playback.safeMargins')) });
    for (const [v, label] of [['1', 'Full'], ['0.5', '1/2'], ['0.25', '1/4']] as const)
      a({ id: `view.res${v}`, title: `Playback resolution: ${label}`, category: 'View', checked: () => app.settings.str('playback.resolution') === v, run: () => app.settings.set('playback.resolution', v) });
    WORKSPACES.forEach(([w, label], i) => a({ id: `workspace.${w}`, title: `Workspace: ${label}`, category: 'View', keys: [`Alt+Shift+${i + 1}`], checked: () => app.prefs.workspace === w, run: () => app.layout.setWorkspace(w) }));
    for (const p of ['project', 'source', 'effectControls', 'lumetri', 'mixer', 'effects', 'markers', 'history'] as const) {
      const titles = { project: 'Project', source: 'Source monitor', effectControls: 'Effect Controls', lumetri: 'Lumetri Color', mixer: 'Audio Mixer', effects: 'Effects', markers: 'Markers', history: 'History' };
      a({ id: `panel.${p}`, title: `Show ${titles[p]}`, category: 'View', run: () => app.layout.show(p) });
    }
    a({ id: 'view.theme', title: 'Switch light / dark theme', category: 'View', icon: L.SunMoon, run: () => app.settings.set('appearance.theme', app.isDark ? 'light' : 'dark') });
    a({ id: 'view.fullscreen', title: 'Full screen', category: 'View', icon: L.Fullscreen, keys: ['F11'], run: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) });

    // ---------- Tools ----------
    for (const t of TOOLS) a({ id: `tool.${t.id}`, title: `${t.name} tool`, category: 'Tools', icon: t.icon, keys: [t.key], keywords: t.hint, checked: () => app.tool === t.id, run: () => app.setTool(t.id) });

    // ---------- Help ----------
    a({ id: 'help.palette', title: 'Search commands', category: 'Help', icon: L.Search, keys: ['Ctrl+Shift+P', 'F1'], global: true, run: () => openPalette(app) });
    a({ id: 'help.shortcuts', title: 'Keyboard shortcuts', category: 'Help', icon: L.Keyboard, keys: ['Ctrl+/'], run: () => showShortcuts(app) });
    a({ id: 'help.whatsNew', title: "What's new", category: 'Help', icon: L.Sparkles, run: () => app.updates.showWhatsNew() });
    a({ id: 'help.updates', title: 'Check for updates…', category: 'Help', icon: L.RefreshCw, run: () => app.updates.check(false) });
    a({ id: 'help.about', title: 'About Frameline', category: 'Help', icon: L.Info, run: () => showAbout(app) });
    a({ id: 'help.devtools', title: 'Developer tools', category: 'Help', keys: ['Ctrl+Alt+Shift+I'], hidden: true, run: () => platform.toggleDevTools() });
  }

  /** Where playing started (to go back there when it stops, if that setting is on). */
  private playStart = 0;
}
