// Reading what a media file is: video, audio or image, its length, size, frame rate and sound.
import { ALL_FORMATS, Input, UrlSource } from 'mediabunny';
import type { MediaItem, MediaKind } from '../core/project';
import type { MediaFileInfo } from '../shared/api';
import { platform } from '../ui/platform';

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;

export function openInput(path: string): Input {
  return new Input({ source: new UrlSource(platform.mediaUrl(path), { maxCacheSize: 32 * 1024 * 1024 }), formats: ALL_FORMATS });
}

export type ProbedMedia = Omit<MediaItem, 'id'>;

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
    const [video, audio] = await Promise.all([AUDIO.test(f.path) ? null : input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (!video && !audio) throw new Error(`${f.name} has no video or sound Frameline can use.`);
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
    const playableAudio = audio && (await audio.canDecode()) ? audio : null;
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
      hasAudio: !!playableAudio,
      channels: playableAudio ? await playableAudio.getNumberOfChannels() : 0,
      sampleRate: playableAudio ? await playableAudio.getSampleRate() : 0,
    };
  } finally {
    input.dispose();
  }
}
