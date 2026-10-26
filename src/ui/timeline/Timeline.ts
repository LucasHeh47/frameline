// The Timeline: tracks of clips drawn on a canvas, with the ruler, playhead, markers, transitions,
// thumbnails and waveforms. Dragging edits a copy of the sequence that's drawn live; letting go makes
// the real (undoable) edit. Track headers (lock, mute, solo…) sit on the left.
import * as L from 'lucide';
import { addKey, valueAt, type Anim } from '../../core/anim';
import {
  addMarker,
  addTrack,
  adjacent,
  applyTransition,
  closeGap,
  gapAt,
  moveClips,
  razor,
  removeTrack,
  slideClip,
  slipClip,
  stretchClip,
  transitionRange,
  trimClip,
  type TrimMode,
} from '../../core/edit';
import { EFFECTS_BY_ID, TRANSITIONS_BY_ID, makeEffect } from '../../core/effects';
import { PRESETS_BY_ID } from '../../core/presets';
import { allTracks, clipEnd, findClip, mediaOf, sequenceDuration, sourceTimeAt, type Clip, type Sequence, type Track } from '../../core/project';
import { shortDuration, timebase, timecode } from '../../core/time';
import { snapPoints, snapShift } from '../../core/timeline';
import type { App } from '../app';
import { h, icon } from '../dom';
import type { Panel } from '../layout';
import { promptDialog, showMenu, toast, tooltip, type MenuItem } from '../widgets';

const RULER = 28;
const DIVIDER = 8;

interface Row {
  track: Track;
  y: number;
  h: number;
}

type Hit =
  | { zone: 'ruler'; frame: number }
  | { zone: 'track'; row: Row; frame: number; clip?: Clip; edge?: 'head' | 'tail'; trans?: { clip: Clip; side: 'in' | 'out'; edge?: 'left' | 'right' }; level?: boolean }
  | { zone: 'none'; frame: number };

type Drag =
  | { kind: 'scrub' }
  | { kind: 'pan'; x: number; y: number; sf: number; sy: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; add: boolean }
  | { kind: 'move'; x0: number; y0: number; row: Row; ids: Set<string>; started: boolean; df: number; dv: number; da: number; copy: boolean; insert: boolean }
  | { kind: 'trim'; x0: number; clip: string; edge: 'head' | 'tail'; mode: TrimMode | 'stretch'; d: number; single: boolean }
  | { kind: 'slip' | 'slide'; x0: number; clip: string; d: number }
  | { kind: 'trans'; x0: number; clip: string; side: 'in' | 'out'; edge: 'left' | 'right'; start: number; d: number }
  | { kind: 'level'; y0: number; clip: string; row: Row; key: number | null; start: Anim; video: boolean };

const KIND_COLORS: Record<string, string> = {
  video: '#5476c9',
  image: '#8d68c7',
  title: '#c45495',
  color: '#7c828d',
  adjustment: '#b98a2a',
  audio: '#3a9468',
};

/** dB to a height on a clip's volume line (−60 dB at the bottom, +6 at the top). */
const dbToLevel = (db: number) => Math.max(0, Math.min(1, (db + 60) / 66));
const levelToDb = (l: number) => (l <= 0.001 ? -96 : l * 66 - 60);

export class Timeline implements Panel {
  readonly id = 'timeline';
  readonly title = 'Timeline';
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private heads: HTMLElement;
  private headsInner: HTMLElement;
  private bar: HTMLElement;
  private hThumb: HTMLElement;
  private vThumb: HTMLElement;
  /** Pixels per frame, and the first frame and pixel row in view. */
  private ppf = 2;
  private scrollFrame = 0;
  private scrollY = 0;
  private preview: Sequence | null = null;
  private drag: Drag | null = null;
  private snapAt: number | null = null;
  private ghost: { row: Row; start: number; len: number; label: string } | null = null;
  private hoverX: number | null = null;
  private queued = false;
  private fitted = false;
  private tc!: HTMLElement;
  private lastSeq = '';

