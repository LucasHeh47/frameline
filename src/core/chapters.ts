// YouTube chapters: "0:00 Intro" lines from markers, for a video's description.
import { clockTime } from './time';

export function chapterText(markers: { f: number; name: string }[], fps: number): string {
  const list = [...markers].sort((a, b) => a.f - b.f).map((m) => ({ t: m.f / fps, name: m.name.trim() }));
  // YouTube needs the first chapter at 0:00
  if (!list.length || list[0].t >= 1) list.unshift({ t: 0, name: 'Intro' });
  else list[0].t = 0;
  return list.map((c, i) => `${clockTime(Math.floor(c.t))} ${c.name || `Chapter ${i + 1}`}`).join('\n');
}
