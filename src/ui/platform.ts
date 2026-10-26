// Access to the desktop shell. In a plain browser (development only) media comes from blob: URLs of
// files picked or dropped, and nothing can be saved except by downloading.
import type { FramelineApi, MediaFileInfo, SaveResult } from '../shared/api';

declare global {
  interface Window {
    frameline?: FramelineApi;
  }
}

/** Browser-only: picked files by their made-up paths. */
const blobs = new Map<string, string>();

function asInfo(f: File): MediaFileInfo {
  const p = `browser:/${f.name}`;
  if (!blobs.has(p)) blobs.set(p, URL.createObjectURL(f));
  return { path: p, name: f.name, size: f.size, modified: f.lastModified };
}

function pick(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.click();
  });
}

function download(name: string, data: Uint8Array | string): SaveResult {
  const blob = new Blob([typeof data === 'string' ? data : (data as BlobPart)]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name.split(/[\\/]/).pop() || 'download';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return { ok: true };
}

const chunks = new Map<number, { name: string; parts: { pos: number; data: Uint8Array }[] }>();

const webFallback: Omit<FramelineApi, 'isDesktop'> & { isDesktop: boolean } = {
  platform: 'web',
  isDesktop: false,
  mediaUrl: (p) => blobs.get(p) ?? p,
  importDialog: async () => (await pick('video/*,audio/*,image/*', true)).map(asInfo),
  droppedFiles: async (files) => files.map(asInfo),
  checkMedia: async (paths) => Object.fromEntries(paths.map((p) => [p, blobs.has(p) ? { path: p, name: p.slice(9), size: 0, modified: 0 } : null])),
  relinkDialog: async () => (await pick('video/*,audio/*,image/*', false)).map(asInfo)[0] ?? null,
  openProjectDialog: async () => {
    const [f] = await pick('.frameline', false);
    return f ? { path: f.name, name: f.name, text: await f.text() } : null;
  },
  openProject: async () => null,
  saveProjectDialog: async (name) => name,
  saveProject: async (p, text) => download(p, text),
  openTextDialog: async (kind) => {
    const [f] = await pick(kind === 'lut' ? '.cube' : kind === 'captions' ? '.srt,.vtt' : '.json', false);
    return f ? { path: f.name, name: f.name, text: await f.text() } : null;
  },
  readText: async () => null,
  saveDialog: async (name) => name,
  saveFile: async (p, data) => download(p, data),
  exportStream: {
    open: async (p) => {
      const id = chunks.size + 1;
      chunks.set(id, { name: p, parts: [] });
      return id;
    },
    write: async (h, pos, data) => {
      chunks.get(h)?.parts.push({ pos, data: data.slice() });
    },
    close: async (h, ok) => {
      const c = chunks.get(h);
      chunks.delete(h);
      if (!c || !ok) return { ok: true };
      const size = Math.max(0, ...c.parts.map((p) => p.pos + p.data.length));
      const all = new Uint8Array(size);
      for (const p of c.parts) all.set(p.data, p.pos);
      return download(c.name, all);
    },
  },
  cache: { get: async () => null, put: async () => undefined },
  recovery: { save: async () => undefined, list: async () => [], read: async () => null, remove: async () => undefined },
  suite: { apps: async () => [], launch: async () => false },
  recentFiles: async () => [],
  clearRecentFiles: async () => undefined,
  removeRecentFile: async () => undefined,
  pinRecentFile: async () => undefined,
  setTitle: (t) => {
    document.title = t;
  },
  setDirty: () => undefined,
  setTheme: () => undefined,
  newWindow: () => window.open(location.href, '_blank'),
  openExternal: (url) => {
    if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener');
  },
  showInFolder: () => undefined,
  confirmClose: () => undefined,
  onRequestClose: () => undefined,
  onOpenPaths: () => undefined,
  onNewProject: () => undefined,
  keepAwake: () => undefined,
  toggleDevTools: () => undefined,
  appVersion: async () => __APP_VERSION__,
  setZoomFactor: () => undefined,
  updates: {
    check: async () => ({ status: 'unsupported', current: __APP_VERSION__, error: 'Updates are available in the desktop app.' }),
    state: async () => ({ status: 'unsupported', current: __APP_VERSION__ }),
    download: async () => ({ status: 'unsupported', current: __APP_VERSION__ }),
    install: async () => false,
    openPage: async () => undefined,
    onState: () => undefined,
  },
};

export const platform: FramelineApi = (window.frameline ?? webFallback) as FramelineApi;
export const isDesktop = !!window.frameline;
