// Electron main process: windows, native dialogs, the media:// protocol that streams media files to
// the UI (with seeking), saving projects and exports, recovery copies and the suite.
import { app, BrowserWindow, dialog, ipcMain, Menu, powerSaveBlocker, protocol, session, shell, type IpcMainInvokeEvent } from 'electron';
import { createReadStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ExportKind, FileKind, MediaFileInfo } from '../src/shared/api';
import { launchSuiteApp, registerSelf, safeLaunchArgs, suiteApps, type SuiteAppId } from './suite';
import { setupUpdates } from './updater';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const SMOKE_SCREENSHOT = process.env.FRAMELINE_SCREENSHOT;
/** Tests of an unpackaged build: save dialogs answer with this folder instead of asking. */
const TEST_SAVE_DIR = !app.isPackaged ? process.env.FRAMELINE_TEST_SAVE_DIR : undefined;

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const MEDIA = new RegExp(`\\.(${[...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT].join('|')})$`, 'i');
const PROJECT = /\.frameline$/i;

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/** Files the UI may read: chosen in a dialog, dropped, opened from Explorer, or used by an opened project. */
const allowedPaths = new Set<string>();
/** Files the UI may write: chosen in a save dialog. */
const writable = new Set<string>();
const dirty = new Map<number, boolean>();
const closing = new Set<number>();

const key = (p: string) => path.resolve(p).toLowerCase();

function allow(p: string): string {
  const full = path.resolve(p);
  allowedPaths.add(full.toLowerCase());
  return full;
}

const isAllowed = (p: unknown): p is string => typeof p === 'string' && allowedPaths.has(key(p));

async function info(p: string): Promise<MediaFileInfo | null> {
  const st = await fs.stat(p).catch(() => null);
  return st?.isFile() ? { path: path.resolve(p), name: path.basename(p), size: st.size, modified: st.mtimeMs } : null;
}

// ---------- media:// (streams files to the UI, with byte ranges so videos can seek) ----------

// Media elements can play any of a file's sound tracks (screen recordings keep game and mic apart)
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

