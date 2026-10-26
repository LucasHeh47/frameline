// The bridge between the Electron main process and the UI (exposed as window.frameline).

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
  pinned?: boolean;
}

/** What a file dialog is for (decides its file types). */
export type FileKind = 'project' | 'media' | 'lut' | 'captions' | 'json';

/** What an export writes. */
export type ExportKind = 'mp4' | 'webm' | 'mov' | 'm4a' | 'wav' | 'png' | 'jpg' | 'srt' | 'vtt' | 'project' | 'json';

export interface SaveResult {
  ok: boolean;
  error?: string;
}

export interface OpenedProject {
  path: string;
  name: string;
  text: string;
}

export interface MediaFileInfo {
  path: string;
  name: string;
  size: number;
  modified: number;
}

export interface FramelineApi {
  platform: string;
  isDesktop: true;
  /** The address the UI loads a media file from (it streams, so long videos aren't read whole). */
  mediaUrl(path: string): string;
  /** Picks media to import. The files may then be loaded through mediaUrl. */
  importDialog(): Promise<MediaFileInfo[]>;
  /** Files dropped on the window (their paths become usable). */
  droppedFiles(files: File[]): Promise<MediaFileInfo[]>;
  /** Which of these media files exist (missing ones need relinking). */
  checkMedia(paths: string[]): Promise<Record<string, MediaFileInfo | null>>;
  /** Picks the new location of a missing file. */
  relinkDialog(name: string): Promise<MediaFileInfo | null>;
  openProjectDialog(): Promise<OpenedProject | null>;
  openProject(path: string): Promise<OpenedProject | null>;
  saveProjectDialog(defaultName: string): Promise<string | null>;
  /** Writes a project; its media paths stay usable. */
  saveProject(path: string, text: string): Promise<SaveResult>;
  /** Reads a small text file chosen in a dialog (LUTs, subtitles). */
  openTextDialog(kind: FileKind): Promise<{ path: string; name: string; text: string } | null>;
  /** Reads a text file the user picked before (a LUT used by the project). */
  readText(path: string): Promise<string | null>;
  saveDialog(defaultName: string, kind: ExportKind): Promise<string | null>;
  /** Writes a whole small file (a frame, subtitles) to a path from saveDialog. */
  saveFile(path: string, data: Uint8Array | string): Promise<SaveResult>;
  /** Streams a big file (an exported video) to a path from saveDialog. */
  exportStream: ExportStreamApi;
  /** Small files kept between sessions (waveforms, thumbnails). */
  cache: CacheApi;
  recovery: RecoveryApi;
  suite: SuiteApi;
  recentFiles(): Promise<RecentFile[]>;
  clearRecentFiles(): Promise<void>;
  removeRecentFile(path: string): Promise<void>;
  pinRecentFile(path: string, pinned: boolean): Promise<void>;
  setTitle(title: string): void;
  setDirty(dirty: boolean): void;
  setTheme(theme: { dark: boolean; bar: string; symbol: string }): void;
  newWindow(path?: string): void;
  openExternal(url: string): void;
  showInFolder(path: string): void;
  confirmClose(): void;
  onRequestClose(cb: () => void): void;
  /** Files opened from outside (Explorer, a second launch): projects or media to import. */
  onOpenPaths(cb: (paths: string[]) => void): void;
  /** A new project asked for from outside (Baseline): { new: '1920x1080', fps?, name? }. */
  onNewProject(cb: (opts: Record<string, string>) => void): void;
  /** Keeps the computer awake while exporting. */
  keepAwake(on: boolean): void;
  toggleDevTools(): void;
  appVersion(): Promise<string>;
  setZoomFactor(factor: number): void;
  updates: UpdatesApi;
}

export interface ExportStreamApi {
  open(path: string): Promise<number | null>;
  write(handle: number, position: number, data: Uint8Array): Promise<void>;
  /** Finishes the file; without `ok` the partial file is deleted. */
  close(handle: number, ok: boolean): Promise<SaveResult>;
}

export interface CacheApi {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
}

export interface RecoveredProject {
  id: string;
  name: string;
  filePath: string | null;
  savedAt: number;
}

export interface RecoveryApi {
  save(id: string, text: string, info: Omit<RecoveredProject, 'id' | 'savedAt'>): Promise<void>;
  list(): Promise<RecoveredProject[]>;
  read(id: string): Promise<string | null>;
  remove(id: string): Promise<void>;
}

export type SuiteAppId = 'baseline' | 'gridline' | 'pixelline' | 'frameline';

export interface SuiteApp {
  id: SuiteAppId;
  name: string;
  description: string;
  installed: boolean;
  exe: string | null;
  version: string | null;
  download: string;
}

export interface SuiteApi {
  apps(): Promise<SuiteApp[]>;
  launch(id: SuiteAppId, args?: string[]): Promise<boolean>;
}

export interface UpdateCheckOptions {
  /** A background check at startup (no message when there's nothing new). */
  silent?: boolean;
  allowPrerelease?: boolean;
  autoDownload?: boolean;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  /** Version currently running. */
  current: string;
  /** Newest version found. */
  version?: string;
  notes?: string;
  percent?: number;
  error?: string;
  /** Portable builds can't update themselves; `url` is the download page. */
  portable?: boolean;
  url?: string;
}

export interface UpdatesApi {
  check(opts: UpdateCheckOptions): Promise<UpdateState>;
  state(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<boolean>;
  openPage(): Promise<void>;
  onState(cb: (s: UpdateState) => void): void;
}
