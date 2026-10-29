// Reading what a media file is: video, audio or image, its length, size, frame rate and sound.
import { ALL_FORMATS, Input, UrlSource, type InputAudioTrack } from 'mediabunny';
import type { AudioStream, MediaItem, MediaKind } from '../core/project';
import type { MediaFileInfo } from '../shared/api';
import { platform } from '../ui/platform';

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;

export function openInput(path: string): Input {
  return new Input({ source: new UrlSource(platform.mediaUrl(path), { maxCacheSize: 32 * 1024 * 1024 }), formats: ALL_FORMATS });
}

export type ProbedMedia = Omit<MediaItem, 'id'>;

/** A file's sound tracks that can be played, in the file's order, with their tracks. */
async function soundTracks(input: Input): Promise<{ stream: AudioStream; track: InputAudioTrack }[]> {
  const out: { stream: AudioStream; track: InputAudioTrack }[] = [];
  const all = await input.getAudioTracks();
  for (const [index, track] of all.entries()) {
    if (!(await track.canDecode())) continue;
    // Files often name tracks after the program that wrote them ("SoundHandler"): number those instead
    const name = ((await track.getName()) ?? '').trim();
    const label = name && !/handler|^sound$|^audio$|^stereo$|^mono$/i.test(name) ? name : `Track ${index + 1}`;
    out.push({ stream: { id: track.id, index, name: label, channels: await track.getNumberOfChannels(), sampleRate: await track.getSampleRate() }, track });
  }
  return out;
}

/** The sound tracks of a file (for files imported before Frameline knew about several). */
export async function probeStreams(path: string): Promise<AudioStream[]> {
  const input = openInput(path);
  try {
    const list = await soundTracks(input);
    return list.length > 1 ? list.map((x) => x.stream) : [];
  } finally {
    input.dispose();
  }
}

/** One of a file's sound tracks (the first when it has one, or isn't told which). */
export async function soundTrackOf(input: Input, stream?: AudioStream): Promise<InputAudioTrack | null> {
  if (!stream) return input.getPrimaryAudioTrack();
  const all = await input.getAudioTracks();
  return all.find((t) => t.id === stream.id) ?? all[stream.index] ?? null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The picture couldn't be read."));
    img.src = url;
  });
}

export async function probeMedia(f: MediaFileInfo): Promise<ProbedMedia> {
  const base = { name: f.name, path: f.path, size: f.size, modified: f.modified };
  if (IMAGE.test(f.path)) {
    const img = await loadImage(platform.mediaUrl(f.path));
    return { ...base, kind: 'image', duration: 0, width: img.naturalWidth, height: img.naturalHeight, fps: 0, hasVideo: true, hasAudio: false, channels: 0, sampleRate: 0 };
  }
  const input = openInput(f.path);
  try {
    const [video, sounds] = await Promise.all([AUDIO.test(f.path) ? null : input.getPrimaryVideoTrack(), soundTracks(input)]);
    if (!video && !sounds.length) throw new Error(`${f.name} has no video or sound Frameline can use.`);
    if (video && !(await video.canDecode())) throw new Error(`${f.name} uses a video format (${(await video.getCodec()) ?? 'unknown'}) this computer can't play. Convert it to MP4 (H.264) first.`);
    const duration = await input.computeDuration();
    let width = 0;
    let height = 0;
    let fps = 0;
    let rotation = 0;
    if (video) {
      [width, height, rotation] = await Promise.all([video.getDisplayWidth(), video.getDisplayHeight(), video.getRotation()]);
      fps = (await video.computeFrameRateMetrics({ targetPacketCount: 120 }).catch(() => null))?.bestGuessFrameRate ?? 30;
      // Common rates come out like 29.97002997…; keep two decimals
      fps = Math.round(fps * 1000) / 1000;
    }
    const first = sounds[0]?.stream;
    const kind: MediaKind = video ? 'video' : 'audio';
    return {
      ...base,
      kind,
      duration,
      width,
      height,
      fps,
      rotation,
      hasVideo: !!video,
      hasAudio: !!first,
      channels: first?.channels ?? 0,
      sampleRate: first?.sampleRate ?? 0,
      // Screen recordings often keep game, microphone and music apart
      streams: sounds.length > 1 ? sounds.map((x) => x.stream) : [],
    };
  } finally {
    input.dispose();
  }
}
