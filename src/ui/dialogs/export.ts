// Export: the sequence (or its in-to-out part) to an MP4, WebM or MOV video, or to M4A / WAV sound,
// with presets for common sizes and a quality choice that sets a sensible bitrate. And Export Frame,
// a still of the playhead's frame.
import { canEncodeVideo } from 'mediabunny';
import { sequenceDuration } from '../../core/project';
import { shortDuration, timecode } from '../../core/time';
import { exportSequence, isAudioOnly, renderStill, type ExportFormat, type ExportSettings } from '../../media/export';
import type { App } from '../app';
import { h } from '../dom';
import { platform } from '../platform';
import { dialog, toast } from '../widgets';
import { checkbox, field, formatBytes, progressDialog, row, select } from './common';

const FORMATS: [ExportFormat, string, string][] = [
  ['mp4', 'MP4 (H.264)', 'Plays everywhere: YouTube, phones, TVs, every computer.'],
  ['webm', 'WebM (VP9)', 'Smaller files for the web.'],
  ['mov', 'QuickTime MOV (H.264)', 'For Apple software and other editors.'],
  ['m4a', 'M4A sound only (AAC)', 'Just the sound, compressed.'],
  ['wav', 'WAV sound only', 'Just the sound, uncompressed.'],
];

const QUALITY: [string, string, number][] = [
  ['low', 'Small file', 0.045],
  ['medium', 'Good', 0.08],
  ['high', 'High (recommended)', 0.12],
  ['max', 'Best', 0.2],
];

const LOUDNESS: [string, string][] = [
  ['off', 'As mixed'],
  ['-14', '−14 LUFS — YouTube, Spotify, Instagram, TikTok'],
  ['-16', '−16 LUFS — podcasts, Apple'],
  ['-23', '−23 LUFS — TV broadcast'],
];

interface Preset {
  id: string;
  name: string;
  format: ExportFormat;
  /** Short side in pixels, or 'match'. */
  size: string;
  quality: string;
  audioBitrate: string;
  loudness: string;
  /** Advice when the sequence's shape doesn't suit it. */
  shape?: 'vertical' | 'horizontal';
}

const PRESETS: Preset[] = [
  { id: 'youtube', name: 'YouTube 1080p', format: 'mp4', size: '1080', quality: 'high', audioBitrate: '192000', loudness: '-14', shape: 'horizontal' },
  { id: 'youtube4k', name: 'YouTube 4K', format: 'mp4', size: 'match', quality: 'high', audioBitrate: '256000', loudness: '-14', shape: 'horizontal' },
  { id: 'shorts', name: 'Shorts, Reels and TikTok (vertical 1080p)', format: 'mp4', size: '1080', quality: 'high', audioBitrate: '192000', loudness: '-14', shape: 'vertical' },
  { id: 'share', name: 'Small file to send (720p)', format: 'mp4', size: '720', quality: 'low', audioBitrate: '128000', loudness: 'off' },
  { id: 'master', name: 'Best quality master (MOV)', format: 'mov', size: 'match', quality: 'max', audioBitrate: '320000', loudness: 'off' },
  { id: 'podcast', name: 'Podcast or voice (M4A sound)', format: 'm4a', size: 'match', quality: 'high', audioBitrate: '128000', loudness: '-16' },
];

/** Bits per second for a quality at a size and frame rate (bits per pixel per frame). */
function bitrateFor(q: string, w: number, h: number, fps: number): number {
  const bpp = QUALITY.find((x) => x[0] === q)?.[2] ?? 0.12;
  return Math.round(Math.min(120e6, Math.max(1e6, w * h * fps * bpp)));
}

