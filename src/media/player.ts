// Playing a sequence: a video element per clip on screen, kept in step with the playhead, and the
// sound of each clip through Web Audio (its volume, balance and effects, then its track's level and
// the master level, with meters). The compositor draws the elements' current frames.
import type { Effect } from '../core/effects';
import { clipStream, mediaOf, sequenceDuration, sourceTimeAt, type AudioStream, type Clip, type MediaItem, type Project, type Sequence, type Track } from '../core/project';
import { audioAt, dbToGain, videoAt } from '../core/timeline';
import type { Picture, PictureProvider } from '../render/compositor';
import { platform } from '../ui/platform';
import { buildChain, clipLevels, sameChain, type FxChain } from './audioGraph';
import type { MediaLibrary } from './library';

export interface PlayerHost {
  project(): Project;
  seq(): Sequence;
  library: MediaLibrary;
}

interface VideoVoice {
  el: HTMLVideoElement;
  path: string;
  /** The time last asked for while paused. */
  asked: number;
}

interface AudioVoice {
  el: HTMLAudioElement;
  path: string;
  /** The file's sound track it plays (files with several), or '' for the file's own choice. */
  stream: string;
  source: MediaElementAudioSourceNode;
  fx: FxChain;
  effects: Effect[];
  gain: GainNode;
  pan: StereoPannerNode;
  track: string;
}

interface Bus {
  gain: GainNode;
  pan: StereoPannerNode;
  meters: [AnalyserNode, AnalyserNode];
}

interface SoundTrackList {
  length: number;
  [i: number]: { id: string; enabled: boolean };
}

/** Makes a media element play one of its file's sound tracks (and none of the others). */
function chooseSoundTrack(el: HTMLMediaElement, s: AudioStream): void {
  const list = (el as HTMLMediaElement & { audioTracks?: SoundTrackList }).audioTracks;
  if (!list?.length) return;
  let want = -1;
  for (let i = 0; i < list.length; i++) if (list[i].id === String(s.id)) want = i;
  if (want < 0) want = Math.min(s.index, list.length - 1);
  for (let i = 0; i < list.length; i++) list[i].enabled = i === want;
}

/** A tiny bit past the frame's start, so the frame itself is shown (not the one before). */
const nudge = (m: MediaItem | undefined) => 0.25 / Math.max(1, m?.fps || 30);

export class Player implements PictureProvider {
  frame = 0;
  playing = false;
  rate = 1;
  /** Play the in-to-out range over and over. */
  loop = false;
  private range: [number, number] | null = null;
  private anchorFrame = 0;
  private anchorTime = 0;
  private raf = 0;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterMeters: [AnalyserNode, AnalyserNode] | null = null;
  private buses = new Map<string, Bus>();
  private videos = new Map<string, VideoVoice>();
  private audios = new Map<string, AudioVoice>();
  private videoPool: { path: string; el: HTMLVideoElement }[] = [];
  private audioPool: { path: string; stream: string; el: HTMLAudioElement; source: MediaElementAudioSourceNode }[] = [];
  private renderQueued = false;
  /** Called on every frame while playing, and after seeks: redraw the monitor and the playhead. */
  onFrame: ((frame: number) => void) | null = null;
  /** Playback stopped by itself (the end was reached). */
  onStop: (() => void) | null = null;

  constructor(private host: PlayerHost) {}

