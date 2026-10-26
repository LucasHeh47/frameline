// The project: imported media, bins, and sequences (timelines) with their tracks and clips. Plain
// data, saved as JSON in .frameline files. The edit functions in edit.ts change it.
import { anim, type Anim } from './anim';
import type { Effect, ParamValue } from './effects';

export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaItem {
  id: string;
  kind: MediaKind;
  name: string;
  /** Where the file is (absolute). */
  path: string;
  /** Seconds (0 for images). */
  duration: number;
  width: number;
  height: number;
  /** Frames per second of the video (0 for images and audio). */
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  channels: number;
  sampleRate: number;
  /** Degrees the file says to turn its frames (phone videos). */
  rotation?: number;
  /** When the file was last changed (to notice a different file at the same place). */
  modified?: number;
  size?: number;
  /** The bin it's in (none: the top of the project). */
  bin?: string;
  label?: string;
}

export interface Bin {
  id: string;
  name: string;
  parent?: string;
}

export interface Marker {
  id: string;
  /** Frame on the timeline. */
  f: number;
  name: string;
  color: string;
  comment?: string;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  locked: boolean;
  /** Video: hidden (the eye). Audio: muted. */
  muted: boolean;
  solo: boolean;
  /** Edits that shift clips (insert, ripple) move this track too. */
  syncLock: boolean;
  /** Audio tracks: level in dB and balance -100…100 (the Audio Track Mixer). */
  volume: number;
  pan: number;
  clips: Clip[];
}

export type ClipKind = 'video' | 'audio' | 'image' | 'title' | 'color' | 'adjustment';

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'darken' | 'lighten' | 'difference' | 'softLight' | 'hardLight' | 'colorDodge' | 'colorBurn';

export const BLEND_MODES: [BlendMode, string][] = [
  ['normal', 'Normal'],
  ['darken', 'Darken'],
  ['multiply', 'Multiply'],
  ['colorBurn', 'Color Burn'],
  ['lighten', 'Lighten'],
  ['screen', 'Screen'],
  ['colorDodge', 'Color Dodge'],
  ['add', 'Add (linear dodge)'],
  ['overlay', 'Overlay'],
  ['softLight', 'Soft Light'],
  ['hardLight', 'Hard Light'],
  ['difference', 'Difference'],
];

/** How a picture of a different size fits the frame before Motion scales it. */
export type Fit = 'fit' | 'fill' | 'stretch' | 'none';

export interface Motion {
  /** Position of the anchor point, in sequence pixels (the frame's center by default). */
  x: Anim;
  y: Anim;
  /** Percent. */
  scale: Anim;
  /** Width percent when the scale isn't uniform. */
  scaleW: Anim;
  uniform: boolean;
  /** Degrees, clockwise. */
  rotation: Anim;
  /** Anchor point, offset from the picture's center in its own (fitted) pixels. */
  ax: Anim;
  ay: Anim;
}

export interface Transition {
  type: string;
  /** Frames. */
  duration: number;
  /** Where it sits on the cut between two clips. */
  align: 'center' | 'start' | 'end';
  params?: Record<string, ParamValue>;
}

export interface TitleStyle {
  text: string;
  font: string;
  /** Pixels at the sequence's size. */
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  /** Line height as a multiple of the size. */
  lineHeight: number;
  /** Extra space between letters, in pixels. */
  tracking: number;
  stroke: string;
  strokeWidth: number;
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowDistance: number;
  box: boolean;
  boxColor: string;
  boxOpacity: number;
  boxPadding: number;
  /** Where the text's anchor is, as a fraction of the frame (0.5, 0.5 is the middle). */
  x: number;
  y: number;
}

