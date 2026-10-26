// The bottom bar: what's selected, hints while dragging, messages and progress, and the sequence's
// size and frame rate.
import { clipEnd, sequenceDuration } from '../core/project';
import { shortDuration, timecode } from '../core/time';
import type { App } from './app';
import { TOOLS } from './timeline/tools';
import { h } from './dom';
import { tooltip } from './widgets';

export class StatusBar {
  readonly el: HTMLElement;
  private sel: HTMLElement;
  private tool: HTMLElement;
  private msg: HTMLElement;
  private progress: HTMLElement;
  private seqInfo: HTMLElement;
  private msgTimer: ReturnType<typeof setTimeout> | undefined;
  private hinting = false;

  constructor(private app: App) {
    this.sel = h('span', { class: 'sb-item' });
    this.tool = h('span', { class: 'sb-tool' });
    this.msg = h('span', { class: 'sb-msg' });
    this.progress = h('span', { class: 'sb-progress', hidden: true });
    this.seqInfo = h('button', { class: 'sb-item sb-seq', onclick: () => app.commands.run('sequence.settings') });
    tooltip(this.seqInfo, 'Sequence settings');
    this.el = h('footer', { class: 'statusbar' }, this.sel, this.tool, h('span', { class: 'spacer' }), this.msg, this.progress, this.seqInfo);
    for (const k of ['selection', 'project', 'sequence', 'tool'] as const) app.on(k, () => this.update());
    this.update();
  }

  update(): void {
    const app = this.app;
    if (!app.project) return;
    const s = app.seq;
    const list = app.selectedClips();
    if (app.transitionSel) this.sel.textContent = 'Transition selected';
    else if (list.length) {
      const a = Math.min(...list.map((x) => x.clip.start));
      const b = Math.max(...list.map((x) => clipEnd(x.clip)));
      this.sel.textContent = `${list.length} clip${list.length === 1 ? '' : 's'} selected · ${timecode(a, s.fps)} · ${shortDuration(b - a, s.fps)}`;
    } else this.sel.textContent = `${s.name} · ${shortDuration(sequenceDuration(s), s.fps)}`;
    const t = TOOLS.find((x) => x.id === app.tool);
    if (!this.hinting) this.tool.textContent = t && t.id !== 'select' ? `${t.name} tool (${t.key}) — ${t.hint}` : '';
    this.seqInfo.textContent = `${s.width} × ${s.height} · ${Math.round(s.fps * 1000) / 1000} fps · ${s.sampleRate / 1000} kHz`;
  }

  /** A short message that goes away by itself. */
  flash(text: string): void {
    this.msg.textContent = text;
    clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => (this.msg.textContent = ''), 3500);
  }

  /** What a drag is doing right now (null when it ends). */
  hint(text: string | null): void {
    this.hinting = text !== null;
    if (text === null) this.update();
    else this.tool.textContent = text;
  }

  setProgress(label: string | null, percent: number): void {
    this.progress.hidden = label === null;
    if (label !== null) this.progress.textContent = `${label} ${Math.round(percent)}%`;
  }
}
