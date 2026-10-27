// Exporting a sequence: every frame drawn by the same compositor as the Program monitor (with exact
// frames decoded from the files), the sound mixed offline through the same effect chains, encoded by
// the computer's video encoder (WebCodecs) and written to disk as it goes.
import { AudioBufferSink, AudioBufferSource, CanvasSource, Input, Mp4OutputFormat, MovOutputFormat, Output, Quality, StreamTarget, VideoSampleSink, WavOutputFormat, WebMOutputFormat, type InputAudioTrack, type InputVideoTrack, type VideoSample } from 'mediabunny';
import { valueAt } from '../core/anim';
import { LoudnessMeter, normalizeGain, PeakLimiter } from '../core/audioAnalysis';
import { strParam } from '../core/effects';
import { allTracks, mediaOf, sourceTimeAt, type Clip, type MediaItem, type Project, type Sequence, type Track } from '../core/project';
import { activeRange, audibleTracks, audioFade, clipGain, dbToGain, videoAt } from '../core/timeline';
import { Compositor, type Picture, type PictureProvider } from '../render/compositor';
import { platform } from '../ui/platform';
import { buildChain } from './audioGraph';
import type { MediaLibrary } from './library';
import { openInput } from './probe';

export type ExportFormat = 'mp4' | 'webm' | 'mov' | 'm4a' | 'wav';

export interface ExportSettings {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  /** Bits per second. */
  videoBitrate: number;
  audioBitrate: number;
  /** Sequence frames [start, end). */
  range: [number, number];
  hardware: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  audio: boolean;
  /** Bring the sound to this loudness (LUFS), or leave it as mixed. */
  loudness?: number | null;
}

export interface ExportProgress {
  /** 0–1. */
  fraction: number;
  /** Output frames done / in all (or seconds of sound for audio-only exports). */
  done: number;
  total: number;
  /** A small picture of the frame being made, now and then. */
  preview?: HTMLCanvasElement;
  /** Once the sound is measured: its loudness (LUFS) and the gain (dB) applied to reach the target. */
  loudness?: { measured: number; gain: number };
}

export const isAudioOnly = (f: ExportFormat) => f === 'm4a' || f === 'wav';

/** Shared decoders for a file's video and sound during an export. */
class Sources {
  private inputs = new Map<string, Input>();
  private videoTracks = new Map<string, Promise<InputVideoTrack | null>>();
  private audioTracks = new Map<string, Promise<InputAudioTrack | null>>();

  private input(path: string): Input {
    let i = this.inputs.get(path);
    if (!i) {
      i = openInput(path);
      this.inputs.set(path, i);
    }
    return i;
  }

  video(path: string): Promise<InputVideoTrack | null> {
    let t = this.videoTracks.get(path);
    if (!t) {
      t = this.input(path).getPrimaryVideoTrack();
      this.videoTracks.set(path, t);
    }
    return t;
  }

  audio(path: string): Promise<InputAudioTrack | null> {
    let t = this.audioTracks.get(path);
    if (!t) {
      t = this.input(path).getPrimaryAudioTrack();
      this.audioTracks.set(path, t);
    }
    return t;
  }

  dispose(): void {
    for (const i of this.inputs.values()) i.dispose();
    this.inputs.clear();
  }
}

/**
 * Exact frames for the export: for each clip, the media times it shows (known in advance from the
 * timeline) are decoded in order, one frame at a time as the export reaches them.
 */
class ExportPictures implements PictureProvider {
  private iters = new Map<string, AsyncGenerator<VideoSample | null>>();
  private current = new Map<string, VideoSample>();

  constructor(
    private project: Project,
    private seq: Sequence,
    private library: MediaLibrary,
    private sources: Sources,
    /** Every clip's media times, in the order they're needed. */
    private plan: Map<string, number[]>,
  ) {}