  private audio(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
      this.master = this.ctx.createGain();
      const split = this.ctx.createChannelSplitter(2);
      this.masterMeters = [this.ctx.createAnalyser(), this.ctx.createAnalyser()];
      this.master.connect(this.ctx.destination);
      this.master.connect(split);
      split.connect(this.masterMeters[0], 0);
      split.connect(this.masterMeters[1], 1);
      for (const m of this.masterMeters) m.fftSize = 1024;
    }
    return this.ctx;
  }

  private bus(t: Track): Bus {
    let b = this.buses.get(t.id);
    if (!b) {
      const ctx = this.audio();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const split = ctx.createChannelSplitter(2);
      const meters: [AnalyserNode, AnalyserNode] = [ctx.createAnalyser(), ctx.createAnalyser()];
      for (const m of meters) m.fftSize = 1024;
      gain.connect(pan);
      pan.connect(this.master!);
      pan.connect(split);
      split.connect(meters[0], 0);
      split.connect(meters[1], 1);
      b = { gain, pan, meters };
      this.buses.set(t.id, b);
    }
    return b;
  }

  // ---------- transport ----------

  get duration(): number {
    return sequenceDuration(this.host.seq());
  }

  /** Plays forward (rate > 0) or backward; `range` limits it (plays in to out). */
  play(rate = 1, range: [number, number] | null = null): void {
    const ctx = this.audio();
    void ctx.resume();
    this.range = range;
    if (range && (this.frame < range[0] || this.frame >= range[1] - 1)) this.frame = range[0];
    else if (!range && rate > 0 && this.frame >= this.duration - 1) this.frame = 0;
    this.rate = rate;
    this.playing = true;
    this.anchorFrame = this.frame;
    this.anchorTime = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    platform.keepAwake(true);
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.frame = Math.round(this.frame);
    for (const v of this.audios.values()) v.el.pause();
    for (const v of this.videos.values()) v.el.pause();
    this.sync(this.frame);
    this.onFrame?.(this.frame);
    platform.keepAwake(false);
  }

  /** Moves the playhead (stops playing first only when asked). */
  seek(frame: number): void {
    const f = Math.max(0, Math.round(frame));
    if (this.playing) {
      this.frame = f;
      this.anchorFrame = f;
      this.anchorTime = performance.now();
      return;
    }
    this.frame = f;
    this.sync(f);
    this.requestFrame();
  }

  /** The sequence changed (an edit, undo…): show the new state. */
  refresh(): void {
    if (!this.playing) this.sync(Math.round(this.frame));
    this.requestFrame();
  }

  requestFrame(): void {
    if (this.renderQueued || this.playing) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.onFrame?.(this.frame);
    });
  }

  private tick = (): void => {
    if (!this.playing) return;
    const seq = this.host.seq();
    let f = this.anchorFrame + ((performance.now() - this.anchorTime) / 1000) * seq.fps * this.rate;
    const [start, end] = this.range ?? [0, Math.max(1, this.duration)];
    if (this.rate > 0 && f >= end) {
      if (this.loop) {
        f = start;
        this.anchorFrame = start;
        this.anchorTime = performance.now();
      } else {
        this.frame = end - (this.range ? 1 : 0);
        this.pause();
        this.onStop?.();
        return;
      }
    } else if (this.rate < 0 && f <= start) {
      this.frame = start;
      this.pause();
      this.onStop?.();
      return;
    }
    this.frame = f;
    this.sync(Math.floor(f));
    this.onFrame?.(f);
    this.raf = requestAnimationFrame(this.tick);
  };

  // ---------- keeping media in step ----------

  private sync(f: number): void {
    const project = this.host.project();
    const seq = this.host.seq();
    const media = (c: Clip) => mediaOf(project, c);
    const playing = this.playing;
    // Pictures on screen now, and (while playing) about to be
    const want = new Map<string, { clip: Clip; time: number; now: boolean }>();
    for (const l of videoAt(seq, f, media)) for (const cf of [l.a, l.b]) if (cf?.clip.kind === 'video') want.set(cf.clip.id, { clip: cf.clip, time: cf.time, now: true });
    if (playing && this.rate > 0) {
      const ahead = f + Math.round(seq.fps * 0.6 * this.rate);
      for (const l of videoAt(seq, ahead, media)) {
        for (const cf of [l.a, l.b]) {
          if (cf?.clip.kind !== 'video' || want.has(cf.clip.id)) continue;
          // Ready at its first frame before it's reached
          const first = Math.max(cf.clip.start, f);
          const at = videoAt(seq, first, media).flatMap((x) => [x.a, x.b]).find((x) => x?.clip === cf.clip);
          want.set(cf.clip.id, { clip: cf.clip, time: at?.time ?? cf.time, now: false });
        }
      }
    }
    // Before its media starts or after it ends (a transition with no handle), a clip holds its frame
    const inMedia = (c: Clip) => {
      const m = media(c);
      if (!m || c.hold !== undefined || c.kind === 'image') return true;
      const raw = sourceTimeAt(c, f, seq.fps);
      return raw >= 0 && raw < m.duration;
    };
    for (const [id, v] of this.videos) if (!want.has(id)) this.releaseVideo(id, v);
    for (const w of want.values()) this.syncVideo(w.clip, w.time, playing && w.now && inMedia(w.clip));

    // Sound plays only while playing forward
    const voices = playing && this.rate > 0 ? audioAt(seq, f, media) : [];
    const heard = new Set(voices.map((v) => v.clip.id));
    for (const [id, a] of this.audios) if (!heard.has(id)) this.releaseAudio(id, a);
    if (!voices.length && !this.audios.size) return;
    const ctx = this.audio();
    for (const t of seq.audio) {
      const b = this.bus(t);
      b.gain.gain.setTargetAtTime(dbToGain(t.volume), ctx.currentTime, 0.03);
      b.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, t.pan / 100)), ctx.currentTime, 0.03);
    }
    this.master!.gain.setTargetAtTime(dbToGain(seq.masterVolume), ctx.currentTime, 0.03);
    for (const v of voices) this.syncAudio(v.clip, v.track, v.time, v.local, v.fade, media(v.clip), inMedia(v.clip));
  }

  private syncVideo(clip: Clip, time: number, playing: boolean): void {
    const m = mediaOf(this.host.project(), clip);
    if (!m || this.host.library.missing.has(m.id)) return;
    let v = this.videos.get(clip.id);
    if (v && v.path !== m.path) {
      this.releaseVideo(clip.id, v);
      v = undefined;
    }
    v ??= this.allocVideo(clip.id, m.path);
    const el = v.el;
    const t = time + nudge(m);
    const forward = playing && this.rate > 0 && !clip.reverse && clip.hold === undefined;
    if (forward) {
      const r = Math.max(0.0625, Math.min(16, clip.speed * this.rate));
      if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
      if (el.paused) {
        if (Math.abs(el.currentTime - t) > 0.05) el.currentTime = t;
        void el.play().catch(() => undefined);
      } else if (Math.abs(el.currentTime - t) > 0.3 * Math.max(1, r)) el.currentTime = t;
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(v.asked - t) > 1e-4 || Math.abs(el.currentTime - t) > 0.5 / Math.max(1, m.fps || 30)) {
        v.asked = t;
        if (Math.abs(el.currentTime - t) > 1e-4) el.currentTime = t;
      }
    }
  }

  private allocVideo(id: string, path: string): VideoVoice {
    const i = this.videoPool.findIndex((p) => p.path === path);
    let el: HTMLVideoElement;
    if (i >= 0) el = this.videoPool.splice(i, 1)[0].el;
    else {
      el = document.createElement('video');
      el.muted = true;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.playsInline = true;
      el.disableRemotePlayback = true;
      // A new frame after seeking or loading: draw again
      el.addEventListener('seeked', () => this.requestFrame());
      el.addEventListener('loadeddata', () => this.requestFrame());
      el.src = platform.mediaUrl(path);
    }
    const v: VideoVoice = { el, path, asked: -1 };
    this.videos.set(id, v);
    return v;
  }

  private releaseVideo(id: string, v: VideoVoice): void {
    this.videos.delete(id);
    v.el.pause();
    this.videoPool.push({ path: v.path, el: v.el });
    // Keep a few loaded files for quick reuse; let the rest go
    while (this.videoPool.length > 8) {
      const old = this.videoPool.shift()!;
      old.el.removeAttribute('src');
      old.el.load();
    }
  }

  private syncAudio(clip: Clip, track: Track, time: number, local: number, fade: number, m: MediaItem | undefined, inMedia: boolean): void {
    if (!m || !m.hasAudio || this.host.library.missing.has(m.id) || clip.reverse || clip.hold !== undefined) return;
    const ctx = this.audio();
    const stream = clipStream(m, clip);
    const streamKey = stream ? String(stream.id) : '';
    let a = this.audios.get(clip.id);
    if (a && (a.path !== m.path || a.track !== track.id || a.stream !== streamKey)) {
      this.releaseAudio(clip.id, a);
      a = undefined;
    }
    if (a && !sameChain(a.effects, clip.effects)) {
      a.source.disconnect();
      a.fx.dispose();
      a.fx = buildChain(ctx, clip.effects);
      a.source.connect(a.fx.input);
      a.fx.output.connect(a.gain);
    }
    a ??= this.allocAudio(clip, track, m.path, stream);
    a.effects = clip.effects;
    a.fx.update(local);
    const lv = clipLevels(clip.volume, clip.pan, local);
    a.gain.gain.setTargetAtTime(lv.gain * fade, ctx.currentTime, 0.015);
    a.pan.pan.setTargetAtTime(lv.pan, ctx.currentTime, 0.015);
    const el = a.el;
    if (!inMedia) {
      // Silent until its first moment (it starts from there on time)
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - time) > 0.01) el.currentTime = time;
      return;
    }
    const r = Math.max(0.0625, Math.min(16, clip.speed * this.rate));
    if (Math.abs(el.playbackRate - r) > 1e-3) el.playbackRate = r;
    if (el.paused) {
      el.currentTime = time;
      void el.play().catch(() => undefined);
    } else if (Math.abs(el.currentTime - time) > 0.12 * Math.max(1, r)) el.currentTime = time;
  }

  private allocAudio(clip: Clip, track: Track, path: string, stream?: AudioStream): AudioVoice {
    const ctx = this.audio();
    const key = stream ? String(stream.id) : '';
    const i = this.audioPool.findIndex((p) => p.path === path && p.stream === key);
    let el: HTMLAudioElement;
    let source: MediaElementAudioSourceNode;
    if (i >= 0) ({ el, source } = this.audioPool.splice(i, 1)[0]);
    else {
      el = new Audio();
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      // Speed changes the pitch, as it does in the export
      el.preservesPitch = false;
      if (stream) {
        // A file with several sound tracks: this element plays just the clip's one
        const pick = () => chooseSoundTrack(el, stream);
        el.addEventListener('loadedmetadata', pick);
      }
      el.src = platform.mediaUrl(path);
      source = ctx.createMediaElementSource(el);
    }
    const fx = buildChain(ctx, clip.effects);
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    source.connect(fx.input);
    fx.output.connect(gain);
    gain.connect(pan);
    pan.connect(this.bus(track).gain);
    const a: AudioVoice = { el, path, stream: key, source, fx, effects: clip.effects, gain, pan, track: track.id };
    this.audios.set(clip.id, a);
    return a;
  }

  private releaseAudio(id: string, a: AudioVoice): void {
    this.audios.delete(id);
    a.el.pause();
    a.source.disconnect();
    a.fx.dispose();
    a.gain.disconnect();
    a.pan.disconnect();
    this.audioPool.push({ path: a.path, stream: a.stream, el: a.el, source: a.source });
    while (this.audioPool.length > 8) {
      const old = this.audioPool.shift()!;
      old.el.removeAttribute('src');
      old.el.load();
    }
  }

  // ---------- pictures for the compositor ----------

  picture(clip: Clip, m: MediaItem | undefined, time: number): Picture | null {
    if (!m) return null;
    if (clip.kind === 'image' || m.kind === 'image') {
      const s = this.host.library.stillOf(m);
      return s ? { source: s, width: s.width, height: s.height, stillKey: m.id } : null;
    }
    let v = this.videos.get(clip.id);
    if (!v) {
      // Drawn without a sync (a still frame for export): load it and draw when ready
      this.syncVideo(clip, time, false);
      v = this.videos.get(clip.id);
    }
    if (!v || v.el.readyState < 2 || !v.el.videoWidth) return null;
    return { source: v.el, width: v.el.videoWidth, height: v.el.videoHeight };
  }

  // ---------- meters ----------

  private buf = new Float32Array(1024);

  private peak(a: AnalyserNode): number {
    const buf = this.buf;
    a.getFloatTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i] < 0 ? -buf[i] : buf[i];
      if (x > p) p = x;
    }
    return p;
  }

  /** Peak levels (0–1+) of each audio track and the master, left and right. */
  levels(): { tracks: Map<string, [number, number]>; master: [number, number] } {
    const tracks = new Map<string, [number, number]>();
    if (!this.ctx || !this.playing) return { tracks, master: [0, 0] };
    for (const [id, b] of this.buses) tracks.set(id, [this.peak(b.meters[0]), this.peak(b.meters[1])]);
    return { tracks, master: this.masterMeters ? [this.peak(this.masterMeters[0]), this.peak(this.masterMeters[1])] : [0, 0] };
  }

  /** Lets every file go (the project closed). */
  reset(): void {
    this.pause();
    for (const [id, v] of this.videos) this.releaseVideo(id, v);
    for (const [id, a] of this.audios) this.releaseAudio(id, a);
    for (const p of this.videoPool) {
      p.el.removeAttribute('src');
      p.el.load();
    }
    this.videoPool = [];
    for (const p of this.audioPool) {
      p.el.removeAttribute('src');
      p.el.load();
    }
    this.audioPool = [];
    this.frame = 0;
  }
}