function serveMedia(): void {
  protocol.handle('media', async (req) => {
    let p: string;
    try {
      p = decodeURIComponent(new URL(req.url).pathname.slice(1));
    } catch {
      return new Response('Bad address', { status: 400 });
    }
    if (!isAllowed(p)) return new Response('Not allowed', { status: 403 });
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) return new Response('Not found', { status: 404 });
    const type = MIME[path.extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream';
    const common = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
    if (range) {
      let start = range[1] ? parseInt(range[1], 10) : 0;
      let end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
      // "bytes=-500" is the last 500 bytes
      if (!range[1] && range[2]) {
        start = Math.max(0, st.size - parseInt(range[2], 10));
        end = st.size - 1;
      }
      if (start >= st.size || end < start) return new Response(null, { status: 416, headers: { ...common, 'Content-Range': `bytes */${st.size}` } });
      const body = Readable.toWeb(createReadStream(p, { start, end })) as ReadableStream;
      return new Response(body, { status: 206, headers: { ...common, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}` } });
    }
    const body = Readable.toWeb(createReadStream(p)) as ReadableStream;
    return new Response(body, { status: 200, headers: { ...common, 'Content-Length': String(st.size) } });
  });
}

// ---------- recent projects ----------

const recentPath = () => path.join(app.getPath('userData'), 'recent.json');
interface Recent {
  path: string;
  name: string;
  openedAt: number;
  pinned?: boolean;
}

async function readRecent(): Promise<Recent[]> {
  try {
    const list = JSON.parse(await fs.readFile(recentPath(), 'utf8')) as Recent[];
    return list.filter((r) => typeof r.path === 'string' && existsSync(r.path));
  } catch {
    return [];
  }
}

async function writeRecent(list: Recent[]): Promise<void> {
  // Every pinned project plus the 30 most recent others
  let unpinned = 0;
  const kept = list.filter((r) => r.pinned || unpinned++ < 30);
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(recentPath(), JSON.stringify(kept, null, 2));
}

async function addRecent(p: string): Promise<void> {
  const all = await readRecent();
  const prev = all.find((r) => key(r.path) === key(p));
  const list = all.filter((r) => r !== prev);
  list.unshift({ path: p, name: path.basename(p), openedAt: Date.now(), pinned: prev?.pinned || undefined });
  await writeRecent(list);
  app.addRecentDocument(p);
}

// ---------- projects ----------

/** A project's media become readable when the project is opened (the files it points to, or next to it). */
function allowProjectMedia(projectPath: string, text: string): void {
  try {
    const p = JSON.parse(text) as { media?: { path?: string }[]; relative?: Record<string, string>; sequences?: { video?: { clips?: { effects?: { params?: Record<string, unknown> }[] }[] }[] }[] };
    for (const m of p.media ?? []) if (typeof m.path === 'string' && MEDIA.test(m.path)) allow(m.path);
    for (const rel of Object.values(p.relative ?? {})) if (typeof rel === 'string' && MEDIA.test(rel)) allow(path.resolve(path.dirname(projectPath), rel));
    // Looks (LUT files) used by color effects
    for (const s of p.sequences ?? []) for (const t of s.video ?? []) for (const c of t.clips ?? []) for (const e of c.effects ?? []) {
      const lut = e.params?.lut;
      if (typeof lut === 'string' && /\.cube$/i.test(lut)) allow(lut);
    }
  } catch {
    // an unreadable project fails later with a clear message
  }
}

async function readProjectFile(p: string) {
  const full = allow(p);
  const text = await fs.readFile(full, 'utf8');
  allowProjectMedia(full, text);
  writable.add(key(full));
  await addRecent(full);
  return { path: full, name: path.basename(full), text };
}

async function writeAtomic(full: string, data: Uint8Array | string) {
  const tmp = `${full}.frameline-${process.pid}.tmp`;
  try {
    // A temporary file first, so a crash can't leave half a file
    await fs.writeFile(tmp, typeof data === 'string' ? data : Buffer.from(data));
    await fs.rename(tmp, full);
    return { ok: true };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return { ok: false, error: 'The file is locked — it may be open in another program. Close it there and try again, or save somewhere else.' };
    return { ok: false, error: (err as Error).message };
  }
}

const senderWindow = (e: IpcMainInvokeEvent | Electron.IpcMainEvent) => BrowserWindow.fromWebContents(e.sender);

function mediaFilters(): Electron.FileFilter[] {
  return [
    { name: 'Video, audio and images', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT] },
    { name: 'Video', extensions: VIDEO_EXT },
    { name: 'Audio', extensions: AUDIO_EXT },
    { name: 'Images', extensions: IMAGE_EXT },
  ];
}

const TEXT_FILTERS: Record<string, Electron.FileFilter[]> = {
  lut: [{ name: 'Color looks (.cube LUT)', extensions: ['cube'] }],
  captions: [{ name: 'Subtitles (SRT, WebVTT)', extensions: ['srt', 'vtt'] }],
  json: [{ name: 'Frameline settings', extensions: ['json'] }],
};

const SAVE_FILTERS: Record<ExportKind, Electron.FileFilter> = {
  mp4: { name: 'MP4 video (H.264)', extensions: ['mp4'] },
  webm: { name: 'WebM video (VP9)', extensions: ['webm'] },
  mov: { name: 'QuickTime video', extensions: ['mov'] },
  m4a: { name: 'M4A audio (AAC)', extensions: ['m4a'] },
  wav: { name: 'WAV audio', extensions: ['wav'] },
  png: { name: 'PNG image', extensions: ['png'] },
  jpg: { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
  srt: { name: 'SubRip subtitles', extensions: ['srt'] },
  vtt: { name: 'WebVTT subtitles', extensions: ['vtt'] },
  project: { name: 'Frameline project', extensions: ['frameline'] },
  json: { name: 'Frameline settings', extensions: ['json'] },
};

// ---------- IPC ----------

ipcMain.handle('media:import-dialog', async (e) => {
  const res = await dialog.showOpenDialog(senderWindow(e)!, { title: 'Import media', properties: ['openFile', 'multiSelections'], filters: mediaFilters() });
  if (res.canceled) return [];
  const out: MediaFileInfo[] = [];
  for (const p of res.filePaths) {
    const i = await info(allow(p));
    if (i) out.push(i);
  }
  return out;
});

ipcMain.handle('media:dropped', async (_e, paths: unknown) => {
  if (!Array.isArray(paths)) return [];
  const out: MediaFileInfo[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    if (MEDIA.test(p)) {
      const i = await info(allow(p));
      if (i) out.push(i);
    } else if (PROJECT.test(p) || /\.(srt|vtt|cube)$/i.test(p)) allow(p);
  }
  return out;
});

ipcMain.handle('media:check', async (_e, paths: unknown) => {
  const out: Record<string, MediaFileInfo | null> = {};
  if (!Array.isArray(paths)) return out;
  for (const p of paths) if (isAllowed(p)) out[p] = await info(p);
  return out;
});

ipcMain.handle('media:relink-dialog', async (e, name: string) => {
  const res = await dialog.showOpenDialog(senderWindow(e)!, { title: `Where is ${String(name).slice(0, 80)}?`, properties: ['openFile'], filters: mediaFilters() });
  if (res.canceled || !res.filePaths[0]) return null;
  return info(allow(res.filePaths[0]));
});

ipcMain.handle('project:open-dialog', async (e) => {
  const res = await dialog.showOpenDialog(senderWindow(e)!, { title: 'Open project', properties: ['openFile'], filters: [{ name: 'Frameline projects', extensions: ['frameline'] }] });
  if (res.canceled || !res.filePaths[0]) return null;
  return readProjectFile(res.filePaths[0]);
});

ipcMain.handle('project:open', async (_e, p: string) => {
  if (typeof p !== 'string' || !PROJECT.test(p)) return null;
  const recent = await readRecent();
  if (!isAllowed(p) && !recent.some((r) => key(r.path) === key(p))) throw new Error('That project can only be opened from the Open dialog.');
  if (!existsSync(p)) throw new Error(`${path.basename(p)} isn't there any more.`);
  return readProjectFile(p);
});

ipcMain.handle('project:save-dialog', async (e, defaultName: string) => {
  if (TEST_SAVE_DIR) {
    const full = path.resolve(TEST_SAVE_DIR, path.basename(String(defaultName || 'Untitled.frameline')));
    writable.add(key(full));
    return allow(full);
  }
  const res = await dialog.showSaveDialog(senderWindow(e)!, { title: 'Save project', defaultPath: String(defaultName || 'Untitled.frameline'), filters: [SAVE_FILTERS.project] });
  if (res.canceled || !res.filePath) return null;
  writable.add(key(res.filePath));
  return allow(res.filePath);
});

ipcMain.handle('project:save', async (_e, p: string, text: string) => {
  if (typeof p !== 'string' || typeof text !== 'string' || !writable.has(key(p)) || !PROJECT.test(p)) return { ok: false, error: "Frameline isn't allowed to write there. Use Save As." };
  const res = await writeAtomic(path.resolve(p), text);
  if (res.ok) {
    allowProjectMedia(p, text);
    await addRecent(path.resolve(p));
  }
  return res;
});

ipcMain.handle('file:open-text-dialog', async (e, kind: FileKind) => {
  const filters = TEXT_FILTERS[kind];
  if (!filters) return null;
  const res = await dialog.showOpenDialog(senderWindow(e)!, { title: kind === 'lut' ? 'Choose a look (.cube LUT)' : kind === 'captions' ? 'Import subtitles' : 'Import settings', properties: ['openFile'], filters });
  if (res.canceled || !res.filePaths[0]) return null;
  const full = allow(res.filePaths[0]);
  const st = await fs.stat(full);
  if (st.size > 64 * 1024 * 1024) throw new Error('That file is too big.');
  return { path: full, name: path.basename(full), text: await fs.readFile(full, 'utf8') };
});

ipcMain.handle('file:read-text', async (_e, p: string) => {
  if (!isAllowed(p) || !/\.(cube|srt|vtt)$/i.test(p)) return null;
  return fs.readFile(p, 'utf8').catch(() => null);
});

ipcMain.handle('file:save-dialog', async (e, defaultName: string, kind: ExportKind) => {
  const filter = SAVE_FILTERS[kind];
  if (!filter) return null;
  if (TEST_SAVE_DIR) {
    const full = path.resolve(TEST_SAVE_DIR, path.basename(String(defaultName)));
    writable.add(key(full));
    return full;
  }
  const res = await dialog.showSaveDialog(senderWindow(e)!, { title: kind === 'png' || kind === 'jpg' ? 'Export frame' : 'Export', defaultPath: String(defaultName), filters: [filter] });
  if (res.canceled || !res.filePath) return null;
  const full = path.resolve(res.filePath);
  writable.add(key(full));
  return full;
});

ipcMain.handle('file:save', async (_e, p: string, data: Uint8Array | string) => {
  if (typeof p !== 'string' || !writable.has(key(p))) return { ok: false, error: 'Choose where to save it first.' };
  if (!(data instanceof Uint8Array) && typeof data !== 'string') return { ok: false, error: 'Nothing to save.' };
  return writeAtomic(path.resolve(p), data);
});

// Exports are written as they're made: a temporary file, renamed when finished
const streams = new Map<number, { handle: fs.FileHandle; tmp: string; final: string }>();
let streamSeq = 0;
ipcMain.handle('export:open', async (_e, p: string) => {
  if (typeof p !== 'string' || !writable.has(key(p))) return null;
  const final = path.resolve(p);
  const tmp = `${final}.frameline-export.tmp`;
  const handle = await fs.open(tmp, 'w');
  const id = ++streamSeq;
  streams.set(id, { handle, tmp, final });
  return id;
});
ipcMain.handle('export:write', async (_e, id: number, position: number, data: Uint8Array) => {
  const s = streams.get(id);
  if (!s || !(data instanceof Uint8Array) || !Number.isFinite(position) || position < 0) throw new Error('The export file is closed.');
  await s.handle.write(data, 0, data.length, position);
});
ipcMain.handle('export:close', async (_e, id: number, ok: boolean) => {
  const s = streams.get(id);
  if (!s) return { ok: false, error: 'The export file is closed.' };
  streams.delete(id);
  await s.handle.close();
  if (!ok) {
    await fs.rm(s.tmp, { force: true });
    return { ok: true };
  }
  try {
    await fs.rm(s.final, { force: true });
    await fs.rename(s.tmp, s.final);
    allow(s.final);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

// Voice-overs recorded from the microphone go in Videos\Frameline voice-overs
ipcMain.handle('recording:save', async (_e, data: Uint8Array) => {
  if (!(data instanceof Uint8Array) || !data.length) return null;
  const dir = TEST_SAVE_DIR ? path.join(TEST_SAVE_DIR, 'voice-overs') : path.join(app.getPath('videos'), 'Frameline voice-overs');
  await fs.mkdir(dir, { recursive: true });
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  const full = path.join(dir, `Voice-over ${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}.webm`);
  const res = await writeAtomic(full, data);
  return res.ok ? info(allow(full)) : null;
});

// Waveforms and thumbnails kept between sessions
const cacheDir = () => path.join(app.getPath('userData'), 'cache');
const CACHE_KEY = /^[a-z0-9_-]{1,80}$/;
ipcMain.handle('cache:get', async (_e, k: string) => {
  if (typeof k !== 'string' || !CACHE_KEY.test(k)) return null;
  const data = await fs.readFile(path.join(cacheDir(), k)).catch(() => null);
  return data ? new Uint8Array(data) : null;
});
ipcMain.handle('cache:put', async (_e, k: string, data: Uint8Array) => {
  if (typeof k !== 'string' || !CACHE_KEY.test(k) || !(data instanceof Uint8Array) || data.length > 32 * 1024 * 1024) return;
  await fs.mkdir(cacheDir(), { recursive: true });
  await fs.writeFile(path.join(cacheDir(), k), data);
});

// Unsaved projects kept safe in case Frameline closes unexpectedly
const recoveryDir = () => path.join(app.getPath('userData'), 'recovery');
const recoveringNow = new Set<string>();
const RECOVERY_ID = /^[a-z0-9-]{1,40}$/;
ipcMain.handle('recovery:save', async (_e, id: string, text: string, meta: unknown) => {
  if (typeof id !== 'string' || !RECOVERY_ID.test(id) || typeof text !== 'string') return;
  recoveringNow.add(id);
  await fs.mkdir(recoveryDir(), { recursive: true });
  await writeAtomic(path.join(recoveryDir(), `${id}.frameline`), text);
  await fs.writeFile(path.join(recoveryDir(), `${id}.json`), JSON.stringify({ ...(meta as object), savedAt: Date.now() }));
});
ipcMain.handle('recovery:list', async () => {
  const out: Record<string, unknown>[] = [];
  for (const f of await fs.readdir(recoveryDir()).catch(() => [] as string[])) {
    if (!f.endsWith('.json') || recoveringNow.has(f.replace(/\.json$/, ''))) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(recoveryDir(), f), 'utf8')) as Record<string, unknown>;
      if (existsSync(path.join(recoveryDir(), f.replace(/\.json$/, '.frameline')))) out.push({ ...meta, id: f.replace(/\.json$/, '') });
    } catch {
      // a damaged entry is skipped
    }
  }
  return out;
});
ipcMain.handle('recovery:read', async (_e, id: string) => {
  if (typeof id !== 'string' || !RECOVERY_ID.test(id)) return null;
  const file = path.join(recoveryDir(), `${id}.frameline`);
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  if (text) allowProjectMedia(file, text);
  return text;
});
ipcMain.handle('recovery:remove', async (_e, id: string) => {
  if (typeof id !== 'string' || !RECOVERY_ID.test(id)) return;
  await fs.rm(path.join(recoveryDir(), `${id}.frameline`), { force: true });
  await fs.rm(path.join(recoveryDir(), `${id}.json`), { force: true });
});

ipcMain.handle('suite:apps', () => suiteApps());
ipcMain.handle('suite:launch', async (_e, id: SuiteAppId, args: unknown) => {
  if (!['baseline', 'gridline', 'pixelline', 'frameline', 'beatline'].includes(id)) return false;
  return launchSuiteApp(id, safeLaunchArgs(args));
});

ipcMain.handle('file:recent', async () => {
  const list = await readRecent();
  for (const r of list) allow(r.path);
  return list;
});
ipcMain.handle('file:clear-recent', async () => {
  await writeRecent((await readRecent()).filter((r) => r.pinned)).catch(() => undefined);
  app.clearRecentDocuments();
});
ipcMain.handle('file:remove-recent', async (_e, p: string) => {
  if (typeof p !== 'string') return;
  await writeRecent((await readRecent()).filter((r) => key(r.path) !== key(p)));
});
ipcMain.handle('file:pin-recent', async (_e, p: string, pinned: boolean) => {
  if (typeof p !== 'string') return;
  const list = await readRecent();
  for (const r of list) if (key(r.path) === key(p)) r.pinned = pinned ? true : undefined;
  await writeRecent(list);
});

let awake: number | null = null;
ipcMain.on('power:keep-awake', (_e, on: boolean) => {
  if (on && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension');
  else if (!on && awake !== null) {
    powerSaveBlocker.stop(awake);
    awake = null;
  }
});

ipcMain.on('win:set-title', (e, title: string) => senderWindow(e)?.setTitle(String(title)));
ipcMain.on('win:set-dirty', (e, value: boolean) => {
  dirty.set(e.sender.id, !!value);
  senderWindow(e)?.setDocumentEdited?.(!!value);
});
ipcMain.on('win:set-theme', (e, t: { dark: boolean; bar: string; symbol: string }) => {
  const win = senderWindow(e);
  try {
    win?.setTitleBarOverlay?.({ color: t.bar, symbolColor: t.symbol, height: 40 });
    win?.setBackgroundColor(t.dark ? '#121417' : '#ffffff');
  } catch {
    // not supported on this platform
  }
});
ipcMain.on('win:new', (_e, p?: string) => {
  if (p && !isAllowed(p)) return;
  createWindow(p);
});
ipcMain.on('win:confirm-close', (e) => {
  closing.add(e.sender.id);
  senderWindow(e)?.close();
});
ipcMain.on('win:devtools', (e) => e.sender.toggleDevTools());
ipcMain.on('shell:open-external', (_e, url: string) => {
  if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
});
ipcMain.on('shell:show-in-folder', (_e, p: string) => {
  if (isAllowed(p) || (typeof p === 'string' && writable.has(key(p)))) shell.showItemInFolder(p);
});
ipcMain.handle('app:version', () => app.getVersion());

setupUpdates();

// ---------- windows ----------

/** A new project asked for on the command line (Baseline uses this): --new=1920x1080 --fps=30 --name=Trip */
function newProjectFromArgv(argv: string[]): Record<string, string> | null {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const size = get('new');
  if (!size || !/^\d{2,5}x\d{2,5}$/.test(size)) return null;
  const out: Record<string, string> = { new: size };
  const fps = get('fps');
  if (fps && /^\d{1,3}(\.\d{1,3})?$/.test(fps)) out.fps = fps;
  const name = get('name');
  if (name) out.name = name.slice(0, 80);
  return out;
}

function filesFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && (PROJECT.test(a) || MEDIA.test(a)) && existsSync(a));
}

function createWindow(filePath?: string, launch = false, newProject?: Record<string, string> | null, extra: string[] = []): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#121417',
    title: 'Frameline',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#16181d', symbolColor: '#c9ced8', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Playback keeps going when the window is behind another one
      backgroundThrottling: false,
    },
  });
  const id = win.webContents.id;
  if (filePath) allow(filePath);
  const query: Record<string, string> | undefined = filePath ? { file: path.resolve(filePath) } : newProject ? newProject : launch ? { launch: '1' } : undefined;
  if (DEV_URL) win.loadURL(DEV_URL + (query ? `?${new URLSearchParams(query)}` : ''));
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query });
  if (extra.length) win.webContents.once('did-finish-load', () => sendPaths(win, extra));

  win.once('ready-to-show', () => {
    win.show();
    if (SMOKE_SCREENSHOT) {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        await fs.writeFile(SMOKE_SCREENSHOT, img.toPNG());
        app.exit(0);
      }, Number(process.env.FRAMELINE_SCREENSHOT_DELAY ?? 2500));
    }
  });
  win.on('close', (e) => {
    if (dirty.get(id) && !closing.has(id)) {
      e.preventDefault();
      win.webContents.send('app:request-close');
    }
  });
  win.on('closed', () => {
    dirty.delete(id);
    closing.delete(id);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && DEV_URL) win.webContents.toggleDevTools();
  });
  return win;
}

