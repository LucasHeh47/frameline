// The Source monitor: a media file on its own, to watch and mark the part you want (in and out),
// then insert or overwrite it at the playhead, or drag it (or only its picture or sound) to the
// timeline.
import * as L from 'lucide';
import type { MediaItem } from '../../core/project';
import { clockTime, parseTimecode, timecode } from '../../core/time';
import type { App } from '../app';
import { h, icon } from '../dom';
import type { Panel } from '../layout';
import { platform } from '../platform';
import { tooltip } from '../widgets';

export class SourceMonitor implements Panel {
  readonly id = 'source';
  readonly title = 'Source';
  readonly el: HTMLElement;
  private view: HTMLElement;
  private video: HTMLVideoElement;
  private image: HTMLImageElement;
  private wave: HTMLCanvasElement;
  private empty: HTMLElement;
  private scrub: HTMLCanvasElement;
  private tcNow: HTMLElement;
  private tcDur: HTMLElement;
  private nameEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private media: MediaItem | null = null;
  /** In and out points (seconds) chosen for each file. */
  private marks = new Map<string, { in: number | null; out: number | null }>();
  private raf = 0;

  constructor(private app: App) {
    this.video = h('video', { class: 'src-video', preload: 'auto', crossOrigin: 'anonymous', playsInline: true }) as HTMLVideoElement;
    this.image = h('img', { class: 'src-image', alt: '' }) as HTMLImageElement;
    this.wave = h('canvas', { class: 'src-wave' }) as HTMLCanvasElement;
    this.empty = h('div', { class: 'mon-empty' }, icon(L.Film, 28), h('p', null, 'Double-click a file in the Project panel to see it here.'), h('p', { class: 'hint' }, 'Mark the part you want with I and O, then drag it to the timeline.'));
    this.view = h('div', { class: 'mon-view src-view', tabindex: '-1' }, this.video, this.image, this.wave, this.empty);
    this.scrub = h('canvas', { class: 'mon-scrub' }) as HTMLCanvasElement;
    this.tcNow = h('span', { class: 'mon-tc now' });
    this.tcDur = h('span', { class: 'mon-tc dur' });
    this.nameEl = h('span', { class: 'src-name' });
    const btn = (ic: L.IconNode, label: string, fn: () => void, keys?: string) => {
      const b = h('button', { class: 'btn icon-only', 'aria-label': label, onclick: fn }, icon(ic, 16)) as HTMLButtonElement;
      tooltip(b, label, keys);
      return b;
    };
    this.playBtn = btn(L.Play, 'Play / Stop', () => this.toggle(), 'Space');
    this.playBtn.classList.add('play');
    const dragVideo = this.dragHandle(L.Film, 'Drag only the picture to the timeline', 'video');
    const dragAudio = this.dragHandle(L.AudioLines, 'Drag only the sound to the timeline', 'audio');
    this.el = h(
      'div',
      { class: 'monitor source' },
      this.view,
      this.scrub,
      h('div', { class: 'mon-info' }, this.tcNow, h('div', { class: 'spacer' }), this.nameEl, dragVideo, dragAudio, h('div', { class: 'spacer' }), this.tcDur),
      h(
        'div',
        { class: 'mon-transport' },
        btn(L.ArrowRightToLine, 'Mark in', () => this.mark('in'), 'I'),
        btn(L.ArrowLeftToLine, 'Mark out', () => this.mark('out'), 'O'),
        h('span', { class: 'mon-gap' }),
        btn(L.SkipBack, 'Go to in point', () => this.seek(this.range().in)),
        btn(L.StepBack, 'Back one frame', () => this.step(-1), 'Left'),
        this.playBtn,
        btn(L.StepForward, 'Forward one frame', () => this.step(1), 'Right'),
        btn(L.SkipForward, 'Go to out point', () => this.seek(this.range().out)),
        h('span', { class: 'mon-gap' }),
        btn(L.ListPlus, 'Insert at the playhead (pushes later clips along)', () => void this.place('insert'), ','),
        btn(L.ListEnd, 'Overwrite at the playhead', () => void this.place('overwrite'), '.'),
      ),
    );
    this.view.draggable = true;
    this.view.addEventListener('dragstart', (e) => this.startDrag(e, 'both'));
    this.video.addEventListener('timeupdate', () => this.update());
    this.video.addEventListener('seeked', () => this.update());
    this.video.addEventListener('loadedmetadata', () => this.update());
    this.video.addEventListener('play', () => this.loop());
    this.video.addEventListener('pause', () => this.update());
    this.scrub.addEventListener('pointerdown', (e) => this.scrubDown(e));
    this.tcNow.addEventListener('click', () => this.typeTime());
    new ResizeObserver(() => this.update()).observe(this.view);
    app.on('project', () => {
      // The file was removed from the project
      if (this.media && !app.mediaById(this.media.id)) this.close();
    });
    app.on('media', () => this.drawWave());
    this.close();
  }

