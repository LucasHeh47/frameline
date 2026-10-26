// Subtitles: reading and writing SubRip (.srt) and WebVTT (.vtt) files. Captions become title clips
// on their own track, so they can be styled and moved like any title.

export interface Cue {
  /** Seconds. */
  start: number;
  end: number;
  text: string;
}

function parseTime(t: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(t.trim());
  if (!m) return null;
  const [, hh, mm, ss, ms] = m;
  return (parseInt(hh ?? '0', 10) * 60 + parseInt(mm, 10)) * 60 + parseInt(ss, 10) + (ms ? parseInt(ms.padEnd(3, '0'), 10) / 1000 : 0);
}

/** Reads .srt or .vtt text. Cues that can't be read are skipped. */
export function parseCaptions(text: string): Cue[] {
  const out: Cue[] = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const start = parseTime(a);
    // VTT cue settings follow the end time
    const end = parseTime((b ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null || end <= start) continue;
    const body = lines
      .slice(at + 1)
      .join('\n')
      // Formatting tags (<i>, <b>, <font>, VTT voice tags) are dropped
      .replace(/<[^>]+>/g, '')
      .trim();
    if (body) out.push({ start, end, text: body });
  }
  return out.sort((x, y) => x.start - y.start);
}

function stamp(s: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(ms / 3_600_000))}:${two(Math.floor(ms / 60_000) % 60)}:${two(Math.floor(ms / 1000) % 60)}${sep}${String(ms % 1000).padStart(3, '0')}`;
}

export function writeSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function writeVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n')}`;
}
