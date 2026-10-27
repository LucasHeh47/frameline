// The Program monitor: the sequence as it plays, drawn by the compositor. The selected clip can be
// moved, sized and turned right in the picture, and titles edited by double-clicking them.
import * as L from 'lucide';
import { setValue } from '../../core/anim';
import { mediaOf, sequenceDuration, type Clip, type Sequence } from '../../core/project';
import { parseTimecode, timecode } from '../../core/time';
import { videoAt } from '../../core/timeline';
import { Compositor, fromFrame, placement, toFrame, type Placement } from '../../render/compositor';
import { titleBounds } from '../../render/text';
import type { App } from '../app';
import { h, icon } from '../dom';
import type { Panel } from '../layout';
import { platform } from '../platform';
import { showMenu, tooltip } from '../widgets';

type Drag = { kind: 'move' | 'scale' | 'rotate'; x: number; y: number; start: Placement; live: ReturnType<App['liveEdit']>; clip: string; local: number; dist0: number; angle0: number };

const ZOOMS: [string, string][] = [
  ['fit', 'Fit'],
  ['0.25', '25%'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.5', '150%'],
  ['2', '200%'],
];

export class ProgramMonitor implements Panel {
  readonly id = 'program';
  readonly title = 'Program';
  readonly el: HTMLElement;
  private view: HTMLElement;
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private compositor: Compositor | null = null;
  private tcNow: HTMLElement;
  private tcDur: HTMLElement;
  private playBtn: HTMLButtonElement;
  private scrub: HTMLCanvasElement;
  private zoom = 'fit';
  private queued = false;
  /** Where the picture is drawn in the view (CSS pixels) and its scale from sequence pixels. */
  private box = { x: 0, y: 0, w: 0, h: 0, k: 1 };
  private drag: Drag | null = null;
  private editor: HTMLTextAreaElement | null = null;
  private loopBtn!: HTMLButtonElement;

  constructor(private app: App) {
    this.canvas = h('canvas', { class: 'mon-canvas' }) as HTMLCanvasElement;
    this.overlay = h('canvas', { class: 'mon-overlay' }) as HTMLCanvasElement;
    this.view = h('div', { class: 'mon-view', tabindex: '-1' }, this.canvas, this.overlay);
    this.tcNow = h('button', { class: 'mon-tc now', onclick: () => this.typeTimecode() });
    tooltip(this.tcNow, 'Playhead position — click to type a time');
    this.tcDur = h('span', { class: 'mon-tc dur' });
    const zoomSel = h('select', { class: 'input mon-select', 'aria-label': 'Zoom' }, ...ZOOMS.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    zoomSel.addEventListener('change', () => {
      this.zoom = zoomSel.value;
      this.layoutCanvas();
      this.request();
    });
    const resSel = h('select', { class: 'input mon-select', 'aria-label': 'Playback resolution' }, h('option', { value: '1' }, 'Full'), h('option', { value: '0.5' }, '1/2'), h('option', { value: '0.25' }, '1/4')) as HTMLSelectElement;
    resSel.value = app.settings.str('playback.resolution');
    resSel.addEventListener('change', () => app.settings.set('playback.resolution', resSel.value));
    tooltip(resSel, 'Playback resolution: lower is smoother on slow computers');
    this.scrub = h('canvas', { class: 'mon-scrub' }) as HTMLCanvasElement;
    const btn = (ic: L.IconNode, label: string, cmd: string, keys?: string) => {
      const b = h('button', { class: 'btn icon-only', 'aria-label': label, onclick: () => app.commands.run(cmd) }, icon(ic, 16)) as HTMLButtonElement;
      tooltip(b, label, keys);
      return b;
    };
    this.playBtn = btn(L.Play, 'Play / Stop', 'play.toggle', 'Space');
    this.playBtn.classList.add('play');
    this.loopBtn = btn(L.Repeat, 'Loop playback', 'play.loop');
    const more = h('button', { class: 'btn icon-only', 'aria-label': 'Monitor settings', onclick: (e: MouseEvent) => this.settingsMenu(e.currentTarget as HTMLElement) }, icon(L.Settings2, 15));
    tooltip(more, 'Monitor settings');
    this.el = h(
      'div',
      { class: 'monitor program' },
      this.view,
      this.scrub,
      h('div', { class: 'mon-info' }, this.tcNow, h('div', { class: 'spacer' }), zoomSel, resSel, more, h('div', { class: 'spacer' }), this.tcDur),
      h(
        'div',
        { class: 'mon-transport' },
        btn(L.Bookmark, 'Add marker', 'marker.add', 'M'),
        btn(L.ArrowRightToLine, 'Mark in', 'mark.in', 'I'),
        btn(L.ArrowLeftToLine, 'Mark out', 'mark.out', 'O'),
        h('span', { class: 'mon-gap' }),
        btn(L.SkipBack, 'Go to in point', 'go.in', 'Shift+I'),
        btn(L.StepBack, 'Back one frame', 'play.back1', 'Left'),
        this.playBtn,
        btn(L.StepForward, 'Forward one frame', 'play.fwd1', 'Right'),
        btn(L.SkipForward, 'Go to out point', 'go.out', 'Shift+O'),
        h('span', { class: 'mon-gap' }),
        btn(L.ArrowUpFromLine, 'Lift (remove in to out, leaving a gap)', 'edit.lift', ';'),
        btn(L.ArrowUpToLine, 'Extract (remove in to out and close the gap)', 'edit.extract', "'"),
        btn(L.Camera, 'Export frame', 'file.exportFrame', 'Ctrl+Shift+E'),
        this.loopBtn,
      ),
    );
    new ResizeObserver(() => {
      this.layoutCanvas();
      this.request();
    }).observe(this.view);
    for (const k of ['project', 'playhead', 'sequence', 'media', 'selection', 'settings'] as const) app.on(k, () => this.request());
    app.on('tool', () => this.drawOverlay());
    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('dblclick', (e) => this.onDouble(e));
    this.overlay.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.settingsMenu({ left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY });
    });
    this.scrub.addEventListener('pointerdown', (e) => this.scrubDown(e));
  }

  /** The sequence size the canvas was laid out for. */
  private boxFor = '';

  private get seq(): Sequence | null {
    return this.app.project ? this.app.seq : null;
  }

  /** Redraws on the next frame (several changes at once draw once). */
  request(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  private ensureCompositor(): Compositor | null {
    if (this.compositor && !this.compositor.gl.isLost) return this.compositor;
    try {
      this.compositor?.dispose();
    } catch {
      // a lost context can't be cleaned up
    }
    try {
      this.compositor = new Compositor(this.canvas, (p) => platform.readText(p));
      this.compositor.onReady = () => this.request();
    } catch (err) {
      this.app.error(err);
      this.compositor = null;
    }
    return this.compositor;
  }

  private layoutCanvas(): void {
    const s = this.seq;
    if (!s) return;
    const vw = this.view.clientWidth;
    const vh = this.view.clientHeight;
    if (!vw || !vh) return;
    const fit = Math.min((vw - 16) / s.width, (vh - 16) / s.height);
    const k = this.zoom === 'fit' ? Math.max(0.01, fit) : Number(this.zoom);
    const w = s.width * k;
    const hh = s.height * k;
    this.box = { x: (vw - w) / 2, y: (vh - hh) / 2, w, h: hh, k };
    this.boxFor = `${s.width}x${s.height}`;
    Object.assign(this.canvas.style, { left: `${this.box.x}px`, top: `${this.box.y}px`, width: `${w}px`, height: `${hh}px` });
    const dpr = devicePixelRatio || 1;
    this.overlay.width = Math.round(vw * dpr);
    this.overlay.height = Math.round(vh * dpr);
    this.overlay.style.width = `${vw}px`;
    this.overlay.style.height = `${vh}px`;
  }

  render(): void {
    const s = this.seq;
    const app = this.app;
    if (!s || !app.project) return;
    // Again when the sequence changed shape (another sequence, new settings, a reframed copy)
    if (!this.box.w || this.boxFor !== `${s.width}x${s.height}`) this.layoutCanvas();
    const f = Math.floor(app.player.frame);
    const c = this.ensureCompositor();
    const bg = app.settings.str('playback.background');
    this.view.style.background = bg === 'black' ? '#000' : bg === 'mid' ? '#3a3d44' : '';
    if (c) {
      // No more pixels than are on screen (and no more than the playback resolution)
      const res = Number(app.settings.str('playback.resolution')) || 1;
      const scale = Math.max(0.05, Math.min(res, (this.box.w * (devicePixelRatio || 1)) / s.width));
      try {
        c.render({ project: app.project, seq: s, frame: f, scale, provider: app.player });
      } catch (err) {
        console.error(err);
      }
    }
    this.tcNow.textContent = timecode(f, s.fps);
    const dur = s.inPoint !== null && s.outPoint !== null ? s.outPoint - s.inPoint : sequenceDuration(s);
    this.tcDur.textContent = timecode(dur, s.fps);
    tooltip(this.tcDur, s.inPoint !== null && s.outPoint !== null ? 'Length from in to out' : 'Length of the sequence');
    this.playBtn.replaceChildren(icon(app.player.playing ? L.Square : L.Play, 16));
    this.loopBtn.classList.toggle('on', app.player.loop);
    this.drawScrub();
    this.drawOverlay();
  }

  // ---------- the scrub bar ----------

  private drawScrub(): void {
    const s = this.seq!;
    const c = this.scrub;
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(hh * dpr)) c.height = Math.round(hh * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const dur = Math.max(1, sequenceDuration(s));
    const x = (f: number) => 8 + ((w - 16) * f) / dur;
    const css = getComputedStyle(this.el);
    ctx.fillStyle = css.getPropertyValue('--border');
    ctx.fillRect(8, hh / 2 - 1, w - 16, 2);
    if (s.inPoint !== null || s.outPoint !== null) {
      ctx.fillStyle = css.getPropertyValue('--accent-soft');
      ctx.fillRect(x(s.inPoint ?? 0), 2, x(s.outPoint ?? dur) - x(s.inPoint ?? 0), hh - 4);
    }
    for (const m of s.markers) {
      ctx.fillStyle = m.color;
      ctx.fillRect(x(m.f) - 1, 2, 2, 5);
    }
    const px = x(Math.min(dur, this.app.player.frame));
    ctx.fillStyle = css.getPropertyValue('--accent');
    ctx.beginPath();
    ctx.moveTo(px - 5, 1);
    ctx.lineTo(px + 5, 1);
    ctx.lineTo(px, 8);
    ctx.fill();
    ctx.fillRect(px - 0.5, 1, 1, hh - 2);
  }

  private scrubDown(e: PointerEvent): void {
    const s = this.seq;
    if (!s) return;
    const dur = Math.max(1, sequenceDuration(s));
    const at = (ev: PointerEvent) => {
      const r = this.scrub.getBoundingClientRect();
      return Math.round(((ev.clientX - r.left - 8) / Math.max(1, r.width - 16)) * dur);
    };
    this.app.player.pause();
    this.app.setPlayhead(at(e));
    this.scrub.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => this.app.setPlayhead(at(ev));
    const up = () => {
      this.scrub.removeEventListener('pointermove', move);
      this.scrub.removeEventListener('pointerup', up);
    };
    this.scrub.addEventListener('pointermove', move);
    this.scrub.addEventListener('pointerup', up);
  }

  /** Lets the user type a time to go to. */
  typeTimecode(): void {
    const s = this.seq;
    if (!s) return;
    const input = h('input', { class: 'input mon-tc-input', value: timecode(this.app.playhead, s.fps) }) as HTMLInputElement;
    this.tcNow.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (ok) {
        const f = parseTimecode(input.value, s.fps, this.app.playhead);
        if (f !== null) this.app.setPlayhead(f);
      }
      input.replaceWith(this.tcNow);
      this.request();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
  }

  private settingsMenu(at: HTMLElement | { left: number; top: number; right: number; bottom: number }): void {
    const s = this.app.settings;
    showMenu(
      [
        { label: 'Safe margins', checked: s.bool('playback.safeMargins'), run: () => s.set('playback.safeMargins', !s.bool('playback.safeMargins')) },
        { label: 'Move and size clips in the monitor', checked: s.bool('playback.handles'), run: () => s.set('playback.handles', !s.bool('playback.handles')) },
        { label: 'Loop playback', checked: this.app.player.loop, run: () => this.app.commands.run('play.loop') },
        { separator: true },
        { label: 'Export frame…', icon: L.Camera, hint: 'Ctrl+Shift+E', run: () => this.app.commands.run('file.exportFrame') },
      ],
      at,
    );
  }

  // ---------- the selected clip in the picture ----------

  /** The clip whose handles show: selected, on a video track, under the playhead. */
  private target(): { clip: Clip; local: number; p: Placement; box: { x: number; y: number; w: number; h: number } } | null {
    const app = this.app;
    const s = this.seq;
    if (!s || !app.settings.bool('playback.handles') || app.player.playing) return null;
    const f = app.playhead;
    const layers = videoAt(s, f, (c) => mediaOf(app.project!, c));
    for (let i = layers.length - 1; i >= 0; i--) {
      for (const cf of [layers[i].b, layers[i].a]) {
        if (cf && app.selection.has(cf.clip.id) && cf.clip.kind !== 'adjustment') return this.geometry(cf.clip, cf.local);
      }
    }
    return null;
  }

  private geometry(clip: Clip, local: number): { clip: Clip; local: number; p: Placement; box: { x: number; y: number; w: number; h: number } } {
    const s = this.seq!;
    const m = mediaOf(this.app.project!, clip);
    const sw = clip.kind === 'video' || clip.kind === 'image' ? m?.width || s.width : s.width;
    const sh = clip.kind === 'video' || clip.kind === 'image' ? m?.height || s.height : s.height;
    const p = placement(clip, local, sw, sh, s);
    // Titles get a box around their text, not the whole frame
    let box = { x: -p.fw / 2, y: -p.fh / 2, w: p.fw, h: p.fh };
    if (clip.kind === 'title' && clip.title) {
      const b = titleBounds(clip.title, s.width, s.height);
      box = { x: b.x - s.width / 2 - 8, y: b.y - s.height / 2 - 6, w: b.w + 16, h: b.h + 12 };
    }
    return { clip, local, p, box };
  }

  /** Sequence pixels → view pixels. */
  private toView(X: number, Y: number): [number, number] {
    return [this.box.x + X * this.box.k, this.box.y + Y * this.box.k];
  }

  private toSeq(vx: number, vy: number): [number, number] {
    return [(vx - this.box.x) / this.box.k, (vy - this.box.y) / this.box.k];
  }

  private corners(t: NonNullable<ReturnType<ProgramMonitor['target']>>): [number, number][] {
    const { p, box } = t;
    const pts: [number, number][] = [
      [box.x, box.y],
      [box.x + box.w / 2, box.y],
      [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h / 2],
      [box.x + box.w, box.y + box.h],
      [box.x + box.w / 2, box.y + box.h],
      [box.x, box.y + box.h],
      [box.x, box.y + box.h / 2],
    ];
    return pts.map(([qx, qy]) => this.toView(...toFrame(p, qx, qy)));
  }

  private drawOverlay(): void {
    const c = this.overlay;
    const ctx = c.getContext('2d')!;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const s = this.seq;
    if (!s) return;
    const css = getComputedStyle(this.el);
    if (this.app.settings.bool('playback.safeMargins')) {
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      for (const k of [0.9, 0.8]) {
        const w = this.box.w * k;
        const hh = this.box.h * k;
        ctx.strokeRect(Math.round(this.box.x + (this.box.w - w) / 2) + 0.5, Math.round(this.box.y + (this.box.h - hh) / 2) + 0.5, Math.round(w), Math.round(hh));
      }
    }
    const t = this.target();
    this.overlay.style.cursor = this.app.tool === 'text' ? 'text' : 'default';
    if (!t) return;
    const pts = this.corners(t);
    const accent = css.getPropertyValue('--accent').trim() || '#ff5c6c';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const i of [0, 2, 4, 6]) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const [x, y] of pts) {
      ctx.fillRect(x - 4, y - 4, 8, 8);
      ctx.strokeRect(x - 4, y - 4, 8, 8);
    }
    // Rotation handle above the top edge
    const [rx, ry] = this.rotHandle(t);
    ctx.beginPath();
    ctx.moveTo(pts[1][0], pts[1][1]);
    ctx.lineTo(rx, ry);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rx, ry, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Anchor point
    const [ax, ay] = this.toView(t.p.x, t.p.y);
    ctx.beginPath();
    ctx.arc(ax, ay, 5, 0, Math.PI * 2);
    ctx.moveTo(ax - 8, ay);
    ctx.lineTo(ax + 8, ay);
    ctx.moveTo(ax, ay - 8);
    ctx.lineTo(ax, ay + 8);
    ctx.stroke();
  }

  private rotHandle(t: NonNullable<ReturnType<ProgramMonitor['target']>>): [number, number] {
    const { p, box } = t;
    const top = toFrame(p, box.x + box.w / 2, box.y);
    const center = toFrame(p, box.x + box.w / 2, box.y + box.h / 2);
    const dx = top[0] - center[0];
    const dy = top[1] - center[1];
    const len = Math.hypot(dx, dy) || 1;
    const [vx, vy] = this.toView(...top);
    return [vx + (dx / len) * 26, vy + (dy / len) * 26];
  }

  private pointer(e: PointerEvent | MouseEvent): [number, number] {
    const r = this.overlay.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** The topmost clip under a point of the picture. */
  private clipAt(vx: number, vy: number): Clip | null {
    const s = this.seq!;
    const [X, Y] = this.toSeq(vx, vy);
    const layers = videoAt(s, this.app.playhead, (c) => mediaOf(this.app.project!, c));
    for (let i = layers.length - 1; i >= 0; i--) {
      for (const cf of [layers[i].b, layers[i].a]) {
        if (!cf || cf.clip.kind === 'adjustment') continue;
        const g = this.geometry(cf.clip, cf.local);
        const [qx, qy] = fromFrame(g.p, X, Y);
        if (qx >= g.box.x && qx <= g.box.x + g.box.w && qy >= g.box.y && qy <= g.box.y + g.box.h) return cf.clip;
      }
    }
    return null;
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.app.project) return;
    const [vx, vy] = this.pointer(e);
    if (this.app.tool === 'text') {
      const [X, Y] = this.toSeq(vx, vy);
      this.addTitleAt(X, Y);
      return;
    }
    let t = this.target();
    let kind: Drag['kind'] | null = null;
    if (t) {
      const [rx, ry] = this.rotHandle(t);
      const pts = this.corners(t);
      if (Math.hypot(vx - rx, vy - ry) < 9) kind = 'rotate';
      else if (pts.some(([x, y]) => Math.abs(vx - x) < 7 && Math.abs(vy - y) < 7)) kind = 'scale';
      else if (this.clipAt(vx, vy) === t.clip) kind = 'move';
    }
    if (!kind) {
      // Clicking a clip in the picture selects it
      const c = this.clipAt(vx, vy);
      if (!c) return;
      this.app.select([c.id], 'replace', e.altKey);
      t = this.target();
      if (!t) return;
      kind = 'move';
    }
    if (!t) return;
    const [ax, ay] = this.toView(t.p.x, t.p.y);
    this.overlay.setPointerCapture(e.pointerId);
    this.drag = { kind, x: vx, y: vy, start: { ...t.p }, live: this.app.liveEdit(kind === 'move' ? 'Move clip' : kind === 'scale' ? 'Scale clip' : 'Rotate clip'), clip: t.clip.id, local: t.local, dist0: Math.hypot(vx - ax, vy - ay) || 1, angle0: Math.atan2(vy - ay, vx - ax) };
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    const [vx, vy] = this.pointer(e);
    if (!d) {
      const t = this.target();
      let cursor = this.app.tool === 'text' ? 'text' : 'default';
      if (t) {
        const [rx, ry] = this.rotHandle(t);
        if (Math.hypot(vx - rx, vy - ry) < 9) cursor = 'grab';
        else if (this.corners(t).some(([x, y]) => Math.abs(vx - x) < 7 && Math.abs(vy - y) < 7)) cursor = 'nwse-resize';
        else if (this.clipAt(vx, vy) === t.clip) cursor = 'move';
      }
      this.overlay.style.cursor = cursor;
      return;
    }
    const s = this.seq!;
    const [ax, ay] = this.toView(d.start.x, d.start.y);
    d.live.update((seq) => {
      const found = seq.video.flatMap((t) => t.clips).find((c) => c.id === d.clip);
      const m = found?.motion;
      if (!m) return;
      if (d.kind === 'move') {
        let dx = (vx - d.x) / this.box.k;
        let dy = (vy - d.y) / this.box.k;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        let nx = d.start.x + dx;
        let ny = d.start.y + dy;
        // Snaps to the middle of the frame
        if (Math.abs(nx - s.width / 2) * this.box.k < 6) nx = s.width / 2;
        if (Math.abs(ny - s.height / 2) * this.box.k < 6) ny = s.height / 2;
        setValue(m.x, d.local, Math.round(nx * 10) / 10);
        setValue(m.y, d.local, Math.round(ny * 10) / 10);
      } else if (d.kind === 'scale') {
        const k = Math.hypot(vx - ax, vy - ay) / d.dist0;
        setValue(m.scale, d.local, Math.max(1, Math.round(d.start.sy * 100 * k * 10) / 10));
        if (!m.uniform) setValue(m.scaleW, d.local, Math.max(1, Math.round(d.start.sx * 100 * k * 10) / 10));
      } else {
        let deg = (d.start.rotation + ((Math.atan2(vy - ay, vx - ax) - d.angle0) * 180) / Math.PI) % 360;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        setValue(m.rotation, d.local, Math.round(deg * 10) / 10);
      }
    });
  }

  private onUp(e: PointerEvent): void {
    if (!this.drag) return;
    this.overlay.releasePointerCapture(e.pointerId);
    this.drag.live.end();
    this.drag = null;
  }

  private onDouble(e: MouseEvent): void {
    const [vx, vy] = this.pointer(e);
    const c = this.clipAt(vx, vy);
    if (c?.kind === 'title') this.editTitle(c);
  }

  /** A new title where the Type tool clicked, ready to type in. */
  private addTitleAt(X: number, Y: number): void {
    const s = this.seq!;
    this.app.newTitle({ text: 'Text', x: Math.max(0, Math.min(1, X / s.width)), y: Math.max(0, Math.min(1, Y / s.height)), align: 'left' }, 'Text');
    this.app.setTool('select');
    const sel = this.app.focusClip();
    if (sel?.clip.kind === 'title') requestAnimationFrame(() => this.editTitle(sel.clip, true));
  }

  /** Edits a title's words right in the picture. */
  editTitle(c: Clip, selectAll = true): void {
    if (!c.title || this.editor) return;
    const s = this.seq!;
    const b = titleBounds(c.title, s.width, s.height);
    const g = this.geometry(c, Math.max(0, this.app.playhead - c.start));
    const [x, y] = this.toView(...toFrame(g.p, b.x - s.width / 2, b.y - s.height / 2));
    const st = c.title;
    const ta = h('textarea', { class: 'mon-text-edit', spellcheck: false }) as HTMLTextAreaElement;
    ta.value = st.text;
    const k = this.box.k * g.p.sy;
    Object.assign(ta.style, {
      left: `${x}px`,
      top: `${y}px`,
      minWidth: `${Math.max(120, b.w * k + 24)}px`,
      minHeight: `${b.h * k + 8}px`,
      font: `${st.italic ? 'italic ' : ''}${st.bold ? 700 : 400} ${st.size * k}px "${st.font}", "Segoe UI", sans-serif`,
      lineHeight: String(st.lineHeight),
      color: st.color,
      textAlign: st.align,
    });
    this.view.append(ta);
    this.editor = ta;
    ta.focus();
    if (selectAll) ta.select();
    const id = c.id;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      const text = ta.value;
      ta.remove();
      this.editor = null;
      if (ok && text !== st.text)
        this.app.edit('Edit title text', (seq) => {
          const t = seq.video.flatMap((tr) => tr.clips).find((x) => x.id === id);
          if (!t?.title) return false;
          t.title.text = text || ' ';
          t.name = (text.split('\n')[0] || 'Title').slice(0, 40);
        });
      this.view.focus();
    };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true);
    });
    ta.addEventListener('blur', () => finish(true));
  }

  shown(): void {
    this.layoutCanvas();
    this.request();
  }

  /** For the Lumetri panel's Auto: the current frame's pixels at a small size (of `project`, a changed copy). */
  sample(project = this.app.project): { data: Uint8Array; w: number; h: number } | null {
    const app = this.app;
    const c = this.ensureCompositor();
    if (!c || !project) return null;
    const s = project.sequences.find((x) => x.id === project.active) ?? project.sequences[0];
    const t = c.renderToTarget({ project, seq: s, frame: app.playhead, scale: Math.min(1, 256 / s.width), provider: app.player });
    const data = c.gl.read(t);
    const out = { data, w: t.w, h: t.h };
    c.gl.release(t);
    this.request();
    return out;
  }
}