  /** Whether keys like I, O and Space go to the Source monitor (it was clicked last). */
  get active(): boolean {
    return this.el.contains(document.activeElement) || this.app.layout?.lastPanel === 'source';
  }

  get current(): MediaItem | null {
    return this.media;
  }

  open(mediaId: string, at = 0): void {
    const m = this.app.mediaById(mediaId);
    if (!m) return;
    this.app.layout.show('source');
    this.media = m;
    this.empty.hidden = true;
    this.video.hidden = m.kind === 'image';
    this.image.hidden = m.kind !== 'image';
    this.wave.hidden = m.kind !== 'audio';
    this.nameEl.textContent = m.name;
    if (m.kind === 'image') {
      this.video.removeAttribute('src');
      this.image.src = platform.mediaUrl(m.path);
    } else {
      this.image.removeAttribute('src');
      this.video.src = platform.mediaUrl(m.path);
      this.video.currentTime = at;
    }
    if (m.kind === 'audio') this.video.classList.add('audio-only');
    else this.video.classList.remove('audio-only');
    this.app.layout.lastPanel = 'source';
    this.update();
    this.drawWave();
  }

  close(): void {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.image.removeAttribute('src');
    this.media = null;
    this.video.hidden = true;
    this.image.hidden = true;
    this.wave.hidden = true;
    this.empty.hidden = false;
    this.nameEl.textContent = '';
    this.update();
  }

  private get fps(): number {
    return this.media?.fps || this.app.project?.sequences[0].fps || 30;
  }

  private get duration(): number {
    const m = this.media;
    if (!m) return 0;
    return m.kind === 'image' ? this.app.settings.num('timeline.stillSeconds') : m.duration;
  }

  /** The marked part (the whole file when nothing is marked). */
  range(): { in: number; out: number } {
    const k = this.media ? this.marks.get(this.media.id) : undefined;
    return { in: k?.in ?? 0, out: k?.out ?? this.duration };
  }

  get time(): number {
    return this.media?.kind === 'image' ? 0 : this.video.currentTime || 0;
  }

  mark(which: 'in' | 'out' | 'clear'): void {
    const m = this.media;
    if (!m || m.kind === 'image') return;
    const k = this.marks.get(m.id) ?? { in: null, out: null };
    if (which === 'clear') {
      k.in = null;
      k.out = null;
    } else {
      k[which] = this.time;
      if (k.in !== null && k.out !== null && k.out <= k.in) k[which === 'in' ? 'out' : 'in'] = null;
    }
    this.marks.set(m.id, k);
    this.update();
  }

  seek(t: number): void {
    if (!this.media || this.media.kind === 'image') return;
    this.video.currentTime = Math.max(0, Math.min(this.duration, t));
  }

  step(frames: number): void {
    this.video.pause();
    this.seek(this.time + frames / this.fps + 1e-4);
  }

  toggle(): void {
    if (!this.media || this.media.kind === 'image') return;
    this.app.player.pause();
    if (this.video.paused) {
      const r = this.range();
      if (this.time >= r.out - 0.05) this.video.currentTime = r.in;
      void this.video.play();
    } else this.video.pause();
  }

