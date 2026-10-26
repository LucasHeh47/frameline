// Building blocks for dialogs: labelled fields, number boxes and choices.
import { h } from '../dom';
import { dialog } from '../widgets';

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function row(...children: (HTMLElement | null)[]): HTMLElement {
  return h('div', { class: 'field-row' }, ...children);
}

export function numInput(value: number, min: number, max: number, step = 1, width = 90): HTMLInputElement {
  const el = h('input', { class: 'input', type: 'number', min, max, step, value: String(value) }) as HTMLInputElement;
  el.style.width = `${width}px`;
  return el;
}

/** The number in a box, kept inside its limits. */
export function numValue(el: HTMLInputElement, fallback: number): number {
  const v = Number(el.value);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(Number(el.min), Math.min(Number(el.max), v));
}

export function select<T extends string>(options: [T, string][], value: T, width?: number): HTMLSelectElement {
  const el = h('select', { class: 'input' }, ...options.map(([v, label]) => h('option', { value: v }, label))) as HTMLSelectElement;
  el.value = value;
  if (width) el.style.width = `${width}px`;
  return el;
}

export function checkbox(label: string, value: boolean, onChange?: (v: boolean) => void): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  return { el: h('label', { class: 'check' }, input, h('span', null, label)), input };
}

/** Asks for one number. */
export async function numberDialog(title: string, label: string, value: number, min: number, max: number, unit = ''): Promise<number | null> {
  const input = numInput(value, min, max);
  const body = h('div', null, field(label, h('span', { class: 'field-inline' }, input, unit ? h('span', { class: 'hint' }, unit) : null)));
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  const ok = await dialog(title, body, [
    { label: 'OK', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  return ok ? numValue(input, value) : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Runs heavy work after the browser has painted (so "Working…" shows first). */
export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

export interface Progress {
  /** 0–1, and what's happening. */
  set(fraction: number, text?: string): void;
  readonly canceled: boolean;
  /** An extra element above the bar (export shows the frame being made). */
  readonly body: HTMLElement;
  close(): void;
}

/** A window with a progress bar and a Cancel button, for long jobs. */
export function progressDialog(title: string, cancelLabel = 'Cancel'): Progress {
  const fill = h('div', { class: 'progress-fill' });
  const text = h('p', { class: 'hint progress-text' }, 'Starting…');
  const body = h('div', { class: 'progress-body' });
  let canceled = false;
  const cancel = h('button', { class: 'btn outline', onclick: () => {
    canceled = true;
    cancel.disabled = true;
    text.textContent = 'Stopping…';
  } }, cancelLabel);
  const back = h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal progress-modal', role: 'dialog', 'aria-modal': 'true' }, h('h3', null, title), body, h('div', { class: 'progress' }, fill), text, h('div', { class: 'actions' }, cancel)));
  document.body.append(back);
  cancel.focus();
  return {
    set(fraction, t) {
      fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      if (t !== undefined && !canceled) text.textContent = t;
    },
    get canceled() {
      return canceled;
    },
    body,
    close() {
      back.remove();
    },
  };
}
