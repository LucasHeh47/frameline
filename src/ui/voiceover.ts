// Voice-over: records the microphone while the timeline plays from the playhead, then puts the
// recording on the audio track it was started from. Use headphones so the recording doesn't pick
// up the sound that's playing.
import type { App } from './app';
import { platform } from './platform';
import { toast } from './widgets';

export class VoiceOver {
  /** The track being recorded onto (null when not recording). */
  track: string | null = null;
  private start = 0;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private timer: number | undefined;
  private began = 0;

  constructor(private app: App) {}

  get recording(): boolean {
    return this.track !== null;
  }

  /** Starts recording onto a track, or stops when already recording. */
  async toggle(trackId: string): Promise<void> {
    if (this.recording) return this.stop();
    const app = this.app;
    const t = findTrack(app, trackId);
    if (!t || t.kind !== 'audio') return;
    if (t.locked) {
      toast(`${t.name} is locked. Unlock it to record onto it.`);
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false } });
    } catch (err) {
      toast(`The microphone couldn't be used: ${(err as Error).message}. Check that one is plugged in, and Windows' microphone privacy settings.`, { kind: 'error', ms: 10000 });
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    this.recorder = new MediaRecorder(this.stream, { mimeType: mime, audioBitsPerSecond: 160_000 });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.track = trackId;
    this.start = app.playhead;
    app.player.pause();
    this.recorder.start(250);
    this.began = performance.now();
    app.player.play(1);
    this.timer = window.setInterval(() => {
      const secs = Math.floor((performance.now() - this.began) / 1000);
      app.statusbar.hint(`● Recording voice-over on ${t.name} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} — press Space or the microphone button to stop`);
    }, 250);
    app.emit('project');
  }

  async stop(): Promise<void> {
    const app = this.app;
    const rec = this.recorder;
    const trackId = this.track;
    if (!rec || !trackId) return;
    clearInterval(this.timer);
    app.player.pause();
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.stop();
    await done;
    for (const tr of this.stream?.getTracks() ?? []) tr.stop();
    this.stream = null;
    this.recorder = null;
    this.track = null;
    app.statusbar.hint(null);
    app.emit('project');
    const blob = new Blob(this.chunks, { type: 'audio/webm' });
    this.chunks = [];
    if (blob.size < 2000) {
      toast('Nothing was recorded.');
      return;
    }
    const info = await platform.saveRecording(new Uint8Array(await blob.arrayBuffer()));
    if (!info) {
      toast("The recording couldn't be saved.", { kind: 'error' });
      return;
    }
    const [m] = await app.importFiles([info]);
    const t = findTrack(app, trackId);
    if (m && t) await app.placeMedia([m], this.start, t, 'overwrite', 'audio');
    toast(`Recorded ${info.name}. It's on ${t?.name ?? 'the timeline'} and in the Project panel.`, { kind: 'success', action: platform.isDesktop ? { label: 'Show in folder', run: () => platform.showInFolder(info.path) } : undefined });
  }
}

function findTrack(app: App, id: string) {
  return app.project ? [...app.seq.video, ...app.seq.audio].find((t) => t.id === id) : undefined;
}