export interface Clip {
  id: string;
  kind: ClipKind;
  mediaId?: string;
  name: string;
  /** First frame on the timeline. */
  start: number;
  /** Length in frames. */
  duration: number;
  /** Where it starts in its media, in seconds. */
  in: number;
  /** 1 = normal speed. */
  speed: number;
  reverse?: boolean;
  /** Frame hold: shows this media time (seconds) for the whole clip. */
  hold?: number;
  /** Clips with the same link move, trim and select together (a video and its sound). */
  linkId?: string;
  enabled: boolean;
  label?: string;
  // Picture
  fit?: Fit;
  motion?: Motion;
  opacity?: Anim;
  blend?: BlendMode;
  // Sound (dB, and balance -100…100)
  volume?: Anim;
  pan?: Anim;
  effects: Effect[];
  transIn?: Transition;
  transOut?: Transition;
  title?: TitleStyle;
  /** Color mattes. */
  color?: string;
}

export interface Sequence {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  /** V1 first (the bottom of the stack). */
  video: Track[];
  /** A1 first. */
  audio: Track[];
  markers: Marker[];
  inPoint: number | null;
  outPoint: number | null;
  /** Where the playhead was (restored when the project opens). */
  playhead: number;
  /** Master level in dB. */
  masterVolume: number;
}

export interface Project {
  app: 'frameline';
  version: 1;
  name: string;
  media: MediaItem[];
  bins: Bin[];
  sequences: Sequence[];
  /** The sequence open in the timeline. */
  active: string;
}

// ---------- ids ----------

