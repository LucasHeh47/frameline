// Small controls for the tool options bar and panels: sliders with a number box, toggles,
// dropdowns and segmented buttons.
import type { IconNode } from 'lucide';
import { h, icon } from './dom';
import { tooltip } from './widgets';

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
  /** Logarithmic track (brush sizes: fine control at small sizes). */
  log?: boolean;
  width?: number;
  title?: string;
  onChange: (v: number) => void;
  /** Called while dragging (onChange runs once at the end). */
  onInput?: (v: number) => void;
}

/** A labelled slider with an editable number. */
export function slider(o: SliderOptions): HTMLElement {
  const step = o.step ?? 1;
  const toTrack = (v: number) => (o.log ? (Math.log(v - o.min + 1) / Math.log(o.max - o.min + 1)) * 1000 : v);
  const fromTrack = (t: number) => {
    const v = o.log ? Math.exp((t / 1000) * Math.log(o.max - o.min + 1)) - 1 + o.min : t;
    return Math.max(o.min, Math.min(o.max, Math.round(v / step) * step));
  };
  const range = h('input', { type: 'range', class: 'ctl-range', min: o.log ? 0 : o.min, max: o.log ? 1000 : o.max, step: o.log ? 1 : step, value: String(toTrack(o.value)), 'aria-label': o.label }) as HTMLInputElement;
  if (o.width) range.style.width = `${o.width}px`;
  const num = h('input', { type: 'number', class: 'input ctl-num', min: o.min, max: o.max, step, value: String(o.value), 'aria-label': o.label }) as HTMLInputElement;
  const fmt = (v: number) => String(+v.toFixed(step < 1 ? 2 : 0));
  range.addEventListener('input', () => {
    const v = fromTrack(+range.value);
    num.value = fmt(v);
    o.onInput?.(v);
  });
  range.addEventListener('change', () => o.onChange(fromTrack(+range.value)));
  num.addEventListener('change', () => {
    const v = Math.max(o.min, Math.min(o.max, +num.value || o.min));
    num.value = fmt(v);
    range.value = String(toTrack(v));
    o.onChange(v);
  });
  const el = h('label', { class: 'ctl ctl-slider' }, h('span', { class: 'ctl-label' }, o.label), range, num, o.unit ? h('span', { class: 'ctl-unit' }, o.unit) : null);
  if (o.title) tooltip(el, o.title);
  // Lets callers update it from outside ([ and ] change the brush size)
  (el as HTMLElement & { setValue?: (v: number) => void }).setValue = (v: number) => {
    range.value = String(toTrack(v));
    num.value = fmt(v);
  };
  return el;
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, title?: string, ic?: IconNode): HTMLElement {
  const box = h('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
  box.addEventListener('change', () => onChange(box.checked));
  const el = h('label', { class: 'ctl ctl-toggle' }, box, ic ? icon(ic, 14) : null, h('span', null, label));
  if (title) tooltip(el, title);
  return el;
}

export function dropdown<T extends string>(label: string | null, options: [T, string][], value: T, onChange: (v: T) => void, title?: string): HTMLElement {
  const sel = h('select', { class: 'input ctl-select', 'aria-label': label ?? title ?? '' }) as HTMLSelectElement;
  for (const [v, text] of options) sel.append(h('option', { value: v }, text));
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value as T));
  const el = h('label', { class: 'ctl ctl-dropdown' }, label ? h('span', { class: 'ctl-label' }, label) : null, sel);
  if (title) tooltip(el, title);
  return el;
}

export interface Segment<T> {
  value: T;
  icon?: IconNode;
  label?: string;
  title: string;
}

/** Buttons where one is chosen (like a radio group). */
export function segmented<T>(segments: Segment<T>[], value: T, onChange: (v: T) => void): HTMLElement {
  const el = h('div', { class: 'ctl ctl-seg', role: 'radiogroup' });
  const render = (cur: T) => {
    el.replaceChildren(
      ...segments.map((s) => {
        const b = h('button', { class: `btn seg${s.value === cur ? ' on' : ''}`, role: 'radio', 'aria-checked': s.value === cur ? 'true' : 'false', 'aria-label': s.title, onclick: () => {
          render(s.value);
          onChange(s.value);
        } }, s.icon ? icon(s.icon, 15) : null, s.label ?? null);
        tooltip(b, s.title);
        return b;
      }),
    );
  };
  render(value);
  return el;
}

export function sep(): HTMLElement {
  return h('span', { class: 'ctl-sep' });
}

export function infoText(text: string): HTMLElement {
  return h('span', { class: 'ctl-info' }, text);
}
