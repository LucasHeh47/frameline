// Exposes a minimal, typed API to the UI. The UI never gets direct Node or file-system access.
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import type { FramelineApi } from '../src/shared/api';

const api: FramelineApi = {
  platform: process.platform,
  isDesktop: true,
  mediaUrl: (p) => `media://file/${encodeURIComponent(p)}`,
  importDialog: () => ipcRenderer.invoke('media:import-dialog'),
  droppedFiles: (files) => ipcRenderer.invoke('media:dropped', files.map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  checkMedia: (paths) => ipcRenderer.invoke('media:check', paths),
  relinkDialog: (name) => ipcRenderer.invoke('media:relink-dialog', name),
  openProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
  openProject: (p) => ipcRenderer.invoke('project:open', p),
  saveProjectDialog: (name) => ipcRenderer.invoke('project:save-dialog', name),
  saveProject: (p, text) => ipcRenderer.invoke('project:save', p, text),
  openTextDialog: (kind) => ipcRenderer.invoke('file:open-text-dialog', kind),
  readText: (p) => ipcRenderer.invoke('file:read-text', p),
  saveDialog: (name, kind) => ipcRenderer.invoke('file:save-dialog', name, kind),
  saveFile: (p, data) => ipcRenderer.invoke('file:save', p, data),
  exportStream: {
    open: (p) => ipcRenderer.invoke('export:open', p),
    write: (h, pos, data) => ipcRenderer.invoke('export:write', h, pos, data),
    close: (h, ok) => ipcRenderer.invoke('export:close', h, ok),
  },
  saveRecording: (data) => ipcRenderer.invoke('recording:save', data),
  cache: {
    get: (k) => ipcRenderer.invoke('cache:get', k),
    put: (k, data) => ipcRenderer.invoke('cache:put', k, data),
  },
  recovery: {
    save: (id, text, info) => ipcRenderer.invoke('recovery:save', id, text, info),
    list: () => ipcRenderer.invoke('recovery:list'),
    read: (id) => ipcRenderer.invoke('recovery:read', id),
    remove: (id) => ipcRenderer.invoke('recovery:remove', id),
  },
  suite: {
    apps: () => ipcRenderer.invoke('suite:apps'),
    launch: (id, args) => ipcRenderer.invoke('suite:launch', id, args ?? []),
  },
  recentFiles: () => ipcRenderer.invoke('file:recent'),
  clearRecentFiles: () => ipcRenderer.invoke('file:clear-recent'),
  removeRecentFile: (p) => ipcRenderer.invoke('file:remove-recent', p),
  pinRecentFile: (p, pinned) => ipcRenderer.invoke('file:pin-recent', p, pinned),
  setTitle: (t) => ipcRenderer.send('win:set-title', t),
  setDirty: (d) => ipcRenderer.send('win:set-dirty', d),
  setTheme: (t) => ipcRenderer.send('win:set-theme', t),
  newWindow: (p) => ipcRenderer.send('win:new', p),
  openExternal: (url) => ipcRenderer.send('shell:open-external', url),
  showInFolder: (p) => ipcRenderer.send('shell:show-in-folder', p),
  confirmClose: () => ipcRenderer.send('win:confirm-close'),
  onRequestClose: (cb) => {
    ipcRenderer.on('app:request-close', () => cb());
  },
  onOpenPaths: (cb) => {
    ipcRenderer.on('app:open-paths', (_e, paths: string[]) => cb(paths));
  },
  onNewProject: (cb) => {
    ipcRenderer.on('app:new-project', (_e, o: Record<string, string>) => cb(o));
  },
  keepAwake: (on) => ipcRenderer.send('power:keep-awake', !!on),
  toggleDevTools: () => ipcRenderer.send('win:devtools'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  setZoomFactor: (f) => webFrame.setZoomFactor(Math.min(2, Math.max(0.5, Number(f) || 1))),
  updates: {
    check: (opts) => ipcRenderer.invoke('updates:check', opts),
    state: () => ipcRenderer.invoke('updates:state'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    openPage: () => ipcRenderer.invoke('updates:open-page'),
    onState: (cb) => {
      ipcRenderer.on('updates:state', (_e, s) => cb(s));
    },
  },
};

contextBridge.exposeInMainWorld('frameline', api);