  /** Decodes the frames needed at a sequence frame. */
  async prepare(f: number): Promise<void> {
    for (const l of videoAt(this.seq, f, (c) => mediaOf(this.project, c))) {
      for (const cf of [l.a, l.b]) {
        if (!cf) continue;
        const m = mediaOf(this.project, cf.clip);
        if (!m) continue;
        if (m.kind === 'image') {
          await this.library.loadStill(m);
          continue;
        }
        if (cf.clip.kind !== 'video') continue;
        let it = this.iters.get(cf.clip.id);
        if (!it) {
          const track = await this.sources.video(m.path);
          if (!track) continue;
          it = new VideoSampleSink(track).samplesAtTimestamps(this.plan.get(cf.clip.id) ?? []);
          this.iters.set(cf.clip.id, it);
        }
        const next = await it.next();
        const s = next.done ? null : next.value;
        if (s) {
          this.current.get(cf.clip.id)?.close();
          this.current.set(cf.clip.id, s);
        }
      }
    }
  }

  picture(clip: Clip, m: MediaItem | undefined, _time: number): Picture | null {
    if (!m) return null;
    if (m.kind === 'image') {
      const s = this.library.stillOf(m);
      return s ? { source: s, width: s.width, height: s.height, stillKey: m.id } : null;
    }
    const s = this.current.get(clip.id);
    if (!s) return null;
    const rot = ((s.rotation ?? 0) / 90) & 3;
    return { source: s.toCanvasImageSource(), width: s.displayWidth, height: s.displayHeight, rotation: rot };
  }

  dispose(): void {
    for (const s of this.current.values()) s.close();
    this.current.clear();
    for (const it of this.iters.values()) void it.return(undefined);
    this.iters.clear();
  }
}

/** The media times of every video clip for the output frames, in order. */
function planFrames(project: Project, seq: Sequence, frames: number[]): Map<string, number[]> {
  const plan = new Map<string, number[]>();
  for (const f of frames) {
    for (const l of videoAt(seq, f, (c) => mediaOf(project, c))) {
      for (const cf of [l.a, l.b]) {
        if (!cf || cf.clip.kind !== 'video') continue;
        const m = mediaOf(project, cf.clip);
        let list = plan.get(cf.clip.id);
        if (!list) plan.set(cf.clip.id, (list = []));
        list.push(cf.time + 0.25 / Math.max(1, m?.fps || seq.fps));
      }
    }
  }
  return plan;
}

/** The sequence frame shown at each output frame. */
function outputFrames(seq: Sequence, s: ExportSettings): number[] {
  const [a, b] = s.range;
  const n = Math.max(1, Math.round(((b - a) / seq.fps) * s.fps));
  return Array.from({ length: n }, (_, i) => Math.min(b - 1, a + Math.floor((i * seq.fps) / s.fps + 1e-6)));
}

function lutPaths(seq: Sequence): string[] {
  const out = new Set<string>();
  for (const t of seq.video) for (const c of t.clips) for (const e of c.effects) if (e.type === 'lumetri' && strParam(e, 'lut')) out.add(strParam(e, 'lut'));
  return [...out];
}

// ---------- sound ----------

const RATE = 48000;
const WINDOW = 10;
const PREROLL = 1;

/** Decoded sound of a file between two media times, as one buffer starting at `start`. */
async function decodeRange(track: InputAudioTrack, from: number, to: number): Promise<{ buffer: AudioBuffer; start: number } | null> {
  const parts: { buffer: AudioBuffer; timestamp: number }[] = [];
  for await (const w of new AudioBufferSink(track).buffers(Math.max(0, from), to)) parts.push(w);
  if (!parts.length) return null;
  const sr = parts[0].buffer.sampleRate;
  const channels = Math.min(2, Math.max(...parts.map((p) => p.buffer.numberOfChannels)));
  const start = parts[0].timestamp;
  const end = parts[parts.length - 1].timestamp + parts[parts.length - 1].buffer.duration;
  const len = Math.max(1, Math.ceil((end - start) * sr));
  const out = new AudioBuffer({ length: len, numberOfChannels: channels, sampleRate: sr });
  for (const p of parts) {
    const at = Math.round((p.timestamp - start) * sr);
    for (let c = 0; c < channels; c++) {
      const src = p.buffer.getChannelData(Math.min(c, p.buffer.numberOfChannels - 1));
      out.copyToChannel(src.subarray(0, Math.max(0, Math.min(src.length, len - at))), c, Math.max(0, at));
    }
  }
  return { buffer: out, start };
}

