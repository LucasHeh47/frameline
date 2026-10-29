// Audio gain: louder or quieter by some dB, or normalized so the loudest moment reaches a level.
import { findClip, mediaOf, sourceTimeAt, type Clip } from '../../core/project';
import type { App } from '../app';
import { h } from '../dom';
import { dialog, toast } from '../widgets';

/** The loudest moment of a clip's part of its file, in dB (null until the waveform is read). */
function clipPeakDb(app: App, c: Clip): number | null {
  const m = mediaOf(app.project!, c);
  if (!m) return null;
  const peaks = app.library.peaksOf(m, c.stream ?? 0);
  if (!peaks) return null;
  const a = sourceTimeAt(c, c.start, app.fps);
  const b = sourceTimeAt(c, c.start + c.duration - 1, app.fps);
  let p = 0;
  for (let i = Math.floor(Math.min(a, b) * peaks.rate); i <= Math.ceil(Math.max(a, b) * peaks.rate) && i < peaks.data.length; i++) p = Math.max(p, peaks.data[Math.max(0, i)]);
  return p > 0 ? 20 * Math.log10(p / 255) : -96;
}

/** Shifts a clip's whole volume (keyframes too) by some dB. */
function shiftVolume(c: Clip, db: number): void {
  c.volume ??= { v: 0 };
  c.volume.v = Math.round((c.volume.v + db) * 10) / 10;
  for (const k of c.volume.keys ?? []) k.v = Math.round((k.v + db) * 10) / 10;
}

export function normalizeSelected(app: App, target: number): void {
  const list = app.selectedClips().filter((x) => x.clip.kind === 'audio');
  const changes: { id: string; db: number }[] = [];
  for (const { clip } of list) {
    const peak = clipPeakDb(app, clip);
    if (peak === null) {
      toast(`Still reading the sound of ${clip.name}. Try again in a moment.`);
      return;
    }
    // The clip's own volume already changes what's heard
    const now = peak + (clip.volume?.v ?? 0);
    changes.push({ id: clip.id, db: Math.max(-24, Math.min(24, target - now)) });
  }
  if (!changes.length) return;
  app.edit('Normalize audio', (s) => {
    for (const ch of changes) {
      const c = findClip(s, ch.id)?.clip;
      if (c) shiftVolume(c, ch.db);
    }
  });
  app.statusbar.flash(changes.length === 1 ? `Changed the volume by ${changes[0].db >= 0 ? '+' : ''}${changes[0].db.toFixed(1)} dB` : `Normalized ${changes.length} clips`);
}

export async function openAudioGain(app: App): Promise<void> {
  const list = app.selectedClips().filter((x) => x.clip.kind === 'audio');
  if (!list.length) return;
  let mode = 'adjust' as 'adjust' | 'normalize';
  const adjust = h('input', { class: 'input', type: 'number', min: -48, max: 48, step: 0.5, value: '0', style: { width: '90px' } }) as HTMLInputElement;
  const target = h('input', { class: 'input', type: 'number', min: -40, max: 0, step: 0.5, value: '-1', style: { width: '90px' } }) as HTMLInputElement;
  const radio = (value: 'adjust' | 'normalize', label: string, input: HTMLInputElement) => {
    const r = h('input', { type: 'radio', name: 'gain', checked: value === mode }) as HTMLInputElement;
    r.addEventListener('change', () => (mode = value));
    input.addEventListener('focus', () => {
      r.checked = true;
      mode = value;
    });
    return h('label', { class: 'check' }, r, h('span', null, label), input, h('span', { class: 'hint' }, 'dB'));
  };
  const peaks = list.map((x) => clipPeakDb(app, x.clip)).filter((p): p is number => p !== null);
  const body = h(
    'div',
    { class: 'form' },
    radio('adjust', 'Make it louder or quieter by', adjust),
    radio('normalize', 'Normalize the loudest moment to', target),
    peaks.length ? h('p', { class: 'hint' }, `Loudest moment now: ${Math.max(...peaks).toFixed(1)} dB. 0 dB is the most there is; −1 leaves a little room.`) : null,
  );
  const ok = await dialog(list.length > 1 ? `Audio gain (${list.length} clips)` : 'Audio gain', body, [
    { label: 'OK', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  if (mode === 'normalize') return normalizeSelected(app, Number(target.value) || -1);
  const db = Number(adjust.value) || 0;
  if (!db) return;
  app.edit(`Audio gain ${db > 0 ? '+' : ''}${db} dB`, (s) => {
    for (const { clip } of list) {
      const c = findClip(s, clip.id)?.clip;
      if (c) shiftVolume(c, db);
    }
  });
}
