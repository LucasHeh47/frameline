// The History panel: every change since the project opened. Click a step to go back to it (and
// forward again, until something new is done).
import * as L from 'lucide';
import type { App } from '../app';
import { h, icon } from '../dom';
import type { Panel } from '../layout';

export class HistoryPanel implements Panel {
  readonly id = 'history';
  readonly title = 'History';
  readonly el: HTMLElement;
  private list: HTMLElement;

  constructor(private app: App) {
    this.list = h('div', { class: 'hist-list' });
    this.el = h('div', { class: 'history-panel' }, this.list);
    app.on('history', () => this.render());
    this.render();
  }

  shown(): void {
    this.render();
  }

  private render(): void {
    const app = this.app;
    if (!app.project || !app.layout?.isShown(this.id)) return;
    const steps = app.history.steps();
    const done = steps.filter((s) => s.done).length;
    const row = (label: string, n: number, cls: string, ic: L.IconNode) => h('button', { class: `hist-row ${cls}`, onclick: () => app.goToStep(n) }, icon(ic, 13), h('span', null, label));
    this.list.replaceChildren(
      row(app.project.name ? `Opened ${app.project.name}` : 'Start', 0, done === 0 ? 'on' : '', L.FolderOpen),
      ...steps.map((s, i) => row(s.label, i + 1, i + 1 === done ? 'on' : s.done ? '' : 'undone', s.done ? L.History : L.Redo2)),
    );
    this.list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
}