function reversed(b: AudioBuffer): AudioBuffer {
  const out = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate });
  for (let c = 0; c < b.numberOfChannels; c++) out.copyToChannel(b.getChannelData(c).slice().reverse(), c);
  return out;
}

/**
 * Mixes the sequence's sound between two seconds (relative to the sequence's start). The mix starts
 * a little early so reverbs and echoes carry over from the window before; that part is cut off.
 */
async function mixWindow(project: Project, seq: Sequence, sources: Sources, t0: number, t1: number, gainDb = 0): Promise<AudioBuffer> {
  const pre = Math.min(PREROLL, t0);
  const start = t0 - pre;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.max(1, Math.round((t1 - start) * RATE)), sampleRate: RATE });
  const master = ctx.createGain();
  master.gain.value = dbToGain(seq.masterVolume) * Math.pow(10, gainDb / 20);
  master.connect(ctx.destination);
  const fps = seq.fps;
  const f0 = Math.floor(start * fps);
  const f1 = Math.ceil(t1 * fps);
  const at = (f: number) => f / fps - start;
  for (const t of audibleTracks(seq)) {
    const bus = ctx.createGain();
    bus.gain.value = dbToGain(t.volume);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, t.pan / 100));
    bus.connect(pan);
    pan.connect(master);
    for (const c of t.clips) {
      if (!c.enabled) continue;
      const m = mediaOf(project, c);
      if (!m?.hasAudio || c.hold !== undefined) continue;
      const [ra, rb] = activeRange(t, c);
      const fa = Math.max(ra, f0);
      const fb = Math.min(rb, f1);
      if (fb <= fa) continue;
      await scheduleClip(ctx, sources, seq, t, c, m, fa, fb, at, bus);
    }
  }
  const out = await ctx.startRendering();
  if (pre <= 0) return out;
  // Drop the pre-roll
  const skip = Math.round(pre * RATE);
  const len = Math.max(1, out.length - skip);
  const cut = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: RATE });
  for (let ch = 0; ch < 2; ch++) cut.copyToChannel(out.getChannelData(ch).subarray(skip, skip + len), ch);
  return cut;
}

async function scheduleClip(ctx: OfflineAudioContext, sources: Sources, seq: Sequence, t: Track, c: Clip, m: MediaItem, fa: number, fb: number, at: (f: number) => number, bus: AudioNode): Promise<void> {
  const fps = seq.fps;
  const track = await sources.audio(m.path);
  if (!track) return;
  const ta = sourceTimeAt(c, fa, fps);
  const tb = sourceTimeAt(c, fb, fps);
  const lo = Math.max(0, Math.min(ta, tb) - 0.05);
  const hi = Math.min(m.duration, Math.max(ta, tb) + 0.05);
  if (hi <= lo) return;
  const dec = await decodeRange(track, lo, hi);
  if (!dec) return;
  const node = ctx.createBufferSource();
  // Reversed clips play their sound backwards
  node.buffer = c.reverse ? reversed(dec.buffer) : dec.buffer;
  node.playbackRate.value = c.speed;
  const bufEnd = dec.start + dec.buffer.duration;
  // A transition can start before the media does (no handle): the sound waits for its first moment
  // instead of starting early and running out of step with the picture
  const first = c.reverse ? Math.min(ta, bufEnd) : Math.max(ta, dec.start);
  const wait = Math.abs(first - ta) / c.speed;
  const offset = c.reverse ? bufEnd - first : first - dec.start;
  const fx = buildChain(ctx, c.effects);
  const gain = ctx.createGain();
  const pan = ctx.createStereoPanner();
  node.connect(fx.input);
  fx.output.connect(gain);
  gain.connect(pan);
  pan.connect(bus);
  // Volume, fades and balance, frame by frame
  const level = (f: number) => clipGain(c, f - c.start) * audioFade(t, c, f);
  gain.gain.setValueAtTime(level(fa), Math.max(0, at(fa)));
  for (let f = fa + 1; f <= fb; f++) gain.gain.linearRampToValueAtTime(level(Math.min(f, fb - 1)), Math.max(0, at(f)));
  pan.pan.value = Math.max(-1, Math.min(1, valueAt(c.pan, fa - c.start, 0) / 100));
  if (c.pan?.keys?.length) for (let f = fa + 1; f <= fb; f++) pan.pan.linearRampToValueAtTime(Math.max(-1, Math.min(1, valueAt(c.pan, f - c.start, 0) / 100)), Math.max(0, at(f)));
  fx.automate((local) => Math.max(0, at(local + c.start)), fa - c.start, fb - c.start);
  const when = Math.max(0, at(fa) + wait);
  node.start(when, Math.max(0, offset), Math.max(0.01, ((fb - fa) / fps) * c.speed - wait * c.speed + 0.01));
}

