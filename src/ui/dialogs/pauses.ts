// Remove pauses: jump cuts for talking videos. The quiet stretches in the selected clips' sound are
// taken out (with their picture), and everything after closes up.
import { silentRanges } from '../../core/audioAnalysis';
import { removeRanges } from '../../core/edit';
import { clipEnd, linkedClips, mediaOf, sourceTimeAt, type Clip } from '../../core/project';
import { clipGain } from '../../core/timeline';
import { shortDuration } from '../../core/time';
import type { App } from '../app';
import { h } from '../dom';
import { dialog, toast } from '../widgets';
import { field, numInput, numValue, row } from './common';

interface Group {
  /** A clip of the group (for removing). */
  id: string;
  /** The clip whose sound decides. */
  sound: Clip;
  /** Level per timeline frame of the sound clip, 0–1. */
  levels: Float32Array;
}

const toDb = (v: number) => (v <= 1e-5 ? -100 : 20 * Math.log10(v));

export async function removePauses(app: App): Promise<void> {
  const s = app.seq;
  const fps = s.fps;
  // One entry per clip and its linked clips, with the clip that has the sound
  const groups: Group[] = [];
  const seen = new Set<string>();
  for (const { clip } of app.selectedClips()) {
    if (seen.has(clip.id)) continue;
    const linked = linkedClips(s, clip);
    for (const l of linked) seen.add(l.id);
    const sound = linked.find((c) => c.kind === 'audio');
    if (!sound) continue;
    const m = mediaOf(app.project!, sound);
    if (!m?.hasAudio) continue;
    const peaks = app.library.peaksOf(m);
    if (!peaks) {
      toast(`Still reading the sound of ${sound.name}. Try again in a moment.`);
      return;
    }
    const levels = new Float32Array(sound.duration);
    for (let f = sound.start; f < clipEnd(sound); f++) {
      const t = sourceTimeAt(sound, f, fps);
      const a = Math.floor(t * peaks.rate);
      const b = Math.max(a + 1, Math.ceil((t + sound.speed / fps) * peaks.rate));
      let p = 0;
      for (let i = a; i < b; i++) p = Math.max(p, peaks.data[i] ?? 0);
      levels[f - sound.start] = (p / 255) * clipGain(sound, f - sound.start);
    }
    groups.push({ id: clip.id, sound, levels });
  }
  if (!groups.length) {
    toast('Select a clip with sound (someone talking) to take its pauses out.');
    return;
  }
  // A starting point between the background noise and the voice
  const all = groups.flatMap((g) => [...g.levels].map(toDb)).sort((a, b) => a - b);
  const floor = all[Math.floor(all.length * 0.1)];
  const voice = all[Math.floor(all.length * 0.9)];
  const auto = Math.round(Math.max(-60, Math.min(-12, floor + (voice - floor) * 0.35)));

  const threshold = numInput(auto, -80, -6, 1);
  const minPause = numInput(0.5, 0.1, 10, 0.1);
  const keep = numInput(0.15, 0, 2, 0.05);
  const summary = h('p', { class: 'hint pause-summary' });
  const ranges = () => {
    const thr = Math.pow(10, numValue(threshold, auto) / 20);
    const min = Math.max(1, Math.round(numValue(minPause, 0.5) * fps));
    const pad = Math.round(numValue(keep, 0.15) * fps);
    return groups.map((g) => silentRanges(g.levels, thr, Math.max(min, 2 * pad + 1), pad).map(([a, b]) => [a + g.sound.start, b + g.sound.start] as [number, number]));
  };
  const update = () => {
    const r = ranges().flat();
    const frames = r.reduce((n, [a, b]) => n + b - a, 0);
    summary.textContent = r.length ? `Finds ${r.length} pause${r.length === 1 ? '' : 's'}, ${shortDuration(frames, fps)} in all.` : 'No pauses that long and that quiet. Try a higher level or a shorter pause.';
  };
  for (const el of [threshold, minPause, keep]) el.addEventListener('input', update);
  update();
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'hint' }, `Takes out the quiet moments between what's said in ${groups.length === 1 ? 'the selected clip' : `${groups.length} clips`}, picture and sound, and closes the gaps. Everything after moves up.`),
    row(field('Quieter than (dB)', threshold, `Background noise is about ${Math.round(floor)} dB, speech about ${Math.round(voice)} dB`)),
    row(field('Pauses longer than (seconds)', minPause), field('Keep around words (seconds)', keep)),
    summary,
  );
  const ok = await dialog('Remove pauses', body, [
    { label: 'Remove pauses', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  const found = ranges();
  const count = found.flat().length;
  if (!count) return;
  let removed = 0;
  app.edit('Remove pauses', (seq) => {
    // Later clips first, so the earlier ones' positions stay right
    const order = groups.map((g, i) => ({ g, r: found[i] })).sort((a, b) => b.g.sound.start - a.g.sound.start);
    for (const { g, r } of order) removed += removeRanges(seq, new Set([g.id]), r);
    return removed > 0;
  });
  if (removed) toast(`Took out ${count} pause${count === 1 ? '' : 's'} (${shortDuration(removed, fps)}). Undo brings them back.`, { kind: 'success' });
}