  constructor(private app: App) {
    this.canvas = h('canvas', { class: 'tl-canvas', tabindex: '0' }) as HTMLCanvasElement;
    this.headsInner = h('div', { class: 'tl-heads-inner' });
    this.heads = h('div', { class: 'tl-heads' }, this.headsInner);
    this.bar = h('div', { class: 'tl-bar' });
    this.hThumb = h('div', { class: 'tl-hthumb' });
    this.vThumb = h('div', { class: 'tl-vthumb' });
    const hScroll = h('div', { class: 'tl-hscroll' }, this.hThumb);
    const vScroll = h('div', { class: 'tl-vscroll' }, this.vThumb);
    this.el = h(
      'div',
      { class: 'timeline' },
      this.bar,
      h('div', { class: 'tl-main' }, h('div', { class: 'tl-heads-col' }, h('div', { class: 'tl-heads-top' }), this.heads), h('div', { class: 'tl-canvas-wrap' }, this.canvas, vScroll), h('div', { class: 'tl-corner' }), hScroll),
    );
    new ResizeObserver(() => this.request()).observe(this.canvas);
    for (const k of ['project', 'selection', 'media', 'settings', 'tool'] as const) app.on(k, () => this.request());
    app.on('project', () => this.renderHeads());
    app.on('sequence', () => {
      this.fitted = false;
      this.renderBar();
      this.renderHeads();
      this.request();
    });
    app.on('playhead', () => this.onPlayhead());
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      if (this.app.tool === 'razor') this.request();
    });
    this.canvas.addEventListener('dblclick', (e) => this.onDouble(e));
    this.canvas.addEventListener('contextmenu', (e) => this.onContext(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('dragover', (e) => this.onDragOver(e));
    this.canvas.addEventListener('dragleave', () => {
      this.ghost = null;
      this.snapAt = null;
      this.request();
    });
    this.canvas.addEventListener('drop', (e) => void this.onDrop(e));
    this.scrollbar(hScroll, this.hThumb, 'x');
    this.scrollbar(vScroll, this.vThumb, 'y');
    this.renderBar();
    this.renderHeads();
  }

  focus(): void {
    this.canvas.focus({ preventScroll: true });
  }

  private get seq(): Sequence | null {
    return this.app.project ? (this.preview ?? this.app.seq) : null;
  }

  private get fps(): number {
    return this.app.project ? this.app.seq.fps : 30;
  }

  request(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.draw();
    });
  }

  // ---------- geometry ----------

  private get width(): number {
    return this.canvas.clientWidth;
  }

  private get height(): number {
    return this.canvas.clientHeight;
  }

  private x(f: number): number {
    return (f - this.scrollFrame) * this.ppf;
  }

  private frameAt(x: number): number {
    return this.scrollFrame + x / this.ppf;
  }

  private baseHeight(kind: 'video' | 'audio'): number {
    const size = this.app.settings.str('timeline.trackHeight');
    const v = size === 'small' ? 30 : size === 'large' ? 76 : 50;
    return kind === 'audio' ? Math.round(v * 0.92) : v;
  }

  private rows(s = this.seq): Row[] {
    if (!s) return [];
    const out: Row[] = [];
    let y = 0;
    for (const t of [...s.video].reverse()) {
      const hh = this.app.prefs.trackHeights[t.id] ?? this.baseHeight('video');
      out.push({ track: t, y, h: hh });
      y += hh;
    }
    y += DIVIDER;
    for (const t of s.audio) {
      const hh = this.app.prefs.trackHeights[t.id] ?? this.baseHeight('audio');
      out.push({ track: t, y, h: hh });
      y += hh;
    }
    return out;
  }

  private contentHeight(): number {
    const r = this.rows();
    const last = r[r.length - 1];
    return last ? last.y + last.h + 40 : 0;
  }

  /** The row at a canvas y (below the ruler). */
  private rowAt(y: number): Row | null {
    const cy = y - RULER + this.scrollY;
    return this.rows().find((r) => cy >= r.y && cy < r.y + r.h) ?? null;
  }

  private rowY(r: Row): number {
    return RULER + r.y - this.scrollY;
  }

  /** Total frames the scroll bar covers (the sequence plus room to grow). */
  private extent(): number {
    const s = this.seq;
    const dur = s ? sequenceDuration(s) : 0;
    return Math.max(dur + this.width / this.ppf * 0.5, this.fps * 30);
  }

  fit(): void {
    const s = this.seq;
    if (!s || !this.width) return;
    const dur = Math.max(this.fps * 10, sequenceDuration(s));
    this.ppf = Math.max(0.01, (this.width * 0.92) / dur);
    this.scrollFrame = 0;
    this.request();
  }

  /** Zooms around a frame (the playhead when not given). */
  zoomBy(k: number, at = this.app.player.frame): void {
    const xAt = this.x(at);
    this.ppf = Math.max(0.005, Math.min(40, this.ppf * k));
    this.scrollFrame = Math.max(0, at - xAt / this.ppf);
    this.request();
  }

  /** Keeps a frame in view (scrolls only if it's off screen). */
  reveal(f: number): void {
    const x = this.x(f);
    if (x < 0 || x > this.width - 20) this.scrollFrame = Math.max(0, f - (this.width * 0.3) / this.ppf);
    this.request();
  }

  private onPlayhead(): void {
    const f = this.app.player.frame;
    if (this.app.player.playing) {
      const mode = this.app.settings.str('timeline.follow');
      const x = this.x(f);
      if (mode === 'page' && x > this.width - 10) this.scrollFrame = f - 10 / this.ppf;
      else if (mode === 'smooth' && x > this.width * 0.5) this.scrollFrame = f - (this.width * 0.5) / this.ppf;
    }
    this.tc.textContent = timecode(Math.floor(f), this.fps);
    this.request();
  }

  // ---------- bar and headers ----------

  private renderBar(): void {
    const app = this.app;
    const p = app.project;
    this.tc = h('button', { class: 'tl-tc', onclick: () => app.layout.program.typeTimecode() });
    tooltip(this.tc, 'Playhead — click to type a time');
    if (p) this.tc.textContent = timecode(app.playhead, this.fps);
    const toggle = (on: boolean, ic: L.IconNode, label: string, cmd: string, keys?: string) => {
      const b = h('button', { class: `btn icon-only${on ? ' on' : ''}`, 'aria-label': label, 'aria-pressed': on ? 'true' : 'false', onclick: () => {
        app.commands.run(cmd);
        this.renderBar();
      } }, icon(ic, 16));
      tooltip(b, label, keys);
      return b;
    };
    const seqs = p?.sequences ?? [];
    const tabs = h(
      'div',
      { class: 'tl-seqs' },
      ...seqs.map((s) =>
        h('button', { class: `tl-seq${s.id === p?.active ? ' on' : ''}`, onclick: () => {
          if (!p || p.active === s.id) return;
          app.player.pause();
          p.active = s.id;
          app.selection.clear();
          app.player.frame = s.playhead ?? 0;
          app.emit('sequence', 'project', 'selection', 'playhead');
          app.player.refresh();
        } }, s.name),
      ),
    );
    const add = h('button', { class: 'btn icon-only', 'aria-label': 'Add track', onclick: (e: MouseEvent) => showMenu([
      { label: 'Add video track', icon: L.Film, run: () => app.edit('Add video track', (s) => void addTrack(s, 'video')) },
      { label: 'Add audio track', icon: L.AudioLines, run: () => app.edit('Add audio track', (s) => void addTrack(s, 'audio')) },
    ], e.currentTarget as HTMLElement) }, icon(L.Plus, 16));
    tooltip(add, 'Add a track');
    const view = h('button', { class: 'btn icon-only', 'aria-label': 'Timeline display', onclick: (e: MouseEvent) => this.viewMenu(e.currentTarget as HTMLElement) }, icon(L.Settings2, 15));
    tooltip(view, 'What the timeline shows');
    const zoomOut = h('button', { class: 'btn icon-only', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(1 / 1.5) }, icon(L.ZoomOut, 15));
    tooltip(zoomOut, 'Zoom out', '-');
    const zoomIn = h('button', { class: 'btn icon-only', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.5) }, icon(L.ZoomIn, 15));
    tooltip(zoomIn, 'Zoom in', '=');
    const fit = h('button', { class: 'btn small text', onclick: () => this.fit() }, 'Fit');
    tooltip(fit, 'Show the whole sequence', '\\');
    this.bar.replaceChildren(
      this.tc,
      tabs,
      h('div', { class: 'spacer' }),
      toggle(app.prefs.snap, L.Magnet, 'Snap', 'timeline.snap', 'S'),
      toggle(app.prefs.linked, L.Link, 'Linked selection: a clip and its sound select together', 'timeline.linked'),
      toggle(false, L.Bookmark, 'Add marker', 'marker.add', 'M'),
      add,
      view,
      h('span', { class: 'ctl-sep' }),
      zoomOut,
      fit,
      zoomIn,
    );
  }

  private viewMenu(at: HTMLElement): void {
    const s = this.app.settings;
    const thumbs = s.str('timeline.thumbnails');
    const set = (v: string) => () => s.set('timeline.thumbnails', v);
    showMenu(
      [
        { label: 'Thumbnails', submenu: () => [
          { label: 'Filmstrip', checked: thumbs === 'filmstrip', run: set('filmstrip') },
          { label: 'First frame', checked: thumbs === 'head', run: set('head') },
          { label: 'First and last frames', checked: thumbs === 'headtail', run: set('headtail') },
          { label: 'None', checked: thumbs === 'off', run: set('off') },
        ] },
        { label: 'Audio waveforms', checked: s.bool('timeline.waveforms'), run: () => s.set('timeline.waveforms', !s.bool('timeline.waveforms')) },
        { label: 'Volume and opacity lines', checked: s.bool('timeline.levels'), run: () => s.set('timeline.levels', !s.bool('timeline.levels')) },
        { label: 'Clip names', checked: s.bool('timeline.names'), run: () => s.set('timeline.names', !s.bool('timeline.names')) },
        { separator: true },
        { label: 'Track height', submenu: () => (['small', 'medium', 'large'] as const).map((v) => ({ label: v[0].toUpperCase() + v.slice(1), checked: s.str('timeline.trackHeight') === v, run: () => {
          this.app.prefs.trackHeights = {};
          s.set('timeline.trackHeight', v);
        } })) },
      ],
      at,
    );
  }

  private renderHeads(): void {
    const s = this.app.project ? this.app.seq : null;
    if (!s) {
      this.headsInner.replaceChildren();
      return;
    }
    if (this.lastSeq !== s.id) {
      this.lastSeq = s.id;
      this.fitted = false;
    }
    const app = this.app;
    const els: HTMLElement[] = [];
    const rows = this.rows(app.seq);
    const setTrack = (t: Track, label: string, fn: (t: Track) => void) => app.edit(label, (seq) => {
      const x = allTracks(seq).find((y) => y.id === t.id);
      if (!x) return false;
      fn(x);
    });
    let lastKind = 'video';
    for (const r of rows) {
      const t = r.track;
      if (t.kind !== lastKind) {
        els.push(h('div', { class: 'tl-divider', style: { height: `${DIVIDER}px` } }));
        lastKind = t.kind;
      }
      const btn = (on: boolean, content: L.IconNode | string, label: string, fn: () => void, cls = '') => {
        const b = h('button', { class: `tl-hbtn${on ? ' on' : ''} ${cls}`, 'aria-label': label, 'aria-pressed': on ? 'true' : 'false', onclick: fn }, typeof content === 'string' ? content : icon(content, 14));
        tooltip(b, label);
        return b;
      };
      const name = h('span', { class: 'tl-hname', title: 'Double-click to rename' }, t.name);
      name.addEventListener('dblclick', async () => {
        const n = await promptDialog('Rename track', 'Name', t.name);
        if (n?.trim()) setTrack(t, 'Rename track', (x) => (x.name = n.trim()));
      });
      const controls =
        t.kind === 'video'
          ? [
              btn(!t.muted, t.muted ? L.EyeOff : L.Eye, t.muted ? 'Show this track' : 'Hide this track', () => setTrack(t, t.muted ? 'Show track' : 'Hide track', (x) => (x.muted = !x.muted))),
              btn(t.locked, t.locked ? L.Lock : L.LockOpen, t.locked ? 'Unlock the track' : 'Lock the track (no edits)', () => setTrack(t, 'Lock track', (x) => (x.locked = !x.locked))),
              btn(t.syncLock, L.Link2, 'Sync lock: inserting and rippling move this track too', () => setTrack(t, 'Sync lock', (x) => (x.syncLock = !x.syncLock)), 'faint'),
            ]
          : [
              btn(t.muted, 'M', t.muted ? 'Unmute' : 'Mute the track', () => setTrack(t, 'Mute track', (x) => (x.muted = !x.muted)), 'mute'),
              btn(t.solo, 'S', t.solo ? 'Stop soloing' : 'Solo: hear only this track', () => setTrack(t, 'Solo track', (x) => (x.solo = !x.solo)), 'solo'),
              btn(t.locked, t.locked ? L.Lock : L.LockOpen, t.locked ? 'Unlock the track' : 'Lock the track (no edits)', () => setTrack(t, 'Lock track', (x) => (x.locked = !x.locked))),
              btn(t.syncLock, L.Link2, 'Sync lock: inserting and rippling move this track too', () => setTrack(t, 'Sync lock', (x) => (x.syncLock = !x.syncLock)), 'faint'),
              btn(app.voiceover.track === t.id, L.Mic, app.voiceover.track === t.id ? 'Stop recording' : 'Record a voice-over onto this track from the playhead (use headphones)', () => void app.voiceover.toggle(t.id), `rec${app.voiceover.recording && app.voiceover.track !== t.id ? ' faint' : ''}`),
            ];
      const grip = h('div', { class: 'tl-hgrip' });
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        const y0 = e.clientY;
        const h0 = r.h;
        const move = (ev: PointerEvent) => {
          app.prefs.trackHeights[t.id] = Math.max(24, Math.min(200, h0 + ev.clientY - y0));
          this.renderHeads();
          this.request();
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          app.savePrefs();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
      });
      const el = h('div', { class: `tl-head ${t.kind}${t.locked ? ' locked' : ''}`, style: { height: `${r.h}px` } }, name, h('div', { class: 'tl-hctl' }, ...controls), grip);
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const list = t.kind === 'video' ? s.video : s.audio;
        const i = list.indexOf(t);
        showMenu(
          [
            { label: `Add ${t.kind} track above`, icon: L.Plus, run: () => app.edit('Add track', (seq) => void addTrack(seq, t.kind, t.kind === 'video' ? i + 1 : i)) },
            { label: `Add ${t.kind} track below`, icon: L.Plus, run: () => app.edit('Add track', (seq) => void addTrack(seq, t.kind, t.kind === 'video' ? i : i + 1)) },
            { label: 'Rename…', run: () => name.dispatchEvent(new MouseEvent('dblclick')) },
            ...(t.kind === 'audio' ? [{ label: app.voiceover.track === t.id ? 'Stop recording' : 'Record voice-over here', icon: L.Mic, run: () => void app.voiceover.toggle(t.id) }] : []),
            { separator: true },
            { label: 'Delete track', icon: L.Trash2, disabled: list.length <= 1, run: () => {
              if (t.clips.length) toast(`${t.name} still has clips; they were deleted with it. Undo brings them back.`);
              app.edit('Delete track', (seq) => removeTrack(seq, t.id));
            } },
          ],
          { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY },
        );
      });
      els.push(el);
    }
    this.headsInner.replaceChildren(...els);
    this.headsInner.style.transform = `translateY(${-this.scrollY}px)`;
  }

  // ---------- drawing ----------

  private draw(): void {
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const W = this.width;
    const H = this.height;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const s = this.seq;
    if (s && !this.fitted) {
      this.fitted = true;
      this.fit();
      return;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(this.el);
    const col = (n: string) => css.getPropertyValue(n).trim();
    ctx.fillStyle = col('--bg');
    ctx.fillRect(0, 0, W, H);
    if (!s || !this.app.project) return;
    // Keep the vertical scroll in range
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, this.contentHeight() - (H - RULER))));
    this.headsInner.style.transform = `translateY(${-this.scrollY}px)`;
    const rows = this.rows();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER, W, H - RULER);
    ctx.clip();
    rows.forEach((r, i) => {
      const y = this.rowY(r);
      if (y > H || y + r.h < RULER) return;
      ctx.fillStyle = i % 2 ? col('--panel') : col('--panel-2');
      ctx.fillRect(0, y, W, r.h);
      if (r.track.locked) {
        ctx.fillStyle = 'rgba(128,128,128,0.08)';
        for (let x = -r.h; x < W; x += 12) {
          ctx.beginPath();
          ctx.moveTo(x, y + r.h);
          ctx.lineTo(x + r.h, y);
          ctx.lineTo(x + r.h + 4, y);
          ctx.lineTo(x + 4, y + r.h);
          ctx.fill();
        }
      }
      ctx.fillStyle = col('--border');
      ctx.fillRect(0, y + r.h - 1, W, 1);
    });
    // The divider between pictures and sound
    const firstAudio = rows.find((r) => r.track.kind === 'audio');
    if (firstAudio) {
      ctx.fillStyle = col('--chrome');
      ctx.fillRect(0, this.rowY(firstAudio) - DIVIDER, W, DIVIDER);
    }
    // In / out range
    if (s.inPoint !== null || s.outPoint !== null) {
      const a = this.x(s.inPoint ?? 0);
      const b = this.x(s.outPoint ?? sequenceDuration(s));
      ctx.fillStyle = col('--accent-soft');
      ctx.globalAlpha = 0.35;
      ctx.fillRect(a, RULER, b - a, H - RULER);
      ctx.globalAlpha = 1;
    }
    const f0 = this.frameAt(0);
    const f1 = this.frameAt(W);
    for (const r of rows) {
      const y = this.rowY(r);
      if (y > H || y + r.h < RULER) continue;
      for (const clip of r.track.clips) {
        if (clipEnd(clip) < f0 || clip.start > f1) continue;
        this.drawClip(ctx, clip, r, y, col);
      }
      for (const clip of r.track.clips) {
        for (const side of ['in', 'out'] as const) {
          const range = transitionRange(r.track, clip, side);
          if (range) this.drawTransition(ctx, clip, side, range, y, r.h, col);
        }
      }
    }
    if (this.ghost) {
      const g = this.ghost;
      const y = this.rowY(g.row);
      ctx.fillStyle = col('--accent-soft');
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(this.x(g.start), y + 2, g.len * this.ppf, g.row.h - 4);
      ctx.strokeRect(this.x(g.start) + 0.5, y + 2.5, g.len * this.ppf - 1, g.row.h - 5);
      ctx.setLineDash([]);
      ctx.fillStyle = col('--text');
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.fillText(g.label, this.x(g.start) + 6, y + 15);
    }
    if (this.drag?.kind === 'marquee') {
      const d = this.drag;
      ctx.fillStyle = col('--accent-soft');
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 1;
      const x = Math.min(d.x0, d.x1);
      const y = Math.min(d.y0, d.y1);
      ctx.fillRect(x, y, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    // The razor's cut line
    if (this.app.tool === 'razor' && this.hoverX !== null && !this.drag) {
      ctx.fillStyle = col('--text');
      ctx.fillRect(Math.round(this.x(this.snapFrame(Math.round(this.frameAt(this.hoverX))))), RULER, 1, H - RULER);
    }
    ctx.restore();
    this.drawRuler(ctx, s, W, col);
    if (this.snapAt !== null) {
      ctx.fillStyle = '#ffd43b';
      ctx.fillRect(Math.round(this.x(this.snapAt)) - 0.5, 0, 1.5, H);
    }
    // Playhead
    const px = Math.round(this.x(this.app.player.frame)) + 0.5;
    if (px >= -10 && px <= W + 10) {
      ctx.strokeStyle = col('--accent');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, RULER - 6);
      ctx.lineTo(px, H);
      ctx.stroke();
      ctx.fillStyle = col('--accent');
      ctx.beginPath();
      ctx.moveTo(px - 6, RULER - 14);
      ctx.lineTo(px + 6, RULER - 14);
      ctx.lineTo(px + 6, RULER - 7);
      ctx.lineTo(px, RULER - 1);
      ctx.lineTo(px - 6, RULER - 7);
      ctx.closePath();
      ctx.fill();
    }
    this.updateScrollbars();
  }

  private drawRuler(ctx: CanvasRenderingContext2D, s: Sequence, W: number, col: (n: string) => string): void {
    ctx.fillStyle = col('--chrome');
    ctx.fillRect(0, 0, W, RULER);
    ctx.fillStyle = col('--border');
    ctx.fillRect(0, RULER - 1, W, 1);
    const fps = s.fps;
    const tb = timebase(fps);
    // Label spacing of at least ~90 px, on a round number of frames or seconds
    const steps = [1, 2, 5, 10, tb / 2, tb, tb * 2, tb * 5, tb * 10, tb * 15, tb * 30, tb * 60, tb * 120, tb * 300, tb * 600, tb * 1800, tb * 3600];
    const major = steps.find((st) => st * this.ppf >= 90) ?? steps[steps.length - 1];
    const minor = major / (major >= tb ? (major === tb * 15 || major === tb * 30 ? 3 : 5) : major >= 10 ? 5 : major);
    ctx.font = '10.5px "Segoe UI", sans-serif';
    ctx.textBaseline = 'top';
    const start = Math.floor(this.frameAt(0) / minor) * minor;
    for (let f = start; this.x(f) < W; f += minor) {
      if (f < 0) continue;
      const x = Math.round(this.x(f)) + 0.5;
      const isMajor = Math.abs(f / major - Math.round(f / major)) < 1e-6;
      ctx.fillStyle = isMajor ? col('--text-muted') : col('--text-faint');
      ctx.fillRect(x - 0.5, isMajor ? RULER - 12 : RULER - 6, 1, isMajor ? 11 : 5);
      if (isMajor) ctx.fillText(timecode(Math.round(f), fps), x + 3, 3);
    }
    if (s.inPoint !== null || s.outPoint !== null) {
      const a = this.x(s.inPoint ?? 0);
      const b = this.x(s.outPoint ?? sequenceDuration(s));
      ctx.fillStyle = col('--accent');
      ctx.globalAlpha = 0.5;
      ctx.fillRect(a, RULER - 4, b - a, 3);
      ctx.globalAlpha = 1;
    }
    for (const m of s.markers) {
      const x = this.x(m.f);
      if (x < -10 || x > W + 10) continue;
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.moveTo(x - 5, RULER - 16);
      ctx.lineTo(x + 5, RULER - 16);
      ctx.lineTo(x + 5, RULER - 9);
      ctx.lineTo(x, RULER - 5);
      ctx.lineTo(x - 5, RULER - 9);
      ctx.closePath();
      ctx.fill();
      if (m.name && this.ppf * 30 > 40) {
        ctx.fillStyle = col('--text-muted');
        ctx.fillText(m.name, x + 7, RULER - 17);
      }
    }
  }

  private drawClip(ctx: CanvasRenderingContext2D, c: Clip, r: Row, y: number, col: (n: string) => string): void {
    const app = this.app;
    const m = mediaOf(app.project!, c);
    const x0 = this.x(c.start);
    const x1 = this.x(clipEnd(c));
    const W = this.width;
    const cx0 = Math.max(x0, -4);
    const cx1 = Math.min(x1, W + 4);
    const top = y + 1;
    const hh = r.h - 3;
    const w = Math.max(1, x1 - x0);
    const missing = !!m && app.library.missing.has(m.id);
    const selected = app.selection.has(c.id) && !this.preview;
    const base = missing ? '#b23a3a' : KIND_COLORS[c.kind] ?? KIND_COLORS.video;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x0 + 0.5, top, Math.max(1, w - 1), hh, Math.min(4, w / 2));
    ctx.clip();
    ctx.globalAlpha = c.enabled ? 1 : 0.4;
    ctx.fillStyle = base;
    ctx.fillRect(cx0, top, cx1 - cx0, hh);
    const nameH = this.app.settings.bool('timeline.names') && hh >= 26 ? 15 : 0;
    const bodyTop = top + nameH;
    const bodyH = hh - nameH;
    // Pictures
    if (m && (c.kind === 'video' || c.kind === 'image') && bodyH > 12 && !missing) this.drawThumbs(ctx, c, m, x0, x1, bodyTop, bodyH);
    if (c.kind === 'title' && c.title && bodyH > 10) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `600 ${Math.min(14, bodyH * 0.45)}px "Segoe UI", sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillText(c.title.text.split('\n')[0].slice(0, 60), Math.max(x0, 0) + 6, bodyTop + bodyH / 2);
    }
    if (c.kind === 'color' && bodyH > 6) {
      ctx.fillStyle = c.color ?? '#000';
      ctx.fillRect(cx0, bodyTop + 3, cx1 - cx0, bodyH - 6);
    }
    // Sound
    if (m && c.kind === 'audio' && this.app.settings.bool('timeline.waveforms') && bodyH > 8 && !missing) this.drawWave(ctx, c, m, x0, x1, bodyTop, bodyH);
    // Volume / opacity line
    if (this.app.settings.bool('timeline.levels') && bodyH >= 20 && (c.kind === 'audio' ? c.volume : c.opacity)) this.drawLevel(ctx, c, x0, x1, bodyTop, bodyH);
    // Name strip
    if (nameH) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(cx0, top, cx1 - cx0, nameH);
      ctx.fillStyle = '#fff';
      ctx.font = '600 11px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      const badges: string[] = [];
      if (c.effects.length) badges.push('fx');
      if (c.speed !== 1 || c.reverse) badges.push(`${c.reverse ? '−' : ''}${Math.round(c.speed * 100)}%`);
      if (c.hold !== undefined) badges.push('hold');
      if (missing) badges.push('MEDIA OFFLINE');
      const label = `${badges.length ? `[${badges.join(' · ')}] ` : ''}${c.name}`;
      ctx.fillText(label, Math.max(x0, 0) + 5, top + nameH / 2 + 0.5, Math.max(10, x1 - Math.max(x0, 0) - 8));
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    // Outline
    ctx.strokeStyle = selected ? col('--accent') : 'rgba(0,0,0,0.35)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(x0 + (selected ? 1 : 0.5), top + (selected ? 0.5 : 0), Math.max(1, w - (selected ? 2 : 1)), hh, Math.min(4, w / 2));
    ctx.stroke();
  }

  private drawThumbs(ctx: CanvasRenderingContext2D, c: Clip, m: NonNullable<ReturnType<typeof mediaOf>>, x0: number, x1: number, top: number, hh: number): void {
    const mode = this.app.settings.str('timeline.thumbnails');
    if (mode === 'off') return;
    const aspect = m.width && m.height ? m.width / m.height : 16 / 9;
    const tw = Math.max(8, hh * aspect);
    const fps = this.fps;
    const lib = this.app.library;
    const tile = (x: number, f: number) => {
      const t = c.kind === 'image' ? 0 : sourceTimeAt(c, f, fps);
      const th = lib.thumbAt(m, t);
      if (!th) return;
      ctx.drawImage(th.sheet, th.sx, th.sy, th.sw, th.sh, x, top, tw, hh);
    };
    if (mode === 'filmstrip' && c.kind === 'video') {
      const startX = Math.max(x0, Math.floor((0 - x0) / tw) * tw + x0);
      let n = 0;
      for (let x = startX; x < Math.min(x1, this.width) && n < 300; x += tw, n++) tile(x, this.frameAt(x + tw / 2));
    } else {
      tile(x0, c.start);
      if (mode === 'headtail' && x1 - x0 > tw * 2) tile(x1 - tw, clipEnd(c) - 1);
    }
  }

  private drawWave(ctx: CanvasRenderingContext2D, c: Clip, m: NonNullable<ReturnType<typeof mediaOf>>, x0: number, x1: number, top: number, hh: number): void {
    const peaks = this.app.library.peaksOf(m);
    if (!peaks) return;
    const fps = this.fps;
    const mid = top + hh / 2;
    const half = hh / 2 - 1;
    ctx.fillStyle = 'rgba(190, 255, 220, 0.75)';
    const a = Math.max(0, Math.floor(x0));
    const b = Math.min(this.width, Math.ceil(x1));
    for (let x = a; x < b; x++) {
      const t0 = sourceTimeAt(c, this.frameAt(x), fps);
      const t1 = sourceTimeAt(c, this.frameAt(x + 1), fps);
      let i0 = Math.floor(Math.min(t0, t1) * peaks.rate);
      const i1 = Math.max(i0 + 1, Math.ceil(Math.max(t0, t1) * peaks.rate));
      let p = 0;
      for (i0 = Math.max(0, i0); i0 < Math.min(i1, peaks.data.length); i0++) if (peaks.data[i0] > p) p = peaks.data[i0];
      const gain = Math.pow(10, valueAt(c.volume, this.frameAt(x) - c.start, 0) / 20);
      const v = Math.min(1, (p / 255) * gain) * half;
      if (v >= 0.5) ctx.fillRect(x, mid - v, 1, v * 2);
    }
  }

  private drawLevel(ctx: CanvasRenderingContext2D, c: Clip, x0: number, x1: number, top: number, hh: number): void {
    const audio = c.kind === 'audio';
    const a = audio ? c.volume! : c.opacity!;
    const level = (local: number) => (audio ? dbToLevel(valueAt(a, local, 0)) : valueAt(a, local, 100) / 100);
    const y = (l: number) => top + 3 + (1 - l) * (hh - 6);
    ctx.strokeStyle = audio ? 'rgba(255,240,120,0.95)' : 'rgba(255,240,120,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = 3;
    for (let x = Math.max(0, x0); x <= Math.min(this.width, x1); x += step) ctx.lineTo(x, y(level(this.frameAt(x) - c.start)));
    ctx.stroke();
    ctx.fillStyle = '#ffd43b';
    for (const k of a.keys ?? []) {
      const kx = this.x(c.start + k.f);
      if (kx < x0 - 2 || kx > x1 + 2) continue;
      const ky = y(audio ? dbToLevel(k.v) : k.v / 100);
      ctx.beginPath();
      ctx.moveTo(kx, ky - 4);
      ctx.lineTo(kx + 4, ky);
      ctx.lineTo(kx, ky + 4);
      ctx.lineTo(kx - 4, ky);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawTransition(ctx: CanvasRenderingContext2D, clip: Clip, side: 'in' | 'out', range: [number, number], y: number, hh: number, col: (n: string) => string): void {
    const tr = side === 'in' ? clip.transIn! : clip.transOut!;
    const a = this.x(range[0]);
    const b = this.x(range[1]);
    if (b < 0 || a > this.width) return;
    const sel = this.app.transitionSel?.clipId === clip.id && this.app.transitionSel.side === side;
    const ty = y + 3;
    const th = Math.max(10, Math.min(22, hh - 8));
    const grad = ctx.createLinearGradient(a, 0, b, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0.18)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(a, ty, Math.max(4, b - a), th, 3);
    ctx.fill();
    ctx.strokeStyle = sel ? col('--accent') : 'rgba(0,0,0,0.5)';
    ctx.lineWidth = sel ? 2 : 1;
    ctx.stroke();
    if (b - a > 40) {
      ctx.fillStyle = '#111';
      ctx.font = '600 10px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(TRANSITIONS_BY_ID.get(tr.type)?.name ?? tr.type, a + 4, ty + th / 2, b - a - 8);
    }
  }

  private updateScrollbars(): void {
    const ext = this.extent();
    const W = this.width;
    const visible = W / this.ppf;
    const hw = Math.max(24, (visible / ext) * W);
    this.hThumb.style.width = `${Math.min(W, hw)}px`;
    this.hThumb.style.transform = `translateX(${(this.scrollFrame / ext) * W}px)`;
    const total = this.contentHeight();
    const vh = this.height - RULER;
    const vis = total > vh;
    this.vThumb.parentElement!.hidden = !vis;
    if (vis) {
      this.vThumb.style.height = `${Math.max(20, (vh / total) * vh)}px`;
      this.vThumb.style.transform = `translateY(${RULER + (this.scrollY / total) * vh}px)`;
    }
  }

  private scrollbar(track: HTMLElement, thumb: HTMLElement, axis: 'x' | 'y'): void {
    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      thumb.setPointerCapture(e.pointerId);
      const start = axis === 'x' ? e.clientX : e.clientY;
      const s0 = axis === 'x' ? this.scrollFrame : this.scrollY;
      const move = (ev: PointerEvent) => {
        const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
        if (axis === 'x') this.scrollFrame = Math.max(0, s0 + (d / this.width) * this.extent());
        else this.scrollY = Math.max(0, s0 + (d / (this.height - RULER)) * this.contentHeight());
        this.request();
      };
      const up = () => {
        thumb.removeEventListener('pointermove', move);
        thumb.removeEventListener('pointerup', up);
      };
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', up);
    });
    track.addEventListener('pointerdown', (e) => {
      if (e.target !== track) return;
      const r = track.getBoundingClientRect();
      if (axis === 'x') this.scrollFrame = Math.max(0, ((e.clientX - r.left) / r.width) * this.extent() - this.width / this.ppf / 2);
      else this.scrollY = Math.max(0, ((e.clientY - r.top - RULER) / (r.height - RULER)) * this.contentHeight() - (this.height - RULER) / 2);
      this.request();
    });
  }

  // ---------- hit testing ----------

  private hit(x: number, y: number): Hit {
    const frame = this.frameAt(x);
    if (y < RULER) return { zone: 'ruler', frame };
    const row = this.rowAt(y);
    if (!row) return { zone: 'none', frame };
    const ry = this.rowY(row);
    // Transitions sit on top of the clips
    for (const clip of row.track.clips) {
      for (const side of ['in', 'out'] as const) {
        const range = transitionRange(row.track, clip, side);
        if (!range) continue;
        const a = this.x(range[0]);
        const b = this.x(range[1]);
        const th = Math.max(10, Math.min(22, row.h - 8));
        if (x >= a - 3 && x <= b + 3 && y >= ry + 2 && y <= ry + 4 + th) {
          const edge = Math.abs(x - a) < 5 ? 'left' : Math.abs(x - b) < 5 ? 'right' : undefined;
          return { zone: 'track', row, frame, clip, trans: { clip, side, edge } };
        }
      }
    }
    const clip = row.track.clips.find((c) => frame >= c.start && frame < clipEnd(c));
    // Edges are easier to grab than the clip's own pixels near them
    const near = (f: number) => Math.abs(this.x(f) - x);
    let edge: 'head' | 'tail' | undefined;
    let target = clip;
    for (const c of row.track.clips) {
      const w = (clipEnd(c) - c.start) * this.ppf;
      const grab = Math.min(7, Math.max(2, w / 4));
      if (near(c.start) <= grab && (!edge || near(c.start) < near(edge === 'head' ? target!.start : clipEnd(target!)))) {
        edge = 'head';
        target = c;
      }
      if (near(clipEnd(c)) <= grab && (!edge || near(clipEnd(c)) < near(edge === 'head' ? target!.start : clipEnd(target!)))) {
        edge = 'tail';
        target = c;
      }
    }
    if (!target) return { zone: 'track', row, frame };
    // The volume / opacity line
    let level = false;
    if (!edge && this.app.settings.bool('timeline.levels') && target === clip) {
      const nameH = this.app.settings.bool('timeline.names') && row.h - 3 >= 26 ? 15 : 0;
      const top = ry + 1 + nameH;
      const hh = row.h - 3 - nameH;
      if (hh >= 20) {
        const audio = target.kind === 'audio';
        const a = audio ? target.volume : target.opacity;
        if (a) {
          const l = audio ? dbToLevel(valueAt(a, frame - target.start, 0)) : valueAt(a, frame - target.start, 100) / 100;
          level = Math.abs(top + 3 + (1 - l) * (hh - 6) - y) < 4;
        }
      }
    }
    return { zone: 'track', row, frame, clip: target, edge, level };
  }

  /** Snaps a frame to edges, the playhead and markers when snapping is on. */
  private snapFrame(f: number, skip = new Set<string>()): number {
    if (!this.app.prefs.snap || !this.app.project) return f;
    const within = this.app.settings.num('timeline.snapDistance') / this.ppf;
    const s = snapShift(snapPoints(this.app.seq, skip, this.app.playhead), [f], within);
    this.snapAt = s ? s.at : null;
    return s ? f + s.shift : f;
  }

  private local(e: PointerEvent | MouseEvent | DragEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ---------- mouse ----------

  private cursorFor(hit: Hit): string {
    const t = this.app.tool;
    if (t === 'hand') return 'grab';
    if (t === 'zoom') return 'zoom-in';
    if (t === 'razor' && hit.zone === 'track') return 'crosshair';
    if (hit.zone !== 'track') return 'default';
    if (hit.trans?.edge) return 'ew-resize';
    if (hit.level) return 'ns-resize';
    if (hit.edge) return t === 'roll' ? 'col-resize' : t === 'stretch' ? 'ew-resize' : 'ew-resize';
    if (hit.clip && (t === 'slip' || t === 'slide')) return 'ew-resize';
    return 'default';
  }

  private onDown(e: PointerEvent): void {
    const app = this.app;
    if (!app.project) return;
    this.focus();
    const [x, y] = this.local(e);
    const hit = this.hit(x, y);
    const s = app.seq;
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || app.tool === 'hand') {
      this.drag = { kind: 'pan', x, y, sf: this.scrollFrame, sy: this.scrollY };
      return;
    }
    if (e.button !== 0) return;
    if (hit.zone === 'ruler') {
      app.player.pause();
      this.drag = { kind: 'scrub' };
      app.setPlayhead(Math.round(this.snapFrame(Math.round(hit.frame))));
      return;
    }
    if (app.tool === 'zoom') {
      this.zoomBy(e.altKey ? 1 / 2 : 2, hit.frame);
      return;
    }
    if (hit.zone !== 'track') return;
    const { row, clip } = hit;
    if (hit.trans) {
      app.selectTransition(hit.trans.clip.id, hit.trans.side);
      if (hit.trans.edge) {
        const tr = hit.trans.side === 'in' ? hit.trans.clip.transIn! : hit.trans.clip.transOut!;
        this.drag = { kind: 'trans', x0: x, clip: hit.trans.clip.id, side: hit.trans.side, edge: hit.trans.edge, start: tr.duration, d: 0 };
      }
      return;
    }
    if (app.tool === 'razor') {
      if (!clip || row.track.locked) return;
      const f = Math.round(this.snapFrame(Math.round(hit.frame)));
      this.snapAt = null;
      app.edit('Razor', (seq) => razor(seq, f, e.shiftKey ? undefined : new Set([clip.id])) > 0);
      return;
    }
    if (app.tool === 'trackSelect') {
      const f = hit.frame;
      const ids = (e.shiftKey ? [row.track] : allTracks(s)).flatMap((t) => t.clips.filter((c) => clipEnd(c) > f && c.start >= f - 1).map((c) => c.id));
      app.select(ids);
      if (ids.length) this.drag = { kind: 'move', x0: x, y0: y, row, ids: new Set(app.selection), started: false, df: 0, dv: 0, da: 0, copy: false, insert: false };
      return;
    }
    if (!clip) {
      // Empty space: a rubber band to select clips
      if (!e.shiftKey && !e.ctrlKey) app.clearSelection();
      this.drag = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y, add: e.shiftKey || e.ctrlKey };
      return;
    }
    if (row.track.locked) {
      toast(`${row.track.name} is locked. Unlock it to edit its clips.`);
      return;
    }
    if (hit.level && app.tool === 'select') {
      const audio = clip.kind === 'audio';
      const a = audio ? clip.volume! : clip.opacity!;
      const local = Math.round(hit.frame - clip.start);
      let key: number | null = null;
      if (e.ctrlKey) key = local;
      else {
        const k = a.keys?.find((kk) => Math.abs(this.x(clip.start + kk.f) - x) < 5);
        if (k) key = k.f;
      }
      this.drag = { kind: 'level', y0: y, clip: clip.id, row, key, start: structuredClone(a), video: !audio };
      if (!app.selection.has(clip.id)) app.select([clip.id], 'replace', e.altKey);
      return;
    }
    if (hit.edge && ['select', 'ripple', 'roll', 'stretch'].includes(app.tool)) {
      const mode: TrimMode | 'stretch' = app.tool === 'ripple' || (app.tool === 'select' && e.ctrlKey) ? 'ripple' : app.tool === 'roll' ? 'roll' : app.tool === 'stretch' ? 'stretch' : 'normal';
      if (!app.selection.has(clip.id)) app.select([clip.id], 'replace', e.altKey);
      this.drag = { kind: 'trim', x0: x, clip: clip.id, edge: hit.edge, mode, d: 0, single: e.altKey };
      return;
    }
    if (app.tool === 'slip' || app.tool === 'slide') {
      app.select([clip.id]);
      this.drag = { kind: app.tool, x0: x, clip: clip.id, d: 0 };
      return;
    }
    // Selection tool on a clip: select it, then maybe drag it
    if (e.ctrlKey) app.select([clip.id], 'toggle', e.altKey);
    else if (e.shiftKey) app.select([clip.id], 'add', e.altKey);
    else if (!app.selection.has(clip.id) || e.altKey) app.select([clip.id], 'replace', e.altKey);
    if (app.selection.has(clip.id)) this.drag = { kind: 'move', x0: x, y0: y, row, ids: new Set(app.selection), started: false, df: 0, dv: 0, da: 0, copy: false, insert: false };
  }

  private onMove(e: PointerEvent): void {
    const app = this.app;
    if (!app.project) return;
    const [x, y] = this.local(e);
    this.hoverX = x;
    const d = this.drag;
    if (!d) {
      this.canvas.style.cursor = this.cursorFor(this.hit(x, y));
      if (app.tool === 'razor') this.request();
      return;
    }
    const s = app.seq;
    const media = (id: string) => app.mediaById(id);
    switch (d.kind) {
      case 'pan':
        this.scrollFrame = Math.max(0, d.sf - (x - d.x) / this.ppf);
        this.scrollY = Math.max(0, d.sy - (y - d.y));
        this.request();
        break;
      case 'scrub': {
        const f = Math.max(0, Math.round(this.snapFrame(Math.round(this.frameAt(x)))));
        app.setPlayhead(f);
        break;
      }
      case 'marquee': {
        d.x1 = x;
        d.y1 = y;
        const fa = this.frameAt(Math.min(d.x0, x));
        const fb = this.frameAt(Math.max(d.x0, x));
        const ya = Math.min(d.y0, y);
        const yb = Math.max(d.y0, y);
        const ids = this.rows()
          .filter((r) => this.rowY(r) + r.h > ya && this.rowY(r) < yb)
          .flatMap((r) => r.track.clips.filter((c) => clipEnd(c) > fa && c.start < fb).map((c) => c.id));
        app.select(ids, d.add ? 'add' : 'replace');
        this.request();
        break;
      }
      case 'move': {
        if (!d.started && Math.hypot(x - d.x0, y - d.y0) < 4) return;
        d.started = true;
        d.copy = e.altKey;
        d.insert = (app.settings.str('timeline.dropMode') === 'insert') !== e.ctrlKey;
        let df = Math.round((x - d.x0) / this.ppf);
        // Snap the moving group's edges
        const group = allTracks(s).flatMap((t) => t.clips.filter((c) => d.ids.has(c.id)));
        const first = Math.min(...group.map((c) => c.start));
        const last = Math.max(...group.map(clipEnd));
        this.snapAt = null;
        if (app.prefs.snap) {
          const within = app.settings.num('timeline.snapDistance') / this.ppf;
          const sn = snapShift(snapPoints(s, d.ids, app.playhead), [first + df, last + df], within);
          if (sn) {
            df += sn.shift;
            this.snapAt = sn.at;
          }
        }
        df = Math.max(-first, df);
        // Tracks: up and down within pictures or within sound
        const over = this.rowAt(y);
        let dv = 0;
        let da = 0;
        if (over && over.track.kind === d.row.track.kind) {
          // Rows come from the preview copy while dragging, so tracks are matched by id
          const list = d.row.track.kind === 'video' ? s.video : s.audio;
          const delta = list.findIndex((t) => t.id === over.track.id) - list.findIndex((t) => t.id === d.row.track.id);
          if (d.row.track.kind === 'video') dv = delta;
          else da = delta;
        }
        d.df = df;
        d.dv = dv;
        d.da = da;
        const p = structuredClone(s);
        moveClips(p, d.ids, df, dv, da, { insert: d.insert, copy: d.copy });
        this.preview = p;
        app.statusbar.hint(`${df >= 0 ? '+' : '−'}${timecode(Math.abs(df), s.fps)}${d.copy ? ' · copy' : ''}${d.insert ? ' · insert' : ''}`);
        this.request();
        break;
      }
      case 'trim': {
        const found = findClip(s, d.clip);
        if (!found) return;
        let delta = Math.round((x - d.x0) / this.ppf);
        const edgeF = d.edge === 'head' ? found.clip.start : clipEnd(found.clip);
        const snapped = this.snapFrame(edgeF + delta, new Set([d.clip]));
        delta = Math.round(snapped - edgeF);
        const p = structuredClone(s);
        d.d = d.mode === 'stretch' ? stretchClip(p, d.clip, d.edge, delta) : trimClip(p, d.clip, d.edge, delta, d.mode, media, !d.single);
        this.preview = p;
        const after = findClip(p, d.clip)?.clip;
        app.statusbar.hint(`${d.mode === 'stretch' ? 'Speed' : 'Trim'} ${d.d >= 0 ? '+' : '−'}${timecode(Math.abs(d.d), s.fps)}${after ? ` · length ${shortDuration(after.duration, s.fps)}` : ''}${after && d.mode === 'stretch' ? ` · ${Math.round(after.speed * 100)}%` : ''}`);
        this.request();
        break;
      }
      case 'slip':
      case 'slide': {
        const delta = Math.round((x - d.x0) / this.ppf);
        const p = structuredClone(s);
        d.d = d.kind === 'slip' ? slipClip(p, d.clip, -delta, media) : slideClip(p, d.clip, delta, media);
        this.preview = p;
        const c = findClip(p, d.clip)?.clip;
        if (c && d.kind === 'slip') app.statusbar.hint(`Slip ${timecode(Math.abs(d.d), s.fps)} · starts at ${c.in.toFixed(2)}s of the media`);
        this.request();
        break;
      }
      case 'trans': {
        const delta = Math.round((x - d.x0) / this.ppf) * (d.edge === 'left' ? -1 : 1);
        const found = findClip(s, d.clip);
        const tr = found && (d.side === 'in' ? found.clip.transIn : found.clip.transOut);
        if (!found || !tr) return;
        const k = tr.align === 'center' ? 2 : 1;
        d.d = Math.max(1, Math.min(found.clip.duration * k, d.start + delta * k));
        const p = structuredClone(s);
        const pc = findClip(p, d.clip)!.clip;
        (d.side === 'in' ? pc.transIn! : pc.transOut!).duration = d.d;
        this.preview = p;
        app.statusbar.hint(`Transition ${shortDuration(d.d, s.fps)}`);
        this.request();
        break;
      }
      case 'level': {
        const found = findClip(s, d.clip);
        if (!found) return;
        const nameH = app.settings.bool('timeline.names') && d.row.h - 3 >= 26 ? 15 : 0;
        const hh = d.row.h - 3 - nameH - 6;
        const dl = -(y - d.y0) / Math.max(1, hh);
        const p = structuredClone(s);
        const c = findClip(p, d.clip)!.clip;
        const a = structuredClone(d.start);
        const conv = (v: number) => (d.video ? v / 100 : dbToLevel(v));
        const back = (l: number) => (d.video ? Math.round(Math.max(0, Math.min(1, l)) * 1000) / 10 : Math.round(levelToDb(Math.max(0, Math.min(1, l))) * 10) / 10);
        if (d.key !== null) {
          if (!a.keys?.some((k) => k.f === d.key)) addKey(a, d.key);
          const k = a.keys!.find((kk) => kk.f === d.key)!;
          k.v = back(conv(k.v) + dl);
        } else if (a.keys?.length) for (const k of a.keys) k.v = back(conv(k.v) + dl);
        else a.v = back(conv(a.v) + dl);
        if (d.video) c.opacity = a;
        else c.volume = a;
        this.preview = p;
        const shown = d.key !== null ? a.keys!.find((k) => k.f === d.key)!.v : a.keys?.length ? a.keys[0].v : a.v;
        app.statusbar.hint(d.video ? `Opacity ${shown}%` : `Volume ${shown <= -96 ? '−∞' : shown.toFixed(1)} dB`);
        this.request();
        break;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.canvas.releasePointerCapture(e.pointerId);
    this.snapAt = null;
    const app = this.app;
    const preview = this.preview;
    this.preview = null;
    app.statusbar.hint(null);
    if (!d || !app.project) return;
    const media = (id: string) => app.mediaById(id);
    switch (d.kind) {
      case 'move':
        if (d.started && (d.df || d.dv || d.da || d.copy)) {
          let moved: string[] = [];
          app.edit(d.copy ? 'Copy clips' : 'Move clips', (s) => {
            moved = moveClips(s, d.ids, d.df, d.dv, d.da, { insert: d.insert, copy: d.copy }).clips.map((c) => c.id);
          });
          if (d.copy && moved.length) app.select(moved);
        }
        break;
      case 'trim':
        if (d.d) app.edit(d.mode === 'stretch' ? 'Rate stretch' : d.mode === 'ripple' ? 'Ripple trim' : d.mode === 'roll' ? 'Rolling edit' : 'Trim', (s) => (d.mode === 'stretch' ? stretchClip(s, d.clip, d.edge, d.d) !== 0 : trimClip(s, d.clip, d.edge, d.d, d.mode, media, !d.single) !== 0));
        break;
      case 'slip':
        if (d.d) app.edit('Slip', (s) => slipClip(s, d.clip, d.d, media) !== 0);
        break;
      case 'slide':
        if (d.d) app.edit('Slide', (s) => slideClip(s, d.clip, d.d, media) !== 0);
        break;
      case 'trans':
        if (d.d && d.d !== d.start)
          app.edit('Transition length', (s) => {
            const f = findClip(s, d.clip);
            const tr = f && (d.side === 'in' ? f.clip.transIn : f.clip.transOut);
            if (!tr) return false;
            tr.duration = d.d;
          });
        break;
      case 'level':
        if (preview) {
          const c = findClip(preview, d.clip)?.clip;
          if (c) app.edit(d.video ? 'Opacity' : 'Volume', (s) => {
            const x = findClip(s, d.clip)?.clip;
            if (!x) return false;
            if (d.video) x.opacity = c.opacity;
            else x.volume = c.volume;
          });
        }
        break;
    }
    this.request();
  }

  private onDouble(e: MouseEvent): void {
    const [x, y] = this.local(e);
    const hit = this.hit(x, y);
    if (hit.zone !== 'track' || !hit.clip) return;
    const c = hit.clip;
    if (c.kind === 'title') {
      this.app.setPlayhead(Math.max(this.app.playhead, c.start));
      if (this.app.playhead >= clipEnd(c)) this.app.setPlayhead(c.start);
      this.app.layout.program.editTitle(c);
    } else if (c.mediaId) this.app.layout.source.open(c.mediaId, c.in);
    else this.app.layout.show('effectControls');
  }

  private onWheel(e: WheelEvent): void {
    if (!this.app.project) return;
    e.preventDefault();
    const [x] = this.local(e);
    if (e.ctrlKey || e.altKey) this.zoomBy(e.deltaY < 0 ? 1.25 : 0.8, this.frameAt(x));
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.scrollFrame = Math.max(0, this.scrollFrame + ((e.shiftKey ? e.deltaY : e.deltaX) / this.ppf) * 0.8);
    else this.scrollY = Math.max(0, this.scrollY + e.deltaY * 0.6);
    this.request();
  }

  // ---------- menus ----------

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const app = this.app;
    if (!app.project) return;
    const [x, y] = this.local(e);
    const hit = this.hit(x, y);
    const at = { left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY };
    const run = (id: string) => () => app.commands.run(id);
    if (hit.zone === 'ruler') {
      const f = Math.round(hit.frame);
      showMenu(
        [
          { label: 'Add marker here', icon: L.Bookmark, run: () => app.edit('Add marker', (s) => void addMarker(s, f)) },
          { label: 'Mark in here', run: () => app.edit('Mark in', (s) => void (s.inPoint = f)) },
          { label: 'Mark out here', run: () => app.edit('Mark out', (s) => void (s.outPoint = f)) },
          { label: 'Clear in and out', disabled: app.seq.inPoint === null && app.seq.outPoint === null, run: run('mark.clear') },
        ],
        at,
      );
      return;
    }
    if (hit.zone !== 'track') return;
    if (hit.trans) {
      const { clip, side } = hit.trans;
      app.selectTransition(clip.id, side);
      showMenu(
        [
          { label: 'Transition settings', icon: L.Settings2, run: () => app.layout.show('effectControls') },
          { label: 'Delete transition', icon: L.Trash2, run: run('edit.clear') },
        ],
        at,
      );
      return;
    }
    if (!hit.clip) {
      const gap = gapAt(hit.row.track, Math.floor(hit.frame));
      showMenu(
        [
          { label: 'Close this gap', icon: L.FoldHorizontal, disabled: !gap, run: () => app.edit('Close gap', (s) => closeGap(s, allTracks(s).find((t) => t.id === hit.row.track.id)!, Math.floor(hit.frame))) },
          { separator: true },
          { label: 'Paste', disabled: !app.clipboard, run: run('edit.paste') },
          { label: 'Select all', run: run('edit.selectAll') },
        ],
        at,
      );
      return;
    }
    const c = hit.clip;
    if (!app.selection.has(c.id)) app.select([c.id]);
    const items: MenuItem[] = [
      { label: 'Cut', hint: 'Ctrl+X', run: run('edit.cut') },
      { label: 'Copy', hint: 'Ctrl+C', run: run('edit.copy') },
      { label: 'Paste attributes…', hint: 'Ctrl+Alt+V', disabled: !app.clipboard, run: run('edit.pasteAttributes') },
      { separator: true },
      { label: 'Delete', hint: 'Delete', icon: L.Trash2, run: run('edit.clear') },
      { label: 'Ripple delete', hint: 'Shift+Delete', run: run('edit.rippleDelete') },
      { separator: true },
      { label: c.enabled ? 'Disable' : 'Enable', hint: 'Shift+E', run: run('clip.enable') },
      { label: c.linkId ? 'Unlink' : 'Link', hint: 'Ctrl+L', run: run('clip.link') },
      { label: 'Speed / Duration…', hint: 'Ctrl+R', icon: L.Gauge, run: run('clip.speed') },
      { label: 'Add frame hold', icon: L.Snowflake, disabled: c.kind !== 'video', run: run('clip.frameHold') },
      { separator: true },
      { label: 'Scene edit detection…', icon: L.ScanLine, disabled: c.kind !== 'video', run: run('clip.scenes') },
      { label: 'Normalize audio', icon: L.AudioLines, disabled: c.kind !== 'audio', run: run('clip.normalize') },
      { label: 'Auto-duck under other sound…', disabled: c.kind !== 'audio', run: run('clip.duck') },
      { label: 'Rename…', run: run('clip.rename') },
      { label: 'Label color', submenu: () => ['#5476c9', '#3a9468', '#c45495', '#b98a2a', '#8d68c7', '#e5383b', ''].map((col) => ({ label: col ? col : 'Default', run: () => app.edit('Label color', () => {
        for (const { clip } of app.selectedClips()) {
          if (col) clip.label = col;
          else delete clip.label;
        }
      }) })) },
      { separator: true },
      { label: 'Reveal in Project', disabled: !c.mediaId, run: () => app.layout.project.reveal(c.mediaId!) },
      { label: 'Open in Source monitor', disabled: !c.mediaId, run: () => app.layout.source.open(c.mediaId!, c.in) },
    ];
    showMenu(items, at);
  }

  // ---------- dropping media and effects ----------

  private dropTarget(e: DragEvent): { row: Row; frame: number } | null {
    const [x, y] = this.local(e);
    let row = this.rowAt(y);
    if (!row && y >= RULER) {
      // Below the last track: the last audio track, above the first: the top video track
      const rows = this.rows();
      row = y > RULER + (rows[rows.length - 1]?.y ?? 0) - this.scrollY ? rows[rows.length - 1] : rows[0];
    }
    if (!row) return null;
    return { row, frame: Math.max(0, Math.round(this.frameAt(x))) };
  }

  private onDragOver(e: DragEvent): void {
    const dt = e.dataTransfer;
    if (!dt || !this.app.project) return;
    const types = [...dt.types];
    const isMedia = types.includes('application/x-frameline-media');
    const isFx = types.includes('application/x-frameline-effect');
    if (!isMedia && !isFx && !types.includes('Files')) return;
    e.preventDefault();
    dt.dropEffect = 'copy';
    const t = this.dropTarget(e);
    if (!t) return;
    if (isMedia) {
      const info = window.__framelineDrag;
      const len = info ? Math.max(1, info.frames) : this.fps * 5;
      const start = Math.max(0, Math.round(this.snapFrame(t.frame)));
      this.ghost = { row: t.row, start, len, label: info?.label ?? '' };
    } else this.ghost = null;
    this.request();
  }

  private async onDrop(e: DragEvent): Promise<void> {
    const dt = e.dataTransfer;
    const app = this.app;
    if (!dt || !app.project) return;
    e.preventDefault();
    const t = this.dropTarget(e);
    const ghost = this.ghost;
    this.ghost = null;
    this.snapAt = null;
    this.request();
    if (!t) return;
    const insert = (app.settings.str('timeline.dropMode') === 'insert') !== e.ctrlKey;
    const mode = insert ? 'insert' : 'overwrite';
    const fx = dt.getData('application/x-frameline-effect');
    if (fx) {
      this.dropEffect(JSON.parse(fx) as { kind: 'effect' | 'transition' | 'preset'; id: string }, t.row, this.frameAt(this.local(e)[0]));
      return;
    }
    const raw = dt.getData('application/x-frameline-media');
    if (raw) {
      const d = JSON.parse(raw) as { ids: string[]; parts?: 'both' | 'video' | 'audio'; in?: number; out?: number };
      const items = d.ids.map((id) => app.mediaById(id)).filter((m): m is NonNullable<typeof m> => !!m);
      await app.placeMedia(items, ghost?.start ?? t.frame, t.row.track, mode, d.parts ?? 'both', d.in !== undefined && d.out !== undefined ? { in: d.in, out: d.out } : undefined);
      return;
    }
    if (dt.files.length) {
      const items = await app.dropFiles([...dt.files]);
      if (items.length) await app.placeMedia(items, t.frame, t.row.track, mode);
    }
  }

  private dropEffect(d: { kind: 'effect' | 'transition' | 'preset'; id: string }, row: Row, frame: number): void {
    const app = this.app;
    const clip = row.track.clips.find((c) => frame >= c.start && frame < clipEnd(c));
    if (!clip) {
      toast('Drop it on a clip.');
      return;
    }
    if (d.kind === 'transition') {
      const def = TRANSITIONS_BY_ID.get(d.id);
      if (!def) return;
      if ((def.kind === 'audio') !== (row.track.kind === 'audio')) {
        toast(def.kind === 'audio' ? 'Audio transitions go on audio clips.' : 'Video transitions go on video clips.');
        return;
      }
      const side = frame - clip.start < clip.duration / 2 ? 'in' : 'out';
      const frames = Math.max(1, Math.round(app.settings.num(def.kind === 'audio' ? 'timeline.audioTransitionSeconds' : 'timeline.transitionSeconds') * this.fps));
      // At the end of a clip that touches the next one, the transition belongs to the next one
      const { next } = adjacent(row.track, clip);
      const owner = side === 'out' && next ? next : clip;
      if (app.edit(`Add ${def.name}`, (s) => applyTransition(s, clip.id, side, def.id, frames))) app.selectTransition(owner.id, owner === clip ? side : 'in');
      return;
    }
    if (d.kind === 'preset') {
      const p = PRESETS_BY_ID.get(d.id);
      if (!p) return;
      if ((p.kind === 'audio') !== (clip.kind === 'audio')) {
        toast(p.kind === 'audio' ? 'That preset is for sound: drop it on an audio clip.' : 'That preset is for pictures: drop it on a video clip.');
        return;
      }
      app.edit(p.name, (s) => {
        const c = findClip(s, clip.id)?.clip;
        if (!c) return false;
        p.apply(c, s);
      });
      app.select([clip.id], 'replace', true);
      app.layout.show('effectControls');
      return;
    }
    const def = EFFECTS_BY_ID.get(d.id);
    if (!def) return;
    if ((def.kind === 'audio') !== (clip.kind === 'audio')) {
      toast(def.kind === 'audio' ? 'Audio effects go on audio clips.' : 'Video effects go on video clips, titles and adjustment layers.');
      return;
    }
    app.edit(`Add ${def.name}`, (s) => {
      const c = findClip(s, clip.id)?.clip;
      if (!c) return false;
      c.effects.push(makeEffect(def.id));
    });
    app.select([clip.id], 'replace', true);
    app.layout.show(def.id === 'lumetri' ? 'lumetri' : 'effectControls');
  }

}

declare global {
  interface Window {
    /** What's being dragged from the Project panel (dragover can't read the data itself). */
    __framelineDrag?: { frames: number; label: string };
  }
}
