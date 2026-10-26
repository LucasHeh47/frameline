// Frames, seconds and timecode. Timeline positions are whole frames of the sequence; media times
// (where a clip starts in its file) are seconds.

/** Frame rates offered for sequences, with their usual names. */
export const FRAME_RATES: [number, string][] = [
  [23.976, '23.976 fps (film, NTSC)'],
  [24, '24 fps (film)'],
  [25, '25 fps (PAL)'],
  [29.97, '29.97 fps (NTSC)'],
  [30, '30 fps'],
  [50, '50 fps'],
  [59.94, '59.94 fps'],
  [60, '60 fps'],
];

/** The frames counted in a timecode second (29.97 counts 30). */
export function timebase(fps: number): number {
  return Math.max(1, Math.round(fps));
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

export function secondsToFrames(seconds: number, fps: number): number {
  // A tiny nudge keeps 0.1 + 0.2-style float error from losing a frame
  return Math.floor(seconds * fps + 1e-6);
}

/** 00:01:02:15 (hours:minutes:seconds:frames). Negative times get a minus sign. */
export function timecode(frames: number, fps: number): string {
  const tb = timebase(fps);
  const neg = frames < 0;
  let f = Math.abs(Math.round(frames));
  const ff = f % tb;
  f = Math.floor(f / tb);
  const ss = f % 60;
  f = Math.floor(f / 60);
  const mm = f % 60;
  const hh = Math.floor(f / 60);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${two(hh)}:${two(mm)}:${two(ss)}:${two(ff)}`;
}

/** A short duration for labels: "4s", "1:05", "1:02:03", or "12f" under a second. */
export function shortDuration(frames: number, fps: number): string {
  const secs = frames / fps;
  if (secs < 1) return `${Math.round(frames)}f`;
  const s = Math.floor(secs);
  if (s < 60) return `${(Math.round(secs * 10) / 10).toString().replace(/\.0$/, '')}s`;
  const two = (n: number) => String(n).padStart(2, '0');
  if (s < 3600) return `${Math.floor(s / 60)}:${two(s % 60)}`;
  return `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

/** Seconds as m:ss (media durations in the Project panel). */
export function clockTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const two = (n: number) => String(n).padStart(2, '0');
  if (s >= 3600) return `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
  return `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/**
 * Reads typed timecode. Accepts "1:02:03:04", "02:03:04", "3:04" (seconds:frames), "45" (frames),
 * "+15" / "-1:00" (relative to `current`), and "2.5s" (seconds). Returns null when it can't be read.
 */
export function parseTimecode(text: string, fps: number, current = 0): number | null {
  const t = text.trim().replace(/[;.](?=\d+$)/, ':');
  if (!t) return null;
  const rel = /^[+-]/.test(t) ? (t[0] === '-' ? -1 : 1) : 0;
  const body = rel ? t.slice(1).trim() : t;
  let frames: number | null = null;
  const secs = /^(\d+(?:\.\d+)?)s$/i.exec(body);
  if (secs) frames = Math.round(parseFloat(secs[1]) * fps);
  else if (/^\d+(:\d+){0,3}$/.test(body)) {
    const parts = body.split(':').map((p) => parseInt(p, 10));
    const tb = timebase(fps);
    const [ff, ss = 0, mm = 0, hh = 0] = parts.reverse();
    frames = ((hh * 60 + mm) * 60 + ss) * tb + ff;
  }
  if (frames === null || !Number.isFinite(frames)) return null;
  return rel ? current + rel * frames : frames;
}
