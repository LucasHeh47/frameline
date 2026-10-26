// Captions: subtitle files (.srt, .vtt) become titles on a "Captions" track, styled like subtitles;
// and the titles on a track can be saved back out as a subtitle file.
import { addTrack, placeClips } from '../../core/edit';
import { parseCaptions, writeSrt, writeVtt, type Cue } from '../../core/captions';
import { TITLE_PRESETS, clipEnd, generatedClip, titleFor } from '../../core/project';
import { secondsToFrames } from '../../core/time';
import type { App } from '../app';
import { platform } from '../platform';
import { toast } from '../widgets';

export async function importCaptions(app: App): Promise<void> {
  const f = await platform.openTextDialog('captions');
  if (!f) return;
  const cues = parseCaptions(f.text);
  if (!cues.length) {
    toast(`No captions found in ${f.name}.`, { kind: 'error' });
    return;
  }
  const style = TITLE_PRESETS.find((p) => p.id === 'subtitle')!.style;
  app.edit(`Import captions (${cues.length})`, (s) => {
    const t = addTrack(s, 'video');
    t.name = 'Captions';
    placeClips(
      s,
      cues.map((c) => {
        const start = secondsToFrames(c.start, s.fps);
        const clip = generatedClip('title', s, start, Math.max(1, secondsToFrames(c.end, s.fps) - start), { title: titleFor(s, { ...style, text: c.text }), name: c.text.split('\n')[0].slice(0, 40) });
        return { track: t, clip };
      }),
      'overwrite',
    );
  });
  toast(`Added ${cues.length} captions on a new Captions track.`, { kind: 'success' });
}

export async function exportCaptions(app: App): Promise<void> {
  const s = app.seq;
  // The Captions track, or else the video track with the most titles
  const tracks = s.video.filter((t) => t.clips.some((c) => c.kind === 'title'));
  const track = tracks.find((t) => t.name === 'Captions') ?? tracks.sort((a, b) => b.clips.length - a.clips.length)[0];
  if (!track) {
    toast('There are no titles to save as captions. Import captions, or add titles on a track named Captions.');
    return;
  }
  const cues: Cue[] = track.clips.filter((c) => c.kind === 'title' && c.title && c.enabled).map((c) => ({ start: c.start / s.fps, end: clipEnd(c) / s.fps, text: c.title!.text.trim() }));
  const path = await platform.saveDialog(`${s.name}.srt`, 'srt');
  if (!path) return;
  const text = /\.vtt$/i.test(path) ? writeVtt(cues) : writeSrt(cues);
  const r = await platform.saveFile(path, text);
  if (r.ok) toast(`Saved ${cues.length} captions from ${track.name}.`, { kind: 'success' });
  else toast(r.error ?? "Couldn't save the captions.", { kind: 'error' });
}
