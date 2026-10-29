// Beat markers: finds the beat of the selected music and puts markers on it, so cuts can snap to the
// music (Clip > Cut at markers makes them all at once).
import { detectBeats } from '../../core/audioAnalysis';
import { addMarker, MARKER_COLORS } from '../../core/edit';
import { clipEnd, linkedClips, mediaOf } from '../../core/project';
import type { App } from '../app';
import { h } from '../dom';
import { dialog, toast } from '../widgets';
import { field, select } from './common';

export async function beatMarkers(app: App): Promise<void> {
  const s = app.seq;
  const fps = s.fps;
  const pick = app.selectedClips().map(({ clip }) => linkedClips(s, clip).find((c) => c.kind === 'audio')).find(Boolean);
  if (!pick) {
    toast('Select the music (a clip with sound) to find its beat.');
    return;
  }
  if (pick.reverse || pick.hold !== undefined) {
    toast("The beat can't be found in reversed or frozen sound.");
    return;
  }
  const m = mediaOf(app.project!, pick);
  const peaks = m?.hasAudio ? app.library.peaksOf(m, pick.stream ?? 0) : null;
  if (!m || !peaks) {
    toast(`Still reading the sound of ${pick.name}. Try again in a moment.`);
    return;
  }
  // The part of the file the clip plays
  const a = Math.max(0, Math.floor(pick.in * peaks.rate));
  const b = Math.min(peaks.data.length, Math.ceil((pick.in + (pick.duration / fps) * pick.speed) * peaks.rate));
  const env = new Float32Array(Math.max(0, b - a));
  for (let i = 0; i < env.length; i++) env[i] = peaks.data[a + i] / 255;
  const found = detectBeats(env, peaks.rate);
  if (!found || found.beats.length < 2) {
    toast(`No steady beat found in ${pick.name}.`);
    return;
  }
  const toFrame = (t: number) => Math.round(pick.start + ((a / peaks.rate + t - pick.in) / pick.speed) * fps);
  const frames = found.beats.map(toFrame).filter((f) => f >= pick.start && f < clipEnd(pick));
  const every = select<'1' | '2' | '4' | '8'>(
    [
      ['1', `Every beat (${frames.length} markers)`],
      ['2', 'Every 2 beats'],
      ['4', 'Every bar of 4 beats'],
      ['8', 'Every 2 bars'],
    ],
    frames.length > 120 ? '4' : '1',
  );
  const color = select(
    MARKER_COLORS.map((c, i) => [String(i), ['Green', 'Red', 'Orange', 'Blue', 'Violet', 'Pink', 'White'][i]] as [string, string]),
    '3',
  );
  const body = h(
    'div',
    { class: 'form' },
    h('p', null, `${pick.name} is about `, h('strong', null, `${found.bpm} BPM`), '.'),
    h('p', { class: 'hint' }, 'Markers go on the beat; clips you drag or trim snap to them. Clip › Cut at markers then cuts the selected clips on every one.'),
    field('Markers', every),
    field('Color', color),
  );
  const ok = await dialog('Add beat markers', body, [
    { label: 'Add markers', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  const step = Number(every.value);
  const chosen = frames.filter((_, i) => i % step === 0);
  const c = MARKER_COLORS[Number(color.value)] ?? MARKER_COLORS[3];
  app.edit('Add beat markers', (seq) => {
    for (const f of chosen) addMarker(seq, f, '', c);
  });
  toast(`Added ${chosen.length} markers at ${found.bpm} BPM.`, { kind: 'success' });
}
