// New sequence / Sequence settings: size and frame rate, from a preset or your own.
import { SEQUENCE_PRESETS, newSequence, type Sequence } from '../../core/project';
import { FRAME_RATES } from '../../core/time';
import type { App } from '../app';
import { h } from '../dom';
import { dialog } from '../widgets';
import { field, numInput, numValue, row, select } from './common';

/** Moves clips to the same place in a resized frame (positions are in pixels). */
function rescale(s: Sequence, w: number, hh: number): void {
  const kx = w / s.width;
  const ky = hh / s.height;
  for (const t of s.video)
    for (const c of t.clips) {
      const m = c.motion;
      if (!m) continue;
      m.x.v *= kx;
      m.y.v *= ky;
      for (const k of m.x.keys ?? []) k.v *= kx;
      for (const k of m.y.keys ?? []) k.v *= ky;
    }
}

export async function openSequenceSettings(app: App, mode: 'new' | 'edit'): Promise<void> {
  const cur = mode === 'edit' ? app.seq : null;
  const name = h('input', { class: 'input', value: cur?.name ?? `Sequence ${String((app.project?.sequences.length ?? 0) + 1).padStart(2, '0')}`, style: { width: '100%' } }) as HTMLInputElement;
  const w = numInput(cur?.width ?? 1920, 16, 8192, 2);
  const hh = numInput(cur?.height ?? 1080, 16, 8192, 2);
  const fps = select(FRAME_RATES.map(([v, l]) => [String(v), l] as [string, string]), String(cur?.fps ?? 30));
  const match = SEQUENCE_PRESETS.find((p) => p.width === (cur?.width ?? 1920) && p.height === (cur?.height ?? 1080) && p.fps === (cur?.fps ?? 30));
  const preset = select([...SEQUENCE_PRESETS.map((p) => [p.id, `${p.name} — ${p.description}`] as [string, string]), ['custom', 'Custom']], match?.id ?? 'custom');
  preset.style.width = '100%';
  const vt = numInput(3, 1, 20);
  const at = numInput(3, 1, 20);
  preset.addEventListener('change', () => {
    const p = SEQUENCE_PRESETS.find((x) => x.id === preset.value);
    if (!p) return;
    w.value = String(p.width);
    hh.value = String(p.height);
    fps.value = String(p.fps);
  });
  const custom = () => (preset.value = SEQUENCE_PRESETS.find((p) => String(p.width) === w.value && String(p.height) === hh.value && String(p.fps) === fps.value)?.id ?? 'custom');
  for (const el of [w, hh, fps]) el.addEventListener('change', custom);
  const swap = h('button', { class: 'btn small outline', onclick: () => {
    [w.value, hh.value] = [hh.value, w.value];
    custom();
  } }, 'Portrait / landscape');
  const body = h(
    'div',
    { class: 'form' },
    field('Name', name),
    field('Preset', preset),
    row(field('Width', w), field('Height', hh), swap, field('Frame rate', fps)),
    mode === 'new' ? row(field('Video tracks', vt), field('Audio tracks', at)) : h('p', { class: 'hint' }, 'Changing the size keeps clips where they are in the frame.'),
  );
  setTimeout(() => name.select(), 0);
  const ok = await dialog(mode === 'new' ? 'New sequence' : 'Sequence settings', body, [
    { label: mode === 'new' ? 'Create' : 'Change', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  // H.264 needs even sizes
  const W = Math.round(numValue(w, 1920) / 2) * 2;
  const H = Math.round(numValue(hh, 1080) / 2) * 2;
  const F = Number(fps.value) || 30;
  const n = name.value.trim() || 'Sequence';
  if (mode === 'new') {
    app.edit('New sequence', (_s, p) => {
      const s = newSequence(n, W, H, F, numValue(vt, 3), numValue(at, 3));
      p.sequences.push(s);
      p.active = s.id;
    });
    app.player.frame = 0;
    app.emit('sequence');
    app.player.refresh();
    return;
  }
  app.edit('Sequence settings', (s) => {
    if (W !== s.width || H !== s.height) rescale(s, W, H);
    // A different frame rate keeps clips at the same times
    if (F !== s.fps) {
      const k = F / s.fps;
      for (const t of [...s.video, ...s.audio])
        for (const c of t.clips) {
          c.start = Math.round(c.start * k);
          c.duration = Math.max(1, Math.round(c.duration * k));
          if (c.transIn) c.transIn.duration = Math.max(1, Math.round(c.transIn.duration * k));
          if (c.transOut) c.transOut.duration = Math.max(1, Math.round(c.transOut.duration * k));
        }
      for (const m of s.markers) m.f = Math.round(m.f * k);
      if (s.inPoint !== null) s.inPoint = Math.round(s.inPoint * k);
      if (s.outPoint !== null) s.outPoint = Math.round(s.outPoint * k);
    }
    s.name = n;
    s.width = W;
    s.height = H;
    s.fps = F;
  });
  app.emit('sequence');
}
