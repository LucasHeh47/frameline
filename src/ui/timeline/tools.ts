// The editing tools (the strip beside the timeline), with Premiere's keys.
import * as L from 'lucide';
import type { App, ToolId } from '../app';
import { h, icon } from '../dom';
import { tooltip } from '../widgets';

export interface ToolDef {
  id: ToolId;
  name: string;
  key: string;
  icon: L.IconNode;
  hint: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'select', name: 'Selection', key: 'V', icon: L.MousePointer2, hint: 'Select, move and trim clips. Ctrl+drag an edge ripples it.' },
  { id: 'trackSelect', name: 'Track Select Forward', key: 'A', icon: L.ChevronsRight, hint: 'Selects everything from where you click to the end (Shift: just that track).' },
  { id: 'ripple', name: 'Ripple Edit', key: 'B', icon: L.FoldHorizontal, hint: 'Trims a clip and moves everything after it, so no gap opens.' },
  { id: 'roll', name: 'Rolling Edit', key: 'N', icon: L.Columns2, hint: 'Moves a cut: one clip gets longer, the next one shorter.' },
  { id: 'stretch', name: 'Rate Stretch', key: 'R', icon: L.MoveHorizontal, hint: 'Drag an edge to speed a clip up or slow it down to fit.' },
  { id: 'razor', name: 'Razor', key: 'C', icon: L.Scissors, hint: 'Click to cut a clip in two (Shift: every track).' },
  { id: 'slip', name: 'Slip', key: 'Y', icon: L.UnfoldHorizontal, hint: 'Drag a clip to show an earlier or later part of it, in the same place.' },
  { id: 'slide', name: 'Slide', key: 'U', icon: L.ArrowRightLeft, hint: 'Drag a clip between its neighbors; they get longer or shorter to make room.' },
  { id: 'hand', name: 'Hand', key: 'H', icon: L.Hand, hint: 'Drag to scroll the timeline.' },
  { id: 'zoom', name: 'Zoom', key: 'Z', icon: L.ZoomIn, hint: 'Click to zoom in (Alt+click zooms out).' },
  { id: 'text', name: 'Type', key: 'T', icon: L.Type, hint: 'Click in the Program monitor to add text.' },
];

export class ToolsStrip {
  readonly el: HTMLElement;

  constructor(private app: App) {
    this.el = h('div', { class: 'tools-strip', role: 'toolbar', 'aria-orientation': 'vertical' });
    app.on('tool', () => this.render());
    this.render();
  }

  private render(): void {
    this.el.replaceChildren(
      ...TOOLS.map((t) => {
        const b = h('button', { class: `btn tool-btn${this.app.tool === t.id ? ' on' : ''}`, 'aria-label': t.name, 'aria-pressed': this.app.tool === t.id ? 'true' : 'false', onclick: () => this.app.setTool(t.id) }, icon(t.icon, 17));
        tooltip(b, `${t.name} — ${t.hint}`, t.key);
        return b;
      }),
    );
  }
}