export async function openExport(app: App): Promise<void> {
  const s = app.seq;
  const dur = sequenceDuration(s);
  if (!dur) {
    toast('The sequence is empty — put some clips on the timeline first.');
    return;
  }
  app.player.pause();
  const last = (app.prefs.export ?? {}) as Partial<{ format: ExportFormat; size: string; fps: string; quality: string; audioBitrate: string; audio: boolean; loudness: string; preset: string }>;
  const short = Math.min(s.width, s.height);
  const presets = PRESETS.filter((p) => p.id !== 'youtube4k' || short >= 2160);
  const preset = select([['custom', 'Custom'], ...presets.map((p) => [p.id, p.name] as [string, string])], presets.some((p) => p.id === last.preset) ? last.preset! : 'custom');
  preset.style.width = '100%';
  const presetHint = h('p', { class: 'hint' });
  const loudness = select(LOUDNESS, LOUDNESS.some((x) => x[0] === last.loudness) ? last.loudness! : 'off');
  const format = select(FORMATS.map(([v, l]) => [v, l] as [string, string]), last.format ?? 'mp4');
  format.style.width = '100%';
  const formatHint = h('p', { class: 'hint' });
  const sizes: [string, string][] = [
    ['match', `Same as the sequence (${s.width} × ${s.height})`],
    // Smaller standard sizes (the short side: 1080p is 1920 × 1080, or 1080 × 1920 upright)
    ...[2160, 1440, 1080, 720, 480]
      .filter((p) => p < Math.min(s.width, s.height))
      .map((p) => [String(p), `${p}p (${s.width >= s.height ? `${Math.round((p * s.width) / s.height / 2) * 2} × ${p}` : `${p} × ${Math.round((p * s.height) / s.width / 2) * 2}`})`] as [string, string]),
  ];
  const size = select(sizes, sizes.some((x) => x[0] === last.size) ? last.size! : 'match');
  const rates: [string, string][] = [['match', `Same as the sequence (${Math.round(s.fps * 1000) / 1000})`], ['24', '24'], ['25', '25'], ['30', '30'], ['50', '50'], ['60', '60']];
  const fps = select(rates, last.fps ?? 'match');
  const quality = select(QUALITY.map(([v, l]) => [v, l] as [string, string]), last.quality ?? 'high');
  const audioRate = select([['128000', '128 kbps'], ['192000', '192 kbps'], ['256000', '256 kbps'], ['320000', '320 kbps']], last.audioBitrate ?? '192000');
  const audio = checkbox('Include sound', last.audio ?? true);
  const hasRange = s.inPoint !== null || s.outPoint !== null;
  const range = select<'all' | 'inout'>([['all', `The whole sequence (${shortDuration(dur, s.fps)})`], ...(hasRange ? [['inout', `In to out (${shortDuration((s.outPoint ?? dur) - (s.inPoint ?? 0), s.fps)})`] as ['inout', string]] : [])], hasRange ? 'inout' : 'all');
  const hw = checkbox('Use the graphics card (faster)', app.settings.bool('export.hardware'));
  const estimate = h('p', { class: 'export-estimate' });
  const videoFields = h('div', null, row(field('Size', size), field('Frame rate', fps)), row(field('Quality', quality)), hw.el);
  const settings = (): ExportSettings => {
    const f = format.value as ExportFormat;
    const p = size.value === 'match' ? 0 : Number(size.value);
    const portrait = s.height > s.width;
    let w = s.width;
    let hh = s.height;
    if (p) {
      if (portrait) {
        w = p;
        hh = Math.round((p * s.height) / s.width / 2) * 2;
      } else {
        hh = p;
        w = Math.round((p * s.width) / s.height / 2) * 2;
      }
    }
    w = Math.round(w / 2) * 2;
    hh = Math.round(hh / 2) * 2;
    const r = fps.value === 'match' ? s.fps : Number(fps.value);
    const a = range.value === 'inout' ? s.inPoint ?? 0 : 0;
    const b = range.value === 'inout' ? s.outPoint ?? dur : dur;
    return {
      format: f,
      width: w,
      height: hh,
      fps: r,
      videoBitrate: bitrateFor(quality.value, w, hh, r),
      audioBitrate: Number(audioRate.value),
      range: [a, Math.max(a + 1, b)],
      hardware: hw.input.checked ? 'no-preference' : 'prefer-software',
      audio: audio.input.checked || isAudioOnly(f),
      loudness: loudness.value === 'off' ? null : Number(loudness.value),
    };
  };
  preset.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === preset.value);
    if (!p) return update();
    format.value = p.format;
    // A smaller size only when the sequence is bigger than it
    size.value = sizes.some((x) => x[0] === p.size) ? p.size : 'match';
    quality.value = p.quality;
    audioRate.value = p.audioBitrate;
    loudness.value = p.loudness;
    if (!isAudioOnly(p.format)) audio.input.checked = true;
    update();
  });
  // Changing a setting by hand makes it a custom export
  for (const el of [format, size, fps, quality, audioRate, loudness])
    el.addEventListener('change', () => {
      const p = PRESETS.find((x) => x.id === preset.value);
      if (p && (format.value !== p.format || quality.value !== p.quality || audioRate.value !== p.audioBitrate || loudness.value !== p.loudness)) preset.value = 'custom';
      update();
    });
  function update(): void {
    const p = PRESETS.find((x) => x.id === preset.value);
    const vertical = s.height > s.width;
    presetHint.textContent =
      p?.shape === 'vertical' && !vertical
        ? 'Your sequence is horizontal, so the video would have black bars. Sequence › Reframe sequence makes a vertical copy.'
        : p?.shape === 'horizontal' && vertical
          ? 'Your sequence is vertical; YouTube shows it with bars at the sides (or as a Short when it is under 3 minutes).'
          : '';
    presetHint.hidden = !presetHint.textContent;
    const f = format.value as ExportFormat;
    formatHint.textContent = FORMATS.find((x) => x[0] === f)?.[2] ?? '';
    videoFields.hidden = isAudioOnly(f);
    audio.el.hidden = isAudioOnly(f);
    const st = settings();
    const secs = (st.range[1] - st.range[0]) / s.fps;
    const bits = (isAudioOnly(f) ? 0 : st.videoBitrate) + (st.audio ? (f === 'wav' ? 48000 * 16 * 2 : st.audioBitrate) : 0);
    estimate.textContent = `${timecode(st.range[1] - st.range[0], s.fps)} · ${isAudioOnly(f) ? '' : `${st.width} × ${st.height}, ${Math.round(st.fps * 100) / 100} fps, ${(st.videoBitrate / 1e6).toFixed(1)} Mbps · `}about ${formatBytes(Math.round((bits * secs) / 8))}`;
  }
  range.addEventListener('change', update);
  audio.input.addEventListener('change', update);
  update();
  const body = h(
    'div',
    { class: 'form export-form' },
    field('Preset', preset),
    presetHint,
    field('Format', format),
    formatHint,
    videoFields,
    row(field('Sound quality', audioRate), audio.el),
    field('Loudness', loudness, "Makes the whole video as loud as these sites expect, so it isn't turned down or too quiet"),
    field('What to export', range),
    estimate,
  );
  const ok = await dialog('Export', body, [
    { label: 'Export…', value: true, primary: true },
    { label: 'Cancel', value: false },
  ]);
  if (!ok) return;
  const st = settings();
  app.prefs.export = { format: st.format, size: size.value, fps: fps.value, quality: quality.value, audioBitrate: audioRate.value, audio: audio.input.checked, loudness: loudness.value, preset: preset.value };
  app.savePrefs();
  if (!isAudioOnly(st.format) && !(await canEncodeVideo(st.format === 'webm' ? 'vp9' : 'avc', { width: st.width, height: st.height }))) {
    toast(`This computer can't encode ${st.format === 'webm' ? 'VP9' : 'H.264'} video at ${st.width} × ${st.height}. Try a smaller size or another format.`, { kind: 'error' });
    return;
  }
  const path = await platform.saveDialog(`${s.name}.${st.format}`, st.format);
  if (!path) return;
  await run(app, st, path);
}