  private loop(): void {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      this.update();
      // Stop at the out point
      const k = this.media ? this.marks.get(this.media.id) : undefined;
      if (k?.out !== null && k?.out !== undefined && this.time >= k.out) this.video.pause();
      if (!this.video.paused) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Puts the marked part at the timeline's playhead. */
  async place(mode: 'insert' | 'overwrite'): Promise<void> {
    const m = this.media;
    if (!m) return;
    const r = this.range();
    await this.app.placeMedia([m], this.app.playhead, null, mode, 'both', m.kind === 'image' ? undefined : r);
  }

  private dragHandle(ic: L.IconNode, label: string, parts: 'video' | 'audio'): HTMLElement {
    const el = h('span', { class: 'src-drag', draggable: 'true', role: 'button', 'aria-label': label }, icon(ic, 14));
    tooltip(el, label);
    el.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      this.startDrag(e, parts);
    });
    return el;
  }

  private startDrag(e: DragEvent, parts: 'both' | 'video' | 'audio'): void {
    const m = this.media;
    if (!m || !e.dataTransfer) {
      e.preventDefault();
      return;
    }
    const r = this.range();
    const seqFps = this.app.fps;
    e.dataTransfer.setData('application/x-frameline-media', JSON.stringify({ ids: [m.id], parts, in: m.kind === 'image' ? undefined : r.in, out: m.kind === 'image' ? undefined : r.out }));
    e.dataTransfer.effectAllowed = 'copy';
    window.__framelineDrag = { frames: m.kind === 'image' ? this.app.stillFrames : Math.round((r.out - r.in) * seqFps), label: m.name };
  }

  // ---------- drawing ----------

  private update(): void {
    const m = this.media;
    this.playBtn.replaceChildren(icon(this.video.paused ? L.Play : L.Square, 16));
    if (!m) {
      this.tcNow.textContent = '';
      this.tcDur.textContent = '';
      this.drawScrub();
      return;
    }
    const fps = this.fps;
    this.tcNow.textContent = m.kind === 'image' ? clockTime(0) : timecode(Math.round(this.time * fps), fps);
    const r = this.range();
    this.tcDur.textContent = timecode(Math.round((r.out - r.in) * fps), fps);
    this.drawScrub();
  }

  private drawScrub(): void {
    const c = this.scrub;
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (!w) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(hh * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const css = getComputedStyle(this.el);
    ctx.fillStyle = css.getPropertyValue('--border');
    ctx.fillRect(8, hh / 2 - 1, w - 16, 2);
    const dur = this.duration;
    if (!this.media || !dur) return;
    const x = (t: number) => 8 + ((w - 16) * t) / dur;
    const r = this.range();
    ctx.fillStyle = css.getPropertyValue('--accent-soft');
    ctx.fillRect(x(r.in), 2, x(r.out) - x(r.in), hh - 4);
    const px = x(this.time);
    ctx.fillStyle = css.getPropertyValue('--accent');
    ctx.beginPath();
    ctx.moveTo(px - 5, 1);
    ctx.lineTo(px + 5, 1);
    ctx.lineTo(px, 8);
    ctx.fill();
    ctx.fillRect(px - 0.5, 1, 1, hh - 2);
  }

  private drawWave(): void {
    const m = this.media;
    if (!m || m.kind !== 'audio') return;
    const c = this.wave;
    const dpr = devicePixelRatio || 1;
    const w = this.view.clientWidth;
    const hh = this.view.clientHeight;
    if (!w || !hh) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(hh * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const peaks = this.app.library.peaksOf(m);
    if (!peaks) return;
    ctx.fillStyle = '#3fcf8e';
    const per = peaks.data.length / w;
    for (let x = 0; x < w; x++) {
      let p = 0;
      for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i++) p = Math.max(p, peaks.data[i] ?? 0);
      const v = (p / 255) * (hh / 2 - 8);
      ctx.fillRect(x, hh / 2 - v, 1, v * 2 || 1);
    }
  }

  private scrubDown(e: PointerEvent): void {
    if (!this.media || this.media.kind === 'image') return;
    const at = (ev: PointerEvent) => {
      const r = this.scrub.getBoundingClientRect();
      return ((ev.clientX - r.left - 8) / Math.max(1, r.width - 16)) * this.duration;
    };
    this.video.pause();
    this.seek(at(e));
    this.scrub.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => this.seek(at(ev));
    const up = () => {
      this.scrub.removeEventListener('pointermove', move);
      this.scrub.removeEventListener('pointerup', up);
    };
    this.scrub.addEventListener('pointermove', move);
    this.scrub.addEventListener('pointerup', up);
  }

  private typeTime(): void {
    if (!this.media || this.media.kind === 'image') return;
    const fps = this.fps;
    const input = h('input', { class: 'input mon-tc-input', value: this.tcNow.textContent ?? '' }) as HTMLInputElement;
    this.tcNow.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (ok) {
        const f = parseTimecode(input.value, fps, Math.round(this.time * fps));
        if (f !== null) this.seek(f / fps);
      }
      input.replaceWith(this.tcNow);
      this.update();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  shown(): void {
    this.update();
    this.drawWave();
  }
}
