// Scene edit detection: finds the cuts inside a video (where the picture changes all at once) and
// splits the clip there, so each shot can be moved or deleted on its own.
import { CanvasSink } from 'mediabunny';
import { razor } from '../../core/edit';
import { mediaOf, sourceTimeAt } from '../../core/project';
import { histogramDistance } from '../../core/analysis';
import { openInput } from '../../media/probe';
import type { App } from '../app';
import { h } from '../dom';
import { dialog, toast } from '../widgets';
import { progressDialog } from './common';

export async function detectScenes(app: App): Promise<void> {
  const sel = app.selectedClips().filter((x) => x.clip.kind === 'video');
  if (!sel.length) return;
  const sens = h('input', { type: 'range', min: 1, max: 10, step: 1, value: '5', class: 'ctl-range' }) as HTMLInputElement;
  const ok = await dialog(
    'Scene edit detection',
    h('div', { class: 'form' }, h('p', null, `Frameline looks through ${sel.length === 1 ? 'the clip' : `${sel.length} clips`} for cuts between shots and splits ${sel.length === 1 ? 'it' : 'them'} there.`), h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Sensitivity (higher finds more cuts)'), sens)),
    [
      { label: 'Find cuts', value: true, primary: true },
      { label: 'Cancel', value: false },
    ],
  );
  if (!ok) return;
  const threshold = 0.62 - Number(sens.value) * 0.05;
  const fps = app.fps;
  const cuts: number[] = [];
  const prog = progressDialog('Finding cuts', 'Stop');
  const ctx = new OffscreenCanvas(48, 27).getContext('2d', { willReadFrequently: true })!;
  try {
    for (const [n, { clip }] of sel.entries()) {
      const m = mediaOf(app.project!, clip);
      if (!m) continue;
      const input = openInput(m.path);
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) continue;
        // Every other frame is plenty to see a cut
        const frames: number[] = [];
        for (let f = clip.start; f < clip.start + clip.duration; f += 2) frames.push(f);
        const sink = new CanvasSink(track, { width: 48, height: 27, fit: 'fill', poolSize: 2 });
        let prev: Uint8ClampedArray | null = null;
        let i = 0;
        for await (const c of sink.canvasesAtTimestamps(frames.map((f) => sourceTimeAt(clip, f, fps) + 0.01))) {
          if (prog.canceled) break;
          if (c) {
            ctx.drawImage(c.canvas, 0, 0, 48, 27);
            const d = ctx.getImageData(0, 0, 48, 27).data;
            if (prev && histogramDistance(prev, d) > threshold) cuts.push(frames[i]);
            prev = new Uint8ClampedArray(d);
          }
          i++;
          if (i % 20 === 0) prog.set((n + i / frames.length) / sel.length, `Looking through ${clip.name}… ${cuts.length} cut${cuts.length === 1 ? '' : 's'} so far`);
        }
      } finally {
        input.dispose();
      }
      if (prog.canceled) break;
    }
  } finally {
    prog.close();
  }
  if (!cuts.length) {
    if (!prog.canceled) toast('No cuts found. Try a higher sensitivity.');
    return;
  }
  const ids = new Set(sel.map((x) => x.clip.id));
  app.edit(`Scene edit detection (${cuts.length} cut${cuts.length === 1 ? '' : 's'})`, (s) => {
    let n = 0;
    // From the end backwards: each cut splits off a right part, and the left part keeps the clip's id
    for (const f of [...cuts].sort((a, b) => b - a)) n += razor(s, f, ids);
    return n > 0;
  });
  toast(`Split at ${cuts.length} cut${cuts.length === 1 ? '' : 's'}.`, { kind: 'success' });
}