async function run(app: App, st: ExportSettings, path: string): Promise<void> {
  const prog = progressDialog('Exporting');
  const preview = h('canvas', { class: 'export-preview' }) as HTMLCanvasElement;
  if (!isAudioOnly(st.format)) prog.body.append(preview);
  const started = performance.now();
  let level: { measured: number; gain: number } | undefined;
  const ctrl = new AbortController();
  const watch = setInterval(() => {
    if (prog.canceled) ctrl.abort();
  }, 100);
  platform.keepAwake(true);
  try {
    const done = await exportSequence(
      app.project!,
      app.seq,
      st,
      path,
      app.library,
      (p) => {
        if (p.loudness) level = p.loudness;
        const secs = (performance.now() - started) / 1000;
        const left = p.fraction > 0.02 ? (secs / p.fraction) * (1 - p.fraction) : null;
        prog.set(p.fraction, `${Math.round(p.fraction * 100)}%${left !== null ? ` · about ${left < 60 ? `${Math.ceil(left)} s` : `${Math.ceil(left / 60)} min`} left` : ''}`);
        if (p.preview) {
          preview.width = p.preview.width;
          preview.height = p.preview.height;
          preview.getContext('2d')!.drawImage(p.preview, 0, 0);
        }
      },
      ctrl.signal,
    );
    prog.close();
    if (!done) {
      toast('Export canceled.');
      return;
    }
    const secs = Math.round((performance.now() - started) / 1000);
    const name = path.split(/[\\/]/).pop();
    const loudNote = level && Number.isFinite(level.measured) && Math.abs(level.gain) >= 0.1 ? ` The sound was ${level.measured.toFixed(1)} LUFS and was made ${Math.abs(level.gain).toFixed(1)} dB ${level.gain >= 0 ? 'louder' : 'quieter'}.` : '';
    toast(`Exported ${name} in ${secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60} s`}.${loudNote}`, { kind: 'success', ms: 9000, action: platform.isDesktop ? { label: 'Show in folder', run: () => platform.showInFolder(path) } : undefined });
    if (app.settings.bool('export.openFolder')) platform.showInFolder(path);
  } catch (err) {
    prog.close();
    console.error(err);
    const msg = (err as Error).message ?? String(err);
    // The graphics card's encoder can refuse some sizes; the computer's own one usually works
    if (st.hardware !== 'prefer-software' && /encod/i.test(msg)) {
      toast(`The graphics card couldn't encode this (${msg}). Trying again without it…`, { kind: 'error' });
      await run(app, { ...st, hardware: 'prefer-software' }, path);
      return;
    }
    toast(`Export failed: ${msg}`, { kind: 'error', ms: 12000 });
  } finally {
    clearInterval(watch);
    platform.keepAwake(false);
  }
}

export async function exportFrame(app: App): Promise<void> {
  const s = app.seq;
  const f = app.playhead;
  const path = await platform.saveDialog(`${s.name} ${timecode(f, s.fps).replace(/:/g, '.')}.png`, 'png');
  if (!path) return;
  try {
    const canvas = await renderStill(app.project!, s, f, app.library);
    const jpeg = /\.jpe?g$/i.test(path);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, jpeg ? 'image/jpeg' : 'image/png', 0.92));
    if (!blob) throw new Error("The frame couldn't be made.");
    const res = await platform.saveFile(path, new Uint8Array(await blob.arrayBuffer()));
    if (!res.ok) throw new Error(res.error);
    toast(`Saved the frame as ${path.split(/[\\/]/).pop()}.`, { kind: 'success', action: platform.isDesktop ? { label: 'Show in folder', run: () => platform.showInFolder(path) } : undefined });
  } catch (err) {
    app.error(err);
  }
}
