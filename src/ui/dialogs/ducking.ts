// Auto-duck: the selected music gets quieter wherever other sound (usually speech) plays, with
// keyframes you can adjust afterwards on the clip's volume line.
import { valueAt } from '../../core/anim';
import { activeRanges, duckKeys } from '../../core/ducking';
import { clipEnd, findClip, mediaOf, sourceTimeAt } from '../../core/project';
import { audibleTracks, clipGain } from '../../core/timeline';
import type { App } from '../app';
import { h } from '../dom';
import { dialog, toast } from '../widgets';
import { field, row } from './common';

export async function autoDuck(app: App): Promise<void> {
  const s = app.seq;
  const music = app.selectedClips().filter((x) => x.clip.kind === 'audio');
  if (!music.length) return;
  const musicIds = new Set(music.map((m) => m.clip.id));
  const voices = audibleTracks(s).flatMap((t) => t.clips.filter((c) => c.enabled && !musicIds.has(c.id)));
  if (!voices.length) {
    toast('There’s no other sound to duck under. Put the voice (or other sound) on another audio track first.');
    return;
  }
  const depth = h('input', { class: 'input', type: 'number', min: 1, max: 40, step: 1, value: '12', style: { width: '80px' } }) as HTMLInputElement;
  const fade = h('input', { class: 'input', type: 'number', min: 0.05, max: 3, step: 0.05, value: '0.4', style: { width: '80px' } }) as HTMLInputElement;
  const sens = h('input', { type: 'range', class: 'ctl-range', min: 1, max: 10, step: 1, value: '5' }) as HTMLInputElement;
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'hint' }, `The selected ${music.length === 1 ? 'clip gets' : `${music.length} clips get`} quieter wherever other sound plays (${voices.length} clip${voices.length === 1 ? '' : 's'} on other tracks), with keyframes on the volume line you can change afterwards.`),
    row(field('Lower by (dB)', depth), field('Fade (seconds)', fade)),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Sensitivity (higher reacts to quieter sound)'), sens),
  );
  const ok = await dialog('Auto-duck music', body, [
    { label: 'Duck', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  const fps = s.fps;
  const from = Math.min(...music.map((m) => m.clip.start));
  const to = Math.max(...music.map((m) => clipEnd(m.clip)));
  // How loud the other sound is on each frame (0–1), from the waveforms
  const levels = new Float32Array(Math.max(0, to - from));
  for (const v of voices) {
    const m = mediaOf(app.project!, v);
    if (!m?.hasAudio) continue;
    const peaks = app.library.peaksOf(m);
    if (!peaks) {
      toast(`Still reading the sound of ${v.name}. Try again in a moment.`);
      return;
    }
    const a = Math.max(from, v.start);
    const b = Math.min(to, clipEnd(v));
    for (let f = a; f < b; f++) {
      const t = sourceTimeAt(v, f, fps);
      const i = Math.floor(t * peaks.rate);
      const p = Math.max(peaks.data[i] ?? 0, peaks.data[i + 1] ?? 0, peaks.data[i + 2] ?? 0) / 255;
      levels[f - from] = Math.max(levels[f - from], p * clipGain(v, f - v.start));
    }
  }
  // Sensitivity 1 hears only loud sound (−18 dB); 10 hears quiet sound (−45 dB)
  const threshold = Math.pow(10, (-15 - Number(sens.value) * 3) / 20);
  const ranges = activeRanges(levels, threshold, Math.round(fps * 0.6), Math.round(fps * 0.25)).map(([a, b]) => [a + from, b + from] as [number, number]);
  if (!ranges.length) {
    toast('No sound loud enough to duck under. Try a higher sensitivity.');
    return;
  }
  const dB = Math.max(1, Number(depth.value) || 12);
  const fadeFrames = Math.max(1, Math.round((Number(fade.value) || 0.4) * fps));
  app.edit('Auto-duck', (seq) => {
    for (const { clip } of music) {
      const c = findClip(seq, clip.id)?.clip;
      if (!c) continue;
      const base = valueAt(c.volume, 0, 0);
      const keys = duckKeys(ranges, c.start, c.duration, base, dB, fadeFrames);
      if (keys.length) c.volume = { v: base, keys };
    }
  });
  toast(`Ducked under ${ranges.length} part${ranges.length === 1 ? '' : 's'} with other sound.`, { kind: 'success' });
}
