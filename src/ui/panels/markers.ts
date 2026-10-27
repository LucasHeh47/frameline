// The Markers panel: the sequence's markers with their names and notes. Click one to go there.
import * as L from 'lucide';
import { MARKER_COLOR_NAMES, MARKER_COLORS } from '../../core/edit';
import { timecode } from '../../core/time';
import type { App } from '../app';
import { h, icon } from '../dom';
import type { Panel } from '../layout';
import { showMenu, tooltip } from '../widgets';

export class MarkersPanel implements Panel {
  readonly id = 'markers';
  readonly title = 'Markers';
  readonly el: HTMLElement;
  private list: HTMLElement;
  /** Each marker's row, to light up the one the playhead is on. */
  private rows: { f: number; el: HTMLElement }[] = [];

  constructor(private app: App) {
    this.list = h('div', { class: 'mk-list' });
    const add = h('button', { class: 'btn small outline', onclick: () => app.commands.run('marker.add') }, icon(L.Plus, 13), 'Add at playhead');
    tooltip(add, 'Add a marker at the playhead', 'M');
    const chapters = h('button', { class: 'btn small text', onclick: () => app.commands.run('marker.chapters') }, icon(L.ListOrdered, 13), 'Copy as YouTube chapters');
    tooltip(chapters, 'Copies "0:00 Name" lines for your video description');
    this.el = h('div', { class: 'markers-panel' }, h('div', { class: 'proj-bar' }, add, chapters), this.list);
    for (const k of ['project', 'sequence'] as const) app.on(k, () => this.render());
    // The playhead moves on every frame while playing: just light up the marker it's on
    app.on('playhead', () => {
      const ph = app.playhead;
      for (const r of this.rows) r.el.classList.toggle('on', r.f === ph);
    });
    this.render();
  }

  shown(): void {
    this.render();
  }

  private render(): void {
    const app = this.app;
    if (!app.project || !app.layout?.isShown(this.id)) return;
    const s = app.seq;
    if (!s.markers.length) {
      this.list.replaceChildren(h('div', { class: 'ec-empty' }, icon(L.Bookmark, 24), h('p', null, 'Press M to mark a moment — a beat, a line, a change of scene.'), h('p', { class: 'hint' }, 'Clips snap to markers, and Shift+M jumps to the next one.')));
      return;
    }
    const ph = app.playhead;
    this.rows = [];
    this.list.replaceChildren(
      ...s.markers.map((m) => {
        const name = h('input', { class: 'input mk-name', value: m.name, placeholder: 'Name' }) as HTMLInputElement;
        name.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') name.blur();
        });
        name.addEventListener('change', () => app.edit('Rename marker', (seq) => {
          const x = seq.markers.find((y) => y.id === m.id);
          if (x) x.name = name.value;
        }));
        const note = h('input', { class: 'input mk-note', value: m.comment ?? '', placeholder: 'Note' }) as HTMLInputElement;
        note.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') note.blur();
        });
        note.addEventListener('change', () => app.edit('Marker note', (seq) => {
          const x = seq.markers.find((y) => y.id === m.id);
          if (x) x.comment = note.value || undefined;
        }));
        const dot = h('button', { class: 'mk-dot', style: { background: m.color }, 'aria-label': 'Marker color', onclick: (e: MouseEvent) => showMenu(MARKER_COLORS.map((c, i) => ({ label: MARKER_COLOR_NAMES[i], checked: c === m.color, run: () => app.edit('Marker color', (seq) => {
          const x = seq.markers.find((y) => y.id === m.id);
          if (x) x.color = c;
        }) })), e.currentTarget as HTMLElement) });
        const go = h('button', { class: 'btn text small mk-time', onclick: () => {
          app.player.pause();
          app.setPlayhead(m.f);
          app.layout.timeline.reveal(m.f);
        } }, timecode(m.f, s.fps));
        const del = h('button', { class: 'btn icon-only small', 'aria-label': 'Delete marker', onclick: () => app.edit('Delete marker', (seq) => void (seq.markers = seq.markers.filter((x) => x.id !== m.id))) }, icon(L.X, 13));
        const row = h('div', { class: `mk-row${m.f === ph ? ' on' : ''}` }, dot, go, name, note, del);
        this.rows.push({ f: m.f, el: row });
        return row;
      }),
    );
  }
}