// ---------- the export ----------

function target(handle: number): StreamTarget {
  let queue = Promise.resolve();
  return new StreamTarget(
    new WritableStream({
      write(chunk) {
        queue = queue.then(() => platform.exportStream.write(handle, chunk.position, chunk.data));
        return queue;
      },
    }),
    { chunked: true, chunkSize: 4 * 1024 * 1024 },
  );
}

/** Exports a sequence to a file. Throws on failure; returns false when canceled. */
export async function exportSequence(project: Project, seq: Sequence, s: ExportSettings, path: string, library: MediaLibrary, onProgress: (p: ExportProgress) => void, signal: AbortSignal): Promise<boolean> {
  const handle = await platform.exportStream.open(path);
  if (handle === null) throw new Error("Frameline can't write there.");
  const sources = new Sources();
  const audioOnly = isAudioOnly(s.format);
  const format = s.format === 'webm' ? new WebMOutputFormat() : s.format === 'mov' ? new MovOutputFormat({ fastStart: false }) : s.format === 'wav' ? new WavOutputFormat() : new Mp4OutputFormat({ fastStart: false });
  const output = new Output({ format, target: target(handle) });
  let canvas: HTMLCanvasElement | null = null;
  let compositor: Compositor | null = null;
  let pictures: ExportPictures | null = null;
  let ok = false;
  try {
    const frames = audioOnly ? [] : outputFrames(seq, s);
    let video: CanvasSource | null = null;
    if (!audioOnly) {
      canvas = document.createElement('canvas');
      canvas.width = s.width;
      canvas.height = s.height;
      compositor = new Compositor(canvas, (p) => platform.readText(p));
      await compositor.preload(lutPaths(seq));
      video = new CanvasSource(canvas, {
        codec: s.format === 'webm' ? 'vp9' : 'avc',
        quality: new Quality({ bitrate: s.videoBitrate }),
        keyFrameInterval: 2,
        hardwareAcceleration: s.hardware,
        sizeChangeBehavior: 'contain',
      });
      output.addVideoTrack(video, { frameRate: s.fps });
      pictures = new ExportPictures(project, seq, library, sources, planFrames(project, seq, frames));
    }
    const hasSound = s.audio && allTracks(seq).some((t) => t.kind === 'audio' && t.clips.length);
    let audio: AudioBufferSource | null = null;
    if (hasSound || audioOnly) {
      audio = new AudioBufferSource(s.format === 'wav' ? { codec: 'pcm-s16' } : { codec: s.format === 'webm' ? 'opus' : 'aac', quality: new Quality({ bitrate: s.audioBitrate }) });
      output.addAudioTrack(audio);
    }
    await output.start();
    const t0 = s.range[0] / seq.fps;
    const t1 = s.range[1] / seq.fps;
    const total = audioOnly ? t1 - t0 : frames.length;
    // Even loudness: the whole mix is measured first, then made louder or quieter by one amount
    let gainDb = 0;
    const measureShare = audio && s.loudness != null ? (audioOnly ? 0.5 : 0.1) : 0;
    if (audio && s.loudness != null) {
      const meter = new LoudnessMeter(RATE, 2);
      for (let w = t0; w < t1 - 1e-6; w += WINDOW) {
        if (signal.aborted) throw new DOMException('canceled', 'AbortError');
        const we = Math.min(t1, w + WINDOW);
        const b = await mixWindow(project, seq, sources, w, we);
        meter.add([b.getChannelData(0), b.getChannelData(1)]);
        onProgress({ fraction: ((we - t0) / (t1 - t0)) * measureShare, done: 0, total });
      }
      const measured = meter.lufs;
      gainDb = normalizeGain(measured, s.loudness);
      onProgress({ fraction: measureShare, done: 0, total, loudness: { measured, gain: gainDb } });
    }
    const share = (x: number) => measureShare + x * (1 - measureShare);
    // Made louder, the peaks are held under -1 dB so nothing clips
    const limiter = audio && s.loudness != null ? new PeakLimiter(RATE, 2, Math.pow(10, -1 / 20)) : null;
    let limited = 0;
    const addSound = async (b: AudioBuffer | null) => {
      if (!audio) return;
      if (!limiter) {
        if (b) await audio.add(b);
        return;
      }
      let out: Float32Array<ArrayBuffer>[] = (b ? limiter.process([b.getChannelData(0), b.getChannelData(1)]) : limiter.flush()) as Float32Array<ArrayBuffer>[];
      // The limiter runs a few milliseconds late: its first samples are dropped, and the end flushed out
      if (limited < limiter.delay) {
        const skip = Math.min(limiter.delay - limited, out[0].length);
        limited += skip;
        out = out.map((c) => c.subarray(skip) as Float32Array<ArrayBuffer>);
      }
      if (!out[0].length) return;
      const buf = new AudioBuffer({ length: out[0].length, numberOfChannels: 2, sampleRate: RATE });
      buf.copyToChannel(out[0], 0);
      buf.copyToChannel(out[1], 1);
      await audio.add(buf);
    };
    let i = 0;
    const preview = document.createElement('canvas');
    for (let w = t0; w < t1 - 1e-6; w += WINDOW) {
      const we = Math.min(t1, w + WINDOW);
      if (signal.aborted) throw new DOMException('canceled', 'AbortError');
      if (audio) await addSound(await mixWindow(project, seq, sources, w, we, gainDb));
      if (audioOnly) {
        onProgress({ fraction: share((we - t0) / (t1 - t0)), done: we - t0, total });
        continue;
      }
      // The frames in this window of time
      for (; i < frames.length && i / s.fps < we - t0 - 1e-6; i++) {
        if (signal.aborted) throw new DOMException('canceled', 'AbortError');
        const f = frames[i];
        await pictures!.prepare(f);
        compositor!.render({ project, seq, frame: f, scale: s.width / seq.width, provider: pictures! });
        await video!.add(i / s.fps, 1 / s.fps);
        if (i % 15 === 0) {
          preview.width = 320;
          preview.height = Math.round((320 * s.height) / s.width);
          preview.getContext('2d')!.drawImage(canvas!, 0, 0, preview.width, preview.height);
          onProgress({ fraction: share(i / total), done: i, total, preview });
        }
      }
    }
    await addSound(null);
    onProgress({ fraction: 1, done: total, total });
    await output.finalize();
    ok = true;
    return true;
  } catch (err) {
    if (output.state === 'started' || output.state === 'pending') await output.cancel().catch(() => undefined);
    if ((err as DOMException).name === 'AbortError') return false;
    throw err;
  } finally {
    pictures?.dispose();
    compositor?.dispose();
    sources.dispose();
    await platform.exportStream.close(handle, ok);
  }
}

/** One frame at full quality (Export Frame), drawn from exact decoded frames. */
export async function renderStill(project: Project, seq: Sequence, frame: number, library: MediaLibrary, scale = 1): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  const sources = new Sources();
  const compositor = new Compositor(canvas, (p) => platform.readText(p));
  const pictures = new ExportPictures(project, seq, library, sources, planFrames(project, seq, [frame]));
  try {
    await compositor.preload(lutPaths(seq));
    await pictures.prepare(frame);
    compositor.render({ project, seq, frame, scale, provider: pictures });
    // Copied to a plain canvas so it outlives the WebGL context
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    out.getContext('2d')!.drawImage(canvas, 0, 0);
    return out;
  } finally {
    pictures.dispose();
    compositor.dispose();
    sources.dispose();
  }
}
