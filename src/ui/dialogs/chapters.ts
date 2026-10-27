// YouTube chapters from the sequence's markers: "0:00 Intro" lines to paste into a video's description.
import { chapterText } from '../../core/chapters';
import type { App } from '../app';
import { toast } from '../widgets';

export async function copyChapters(app: App): Promise<void> {
  const s = app.seq;
  if (!s.markers.length) {
    toast('Add markers (M) where each chapter starts, and name them in the Markers panel.');
    return;
  }
  const text = chapterText(s.markers, s.fps);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast("Couldn't copy to the clipboard.", { kind: 'error' });
    return;
  }
  const lines = text.split('\n');
  const starts = [...s.markers].map((m) => m.f / s.fps).sort((a, b) => a - b);
  const short = starts.some((t, i) => i > 0 && t - starts[i - 1] < 10);
  const advice = lines.length < 3 ? ' YouTube shows chapters when there are at least 3.' : short ? ' YouTube wants each chapter to be at least 10 seconds long.' : '';
  toast(`Copied ${lines.length} chapters. Paste them into your video's description.${advice}`, { kind: advice ? 'info' : 'success', ms: 8000 });
}