let seq = 0;
/** A short id, unique in the project. */
export function uid(prefix = ''): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}${seq.toString(36)}`;
}

// ---------- making things ----------

export interface SequencePreset {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  fps: number;
}

export const SEQUENCE_PRESETS: SequencePreset[] = [
  { id: 'hd30', name: 'HD 1080p', description: '1920 × 1080, 30 fps. YouTube and most cameras.', width: 1920, height: 1080, fps: 30 },
  { id: 'hd60', name: 'HD 1080p 60', description: '1920 × 1080, 60 fps. Smooth motion, games.', width: 1920, height: 1080, fps: 60 },
  { id: 'hd24', name: 'HD 1080p Film', description: '1920 × 1080, 24 fps. A cinematic look.', width: 1920, height: 1080, fps: 24 },
  { id: 'uhd30', name: '4K UHD', description: '3840 × 2160, 30 fps.', width: 3840, height: 2160, fps: 30 },
  { id: 'vertical', name: 'Vertical', description: '1080 × 1920, 30 fps. Shorts, Reels and TikTok.', width: 1080, height: 1920, fps: 30 },
  { id: 'square', name: 'Square', description: '1080 × 1080, 30 fps. Instagram posts.', width: 1080, height: 1080, fps: 30 },
  { id: 'hd720', name: 'HD 720p', description: '1280 × 720, 30 fps. Small files.', width: 1280, height: 720, fps: 30 },
];

export function newTrack(kind: TrackKind, n: number): Track {
  return { id: uid('t'), kind, name: `${kind === 'video' ? 'V' : 'A'}${n}`, locked: false, muted: false, solo: false, syncLock: true, volume: 0, pan: 0, clips: [] };
}

export function newSequence(name: string, width: number, height: number, fps: number, videoTracks = 3, audioTracks = 3): Sequence {
  return {
    id: uid('s'),
    name,
    width,
    height,
    fps,
    sampleRate: 48000,
    video: Array.from({ length: videoTracks }, (_, i) => newTrack('video', i + 1)),
    audio: Array.from({ length: audioTracks }, (_, i) => newTrack('audio', i + 1)),
    markers: [],
    inPoint: null,
    outPoint: null,
    playhead: 0,
    masterVolume: 0,
  };
}

export function newProject(name: string, preset: Pick<SequencePreset, 'width' | 'height' | 'fps'> = SEQUENCE_PRESETS[0]): Project {
  const s = newSequence('Sequence 01', preset.width, preset.height, preset.fps);
  return { app: 'frameline', version: 1, name, media: [], bins: [], sequences: [s], active: s.id };
}

export function defaultMotion(seq: Pick<Sequence, 'width' | 'height'>): Motion {
  return { x: anim(seq.width / 2), y: anim(seq.height / 2), scale: anim(100), scaleW: anim(100), uniform: true, rotation: anim(0), ax: anim(0), ay: anim(0) };
}

export const DEFAULT_TITLE: TitleStyle = {
  text: 'Your title',
  font: 'Segoe UI',
  size: 96,
  bold: true,
  italic: false,
  color: '#ffffff',
  align: 'center',
  lineHeight: 1.15,
  tracking: 0,
  stroke: '#000000',
  strokeWidth: 0,
  shadow: true,
  shadowColor: '#000000',
  shadowBlur: 12,
  shadowDistance: 4,
  box: false,
  boxColor: '#000000',
  boxOpacity: 60,
  boxPadding: 24,
  x: 0.5,
  y: 0.5,
};

/** Title styles offered when making a title (sizes are for a 1080-pixel-high sequence and scale). */
export const TITLE_PRESETS: { id: string; name: string; style: Partial<TitleStyle> }[] = [
  { id: 'center', name: 'Centered title', style: {} },
  { id: 'lower', name: 'Lower third', style: { text: 'Name Surname\nWhat they do', size: 54, align: 'left', x: 0.08, y: 0.8, box: true, boxOpacity: 70, shadow: false } },
  { id: 'subtitle', name: 'Subtitle', style: { text: 'Subtitle text', size: 48, bold: false, x: 0.5, y: 0.88, strokeWidth: 0, shadow: false, box: true, boxOpacity: 55, boxPadding: 14 } },
  { id: 'big', name: 'Big statement', style: { text: 'BIG NEWS', size: 180, tracking: 6, strokeWidth: 0, shadow: true, shadowBlur: 30 } },
  { id: 'corner', name: 'Corner label', style: { text: 'LIVE', size: 40, align: 'left', x: 0.05, y: 0.08, box: true, boxColor: '#e5383b', boxOpacity: 100, boxPadding: 14, shadow: false } },
];

export interface NewClipOptions {
  start: number;
  duration: number;
  fit?: Fit;
}

/** A clip of a media item (its picture, or with `audio` its sound). */
export function clipFromMedia(m: MediaItem, s: Sequence, o: NewClipOptions, part: 'video' | 'audio'): Clip {
  const base: Clip = { id: uid('c'), kind: part === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'video', mediaId: m.id, name: m.name, start: o.start, duration: o.duration, in: 0, speed: 1, enabled: true, effects: [] };
  if (part === 'audio') return { ...base, volume: anim(0), pan: anim(0) };
  return { ...base, fit: o.fit ?? 'fit', motion: defaultMotion(s), opacity: anim(100), blend: 'normal' };
}

/** Titles, color mattes and adjustment layers: clips without media. */
export function generatedClip(kind: 'title' | 'color' | 'adjustment', s: Sequence, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  const name = kind === 'title' ? 'Title' : kind === 'color' ? 'Color Matte' : 'Adjustment Layer';
  return { id: uid('c'), kind, name, start, duration, in: 0, speed: 1, enabled: true, effects: [], fit: 'none', motion: defaultMotion(s), opacity: anim(100), blend: 'normal', ...extra };
}

/** A title style scaled for the sequence (presets are made for 1080 pixels high). */
export function titleFor(s: Sequence, preset: Partial<TitleStyle> = {}): TitleStyle {
  const st = { ...DEFAULT_TITLE, ...preset };
  const k = Math.min(s.width, s.height) / 1080;
  return { ...st, size: Math.round(st.size * k), boxPadding: Math.round(st.boxPadding * k), shadowBlur: Math.round(st.shadowBlur * k), shadowDistance: Math.round(st.shadowDistance * k), tracking: Math.round(st.tracking * k) };
}

// ---------- reading ----------

export const clipEnd = (c: Clip) => c.start + c.duration;

export function allTracks(s: Sequence): Track[] {
  return [...s.video, ...s.audio];
}

export function findClip(s: Sequence, id: string): { clip: Clip; track: Track } | null {
  for (const t of allTracks(s)) {
    const clip = t.clips.find((c) => c.id === id);
    if (clip) return { clip, track: t };
  }
  return null;
}

export function trackOf(s: Sequence, id: string): Track | undefined {
  return allTracks(s).find((t) => t.id === id);
}

/** The last frame of the last clip. */
export function sequenceDuration(s: Sequence): number {
  let end = 0;
  for (const t of allTracks(s)) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function activeSequence(p: Project): Sequence {
  return p.sequences.find((s) => s.id === p.active) ?? p.sequences[0];
}

export function mediaOf(p: Project, c: Clip): MediaItem | undefined {
  return c.mediaId ? p.media.find((m) => m.id === c.mediaId) : undefined;
}

/** Clips sharing a link with this one (itself included). */
export function linkedClips(s: Sequence, c: Clip): Clip[] {
  if (!c.linkId) return [c];
  const out: Clip[] = [];
  for (const t of allTracks(s)) for (const x of t.clips) if (x.linkId === c.linkId) out.push(x);
  return out;
}

/** Seconds of media a clip uses. */
export function sourceSpan(c: Clip, fps: number): number {
  return (c.duration / fps) * c.speed;
}

/** Media seconds shown at a timeline frame (frames outside the clip continue its motion; used by transitions). */
export function sourceTimeAt(c: Clip, frame: number, fps: number): number {
  if (c.hold !== undefined) return c.hold;
  const local = frame - c.start;
  if (c.reverse) return c.in + ((c.duration - 1 - local) / fps) * c.speed;
  return c.in + (local / fps) * c.speed;
}

/** Whether this kind of clip runs out of media (titles, images and mattes can be any length). */
export function hasMediaLimit(c: Clip): boolean {
  return (c.kind === 'video' || c.kind === 'audio') && c.hold === undefined;
}

// ---------- saving ----------

export interface SavedProject extends Project {
  /** Media paths relative to the project file, to find them when the folder moved. */
  relative?: Record<string, string>;
}

/** Reads a saved project, filling in anything older files didn't have. */
export function readProject(json: string): Project {
  const p = JSON.parse(json) as Partial<SavedProject>;
  if (!p || p.app !== 'frameline' || !Array.isArray(p.sequences) || !p.sequences.length) throw new Error("This isn't a Frameline project.");
  if ((p.version ?? 1) > 1) throw new Error('This project was saved by a newer Frameline. Update Frameline to open it.');
  const sequences = p.sequences.map((s) => {
    const fix = (t: Track, kind: TrackKind): Track => ({ ...newTrack(kind, 1), ...t, kind, clips: (t.clips ?? []).map((c) => ({ ...c, enabled: c.enabled ?? true, speed: c.speed ?? 1, in: c.in ?? 0, effects: c.effects ?? [] })).sort((a, b) => a.start - b.start) });
    return {
      ...newSequence(s.name ?? 'Sequence', s.width ?? 1920, s.height ?? 1080, s.fps ?? 30, 0, 0),
      ...s,
      video: (s.video ?? []).map((t) => fix(t, 'video')),
      audio: (s.audio ?? []).map((t) => fix(t, 'audio')),
      markers: s.markers ?? [],
    };
  });
  return { app: 'frameline', version: 1, name: p.name ?? 'Untitled', media: p.media ?? [], bins: p.bins ?? [], sequences, active: sequences.some((s) => s.id === p.active) ? p.active! : sequences[0].id };
}

export function writeProject(p: Project, relative?: Record<string, string>): string {
  const out: SavedProject = { ...p };
  if (relative && Object.keys(relative).length) out.relative = relative;
  return JSON.stringify(out);
}
