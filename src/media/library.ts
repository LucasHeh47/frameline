// What Frameline knows about each media file while it runs: whether it's there, its thumbnails
// (for the Project panel and the timeline's filmstrips), its waveform, and decoded stills. Thumbnails
// and waveforms are made in the background, one file at a time, and kept on disk for next time.
import { AudioBufferSink, CanvasSink } from 'mediabunny';
import type { MediaItem } from '../core/project';
import { platform } from '../ui/platform';
import { openInput } from './probe';

export interface Thumbs {
  /** Media seconds of each thumbnail. */
  times: number[];
  sheet: ImageBitmap;
  cellW: number;
  cellH: number;
  cols: number;
}

export interface Peaks {
  /** Peaks per second. */
  rate: number;
  /** 0–255 loudest sample in each slot. */
  data: Uint8Array;
}

const PEAK_RATE = 100;
const THUMB_W = 160;

/** A short, stable name for a file's cached data (changes when the file does). */
function cacheKey(kind: string, m: MediaItem): string {
  let h = 0x811c9dc5;
  for (const ch of `${m.path.toLowerCase()}|${m.size ?? 0}|${m.modified ?? 0}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${kind}-${h.toString(16)}-${(m.size ?? 0).toString(36)}`;
}

export class MediaLibrary {
  private thumbs = new Map<string, Thumbs>();
  private peaks = new Map<string, Peaks>();
  private stills = new Map<string, ImageBitmap>();
  private loading = new Set<string>();
  private queue: { m: MediaItem; job: 'thumbs' | 'peaks' | 'still' }[] = [];
  private busy = false;
  /** Files that aren't where the project says (they need relinking). */
  readonly missing = new Set<string>();
  /** Files that are there but can't be read. */
  readonly broken = new Map<string, string>();
  private listeners = new Set<(mediaId: string) => void>();

  /** Something new arrived for a media item (thumbnails, a waveform, a still). */
  onChange(fn: (mediaId: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(id: string): void {
    for (const l of this.listeners) l(id);
  }

  thumbsOf(m: MediaItem): Thumbs | null {
    const t = this.thumbs.get(m.id);
    if (!t) this.request(m, 'thumbs');
    return t ?? null;
  }

  peaksOf(m: MediaItem): Peaks | null {
    const p = this.peaks.get(m.id);
    if (!p && m.hasAudio) this.request(m, 'peaks');
    return p ?? null;
  }

  /** An image file, decoded (null until it's ready). */
  stillOf(m: MediaItem): ImageBitmap | null {
    const s = this.stills.get(m.id);
    if (!s) this.request(m, 'still');
    return s ?? null;
  }

  /** Decodes an image file now (an export waits for it). */
  async loadStill(m: MediaItem): Promise<ImageBitmap | null> {
    const have = this.stills.get(m.id);
    if (have) return have;
    try {
      await this.makeStill(m);
      this.emit(m.id);
    } catch {
      return null;
    }
    return this.stills.get(m.id) ?? null;
  }

  /** The thumbnail nearest a media time: the sheet and the rectangle in it. */
  thumbAt(m: MediaItem, time: number): { sheet: ImageBitmap; sx: number; sy: number; sw: number; sh: number } | null {
    if (m.kind === 'image') {
      const s = this.stillOf(m);
      return s ? { sheet: s, sx: 0, sy: 0, sw: s.width, sh: s.height } : null;
    }
    const t = this.thumbsOf(m);
    if (!t || !t.times.length) return null;
    let best = 0;
    for (let i = 1; i < t.times.length; i++) if (Math.abs(t.times[i] - time) < Math.abs(t.times[best] - time)) best = i;
    return { sheet: t.sheet, sx: (best % t.cols) * t.cellW, sy: Math.floor(best / t.cols) * t.cellH, sw: t.cellW, sh: t.cellH };
  }

  /** Forgets what was made for a media item (after relinking it to another file). */
  forget(id: string): void {
    this.thumbs.delete(id);
    this.peaks.delete(id);
    this.stills.get(id)?.close();
    this.stills.delete(id);
    this.missing.delete(id);
    this.broken.delete(id);
    for (const k of [...this.loading]) if (k.startsWith(`${id}:`)) this.loading.delete(k);
  }

  private request(m: MediaItem, job: 'thumbs' | 'peaks' | 'still'): void {
    const k = `${m.id}:${job}`;
    if (this.loading.has(k) || this.missing.has(m.id) || this.broken.has(m.id)) return;
    if (job === 'thumbs' && m.kind !== 'video') return;
    if (job === 'still' && m.kind !== 'image') return;
    this.loading.add(k);
    // Stills are needed to show the picture, so they go first
    if (job === 'still') this.queue.unshift({ m, job });
    else this.queue.push({ m, job });
    void this.work();
  }

  private async work(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const { m, job } = this.queue.shift()!;
        try {
          if (job === 'still') await this.makeStill(m);
          else if (job === 'thumbs') await this.makeThumbs(m);
          else await this.makePeaks(m);
          this.emit(m.id);
        } catch (err) {
          console.warn(`Couldn't make ${job} for ${m.name}:`, err);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async makeStill(m: MediaItem): Promise<void> {
    const res = await fetch(platform.mediaUrl(m.path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'from-image' });
    this.stills.set(m.id, bmp);
  }

  private async makeThumbs(m: MediaItem): Promise<void> {
    const key = cacheKey('thumbs', m);
    const cached = await platform.cache.get(key);
    if (cached && cached.length > 8) {
      const headLen = new DataView(cached.buffer, cached.byteOffset).getUint32(0);
      const head = JSON.parse(new TextDecoder().decode(cached.subarray(4, 4 + headLen))) as Omit<Thumbs, 'sheet'>;
      const sheet = await createImageBitmap(new Blob([cached.slice(4 + headLen)], { type: 'image/jpeg' }));
      this.thumbs.set(m.id, { ...head, sheet });
      return;
    }
    const input = openInput(m.path);
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return;
      const n = Math.max(6, Math.min(120, Math.ceil(m.duration / 2)));
      const times = Array.from({ length: n }, (_, i) => Math.min(m.duration - 0.05, ((i + 0.5) / n) * m.duration));
      const aspect = m.width && m.height ? m.height / m.width : 9 / 16;
      const cellW = THUMB_W;
      const cellH = Math.max(1, Math.round(THUMB_W * aspect));
      const cols = 12;
      const sheetCanvas = new OffscreenCanvas(cellW * Math.min(cols, n), cellH * Math.ceil(n / cols));
      const ctx = sheetCanvas.getContext('2d')!;
      const sink = new CanvasSink(track, { width: cellW, height: cellH, fit: 'cover', poolSize: 2 });
      let i = 0;
      const got: number[] = [];
      for await (const c of sink.canvasesAtTimestamps(times)) {
        if (c) {
          ctx.drawImage(c.canvas, (i % cols) * cellW, Math.floor(i / cols) * cellH);
          got.push(times[i]);
        } else got.push(times[i]);
        i++;
        // A first look is useful before every thumbnail is made
        if (i === Math.min(4, n)) {
          this.thumbs.set(m.id, { times: got.slice(), sheet: await createImageBitmap(sheetCanvas), cellW, cellH, cols });
          this.emit(m.id);
        }
      }
      const sheet = await createImageBitmap(sheetCanvas);
      const thumbs = { times: got, sheet, cellW, cellH, cols };
      this.thumbs.set(m.id, thumbs);
      const jpeg = new Uint8Array(await (await sheetCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer());
      const head = new TextEncoder().encode(JSON.stringify({ times: got, cellW, cellH, cols }));
      const out = new Uint8Array(4 + head.length + jpeg.length);
      new DataView(out.buffer).setUint32(0, head.length);
      out.set(head, 4);
      out.set(jpeg, 4 + head.length);
      void platform.cache.put(key, out);
    } finally {
      input.dispose();
    }
  }

  private async makePeaks(m: MediaItem): Promise<void> {
    const key = cacheKey('peaks', m);
    const cached = await platform.cache.get(key);
    if (cached?.length) {
      this.peaks.set(m.id, { rate: PEAK_RATE, data: cached });
      return;
    }
    const input = openInput(m.path);
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) return;
      const slots = Math.max(1, Math.ceil(m.duration * PEAK_RATE));
      const data = new Uint8Array(slots);
      const sink = new AudioBufferSink(track);
      let shown = 0;
      for await (const { buffer, timestamp } of sink.buffers()) {
        const sr = buffer.sampleRate;
        const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
        const len = buffer.length;
        const perSlot = sr / PEAK_RATE;
        let slot = Math.floor(timestamp * PEAK_RATE);
        let next = (slot + 1 - timestamp * PEAK_RATE) * perSlot;
        let peak = 0;
        for (let i = 0; i < len; i++) {
          for (const ch of chans) {
            const v = ch[i] < 0 ? -ch[i] : ch[i];
            if (v > peak) peak = v;
          }
          if (i >= next) {
            if (slot >= 0 && slot < slots) data[slot] = Math.max(data[slot], Math.min(255, Math.round(peak * 255)));
            slot++;
            next += perSlot;
            peak = 0;
          }
        }
        if (slot >= 0 && slot < slots) data[slot] = Math.max(data[slot], Math.min(255, Math.round(peak * 255)));
        // Show the waveform as it's made, every few seconds of audio
        if (timestamp - shown > 20) {
          shown = timestamp;
          this.peaks.set(m.id, { rate: PEAK_RATE, data });
          this.emit(m.id);
        }
      }
      this.peaks.set(m.id, { rate: PEAK_RATE, data });
      void platform.cache.put(key, data);
    } finally {
      input.dispose();
    }
  }
}