/** Lets a window use these files and asks it to open them (projects) or import them (media). */
function sendPaths(win: BrowserWindow, files: string[]): void {
  win.webContents.send('app:open-paths', files.map((f) => allow(f)));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv);
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const fresh = newProjectFromArgv(argv);
    if (!win) {
      createWindow(files.find((f) => PROJECT.test(f)), !files.length, fresh, files.filter((f) => !PROJECT.test(f)));
      return;
    }
    if (win.isMinimized()) win.restore();
    win.focus();
    if (files.length) sendPaths(win, files);
    if (fresh) win.webContents.send('app:new-project', fresh);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    app.setAppUserModelId('com.frameline.app');
    serveMedia();
    // System fonts for titles, and the microphone for voice-overs (sound only, never the camera)
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
      const media = permission === 'media' && 'mediaTypes' in details && (details.mediaTypes ?? []).every((t) => t === 'audio');
      cb(permission === 'local-fonts' || media);
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'local-fonts' || permission === 'media');
    const files = filesFromArgv(process.argv);
    if (process.env.FRAMELINE_OPEN && existsSync(process.env.FRAMELINE_OPEN)) files.push(process.env.FRAMELINE_OPEN);
    const projectFile = files.find((f) => PROJECT.test(f));
    createWindow(projectFile, !files.length, newProjectFromArgv(process.argv), files.filter((f) => !PROJECT.test(f)));
    void registerSelf('frameline');
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
