// Speed / Duration: faster, slower or backwards, by percent or by the length you want.
import { setSpeed } from '../../core/edit';
import { findClip, linkedClips, sourceSpan } from '../../core/project';
import { parseTimecode, timecode } from '../../core/time';
import type { App } from '../app';
import { h } from '../dom';
import { dialog } from '../widgets';
import { checkbox, field, row } from './common';

export async function openSpeed(app: App): Promise<void> {
  const list = app.selectedClips();
  if (!list.length) return;
  const first = list[0].clip;
  const fps = app.fps;
  const speed = h('input', { class: 'input', type: 'number', min: 1, max: 10000, step: 1, value: String(Math.round(first.speed * 1000) / 10), style: { width: '100px' } }) as HTMLInputElement;
  const dur = h('input', { class: 'input', value: timecode(first.duration, fps), style: { width: '130px' } }) as HTMLInputElement;
  const span = sourceSpan(first, fps);
  // Speed and duration follow each other
  speed.addEventListener('input', () => {
    const v = Number(speed.value) / 100;
    if (v > 0) dur.value = timecode(Math.max(1, Math.round((span / v) * fps)), fps);
  });
  dur.addEventListener('change', () => {
    const f = parseTimecode(dur.value, fps, first.duration);
    if (f && f > 0) {
      speed.value = String(Math.round(((span * fps) / f) * 1000) / 10);
      dur.value = timecode(f, fps);
    }
  });
  const reverse = checkbox('Play backwards', !!first.reverse);
  const ripple = checkbox('Move the clips after it (ripple edit)', true);
  const presets = h(
    'div',
    { class: 'chip-row' },
    ...[25, 50, 100, 200, 400].map((p) =>
      h('button', { class: 'btn small outline', onclick: () => {
        speed.value = String(p);
        speed.dispatchEvent(new Event('input'));
      } }, `${p}%`),
    ),
  );
  const body = h(
    'div',
    { class: 'form' },
    row(field('Speed', h('span', { class: 'field-inline' }, speed, h('span', { class: 'hint' }, '%'))), field('Duration', dur)),
    presets,
    reverse.el,
    ripple.el,
    h('p', { class: 'hint' }, 'Under 100% is slow motion. The sound changes pitch with the speed.'),
  );
  setTimeout(() => speed.select(), 0);
  const ok = await dialog(list.length > 1 ? `Speed / Duration (${list.length} clips)` : 'Speed / Duration', body, [
    { label: 'OK', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  const v = Math.max(0.01, Math.min(100, Number(speed.value) / 100 || 1));
  const ids = [...new Set(list.map((x) => x.clip.id))];
  app.edit(v === 1 && !reverse.input.checked ? 'Normal speed' : `Speed ${Math.round(v * 100)}%`, (s) => {
    // Linked clips change together, so each group once
    const done = new Set<string>();
    for (const id of ids) {
      const f = findClip(s, id);
      if (!f || done.has(id)) continue;
      for (const c of linkedClips(s, f.clip)) done.add(c.id);
      setSpeed(s, id, v, reverse.input.checked, ripple.input.checked);
    }
  });
}
