// Every setting in Frameline. `apply` runs when it changes (and at startup); `refresh` lists the
// parts of the UI that redraw.
import * as L from 'lucide';
import type { App } from '../app';
import { platform } from '../platform';
import { uiOptions } from '../widgets';
import type { SectionDef, SettingDef, SettingOption } from './store';

export const SECTIONS: SectionDef[] = [
  { id: 'appearance', label: 'Appearance', icon: L.Palette, description: 'Theme, colors and what is shown on screen.' },
  { id: 'timeline', label: 'Timeline', icon: L.GalleryHorizontalEnd, description: 'Tracks, thumbnails, waveforms, snapping and default durations.' },
  { id: 'playback', label: 'Playback', icon: L.Play, description: 'The monitors and how playback follows along.' },
  { id: 'media', label: 'Media', icon: L.Film, description: 'Importing files and fitting them to the frame.' },
  { id: 'files', label: 'Files & saving', icon: L.Save, description: 'Projects, automatic saving and recovery.' },
  { id: 'export', label: 'Export', icon: L.Upload, description: 'Defaults for exporting video.' },
  { id: 'keyboard', label: 'Keyboard & search', icon: L.Keyboard, description: 'Command search and shortcuts.' },
  { id: 'updates', label: 'Updates', icon: L.RefreshCw, description: 'Version and automatic updates.' },
];

const opts = (...pairs: [string, string][]): SettingOption[] => pairs.map(([value, label]) => ({ value, label }));

export const ACCENTS: Record<string, [string, string]> = {
  red: ['#ff5c6c', '#d6283a'],
  coral: ['#ff8a70', '#d9482b'],
  violet: ['#a98bff', '#7c4dff'],
  blue: ['#4ea1ff', '#1a73e8'],
  teal: ['#22b8cf', '#0b7285'],
  green: ['#3fcf8e', '#188038'],
  gold: ['#ffd43b', '#b08800'],
};

export const SETTINGS: SettingDef[] = [
  // ---------- Appearance ----------
  { id: 'appearance.theme', section: 'appearance', group: 'Theme', label: 'Theme', description: 'Dark keeps the focus on your video; "Match Windows" follows your system setting.', type: 'select', default: 'dark', options: opts(['dark', 'Dark'], ['light', 'Light'], ['system', 'Match Windows']), refresh: ['theme'], keywords: 'dark mode light mode' },
  { id: 'appearance.accent', section: 'appearance', group: 'Theme', label: 'Accent color', description: 'Used for buttons, the playhead and highlights.', type: 'select', default: 'red', options: Object.keys(ACCENTS).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })), refresh: ['theme'], keywords: 'color highlight' },
  { id: 'appearance.uiZoom', section: 'appearance', group: 'Layout', label: 'Interface size', description: 'Scales menus, panels and buttons.', type: 'number', default: 100, min: 80, max: 150, step: 10, unit: '%', desktopOnly: true, apply: (v: number) => platform.setZoomFactor(v / 100), keywords: 'zoom scale bigger smaller' },
  { id: 'appearance.reduceMotion', section: 'appearance', group: 'Layout', label: 'Reduce motion', description: 'Turns off interface animations.', type: 'toggle', default: false, refresh: ['chrome'], keywords: 'animation accessibility' },
  { id: 'appearance.showStatusBar', section: 'appearance', group: 'Show on screen', label: 'Status bar', type: 'toggle', default: true, refresh: ['chrome'] },
  { id: 'appearance.showSearch', section: 'appearance', group: 'Show on screen', label: 'Search box in the title bar', description: 'Ctrl+Shift+P works either way.', type: 'toggle', default: true, refresh: ['titlebar'] },
  { id: 'appearance.titlePath', section: 'appearance', group: 'Show on screen', label: 'Show the project’s location in the window title', type: 'toggle', default: false, refresh: ['titlebar'], keywords: 'path folder' },
  { id: 'appearance.tooltips', section: 'appearance', group: 'Tooltips & messages', label: 'Tooltips', description: 'Short descriptions when you hover over a button.', type: 'toggle', default: true, apply: (v: boolean) => (uiOptions.tooltips = v) },
  { id: 'appearance.tooltipDelay', section: 'appearance', group: 'Tooltips & messages', label: 'Tooltip delay', type: 'number', default: 450, min: 0, max: 2000, step: 50, unit: 'ms', apply: (v: number) => (uiOptions.tooltipDelay = v) },
  { id: 'appearance.tooltipKeys', section: 'appearance', group: 'Tooltips & messages', label: 'Show keyboard shortcuts in tooltips', type: 'toggle', default: true, apply: (v: boolean) => (uiOptions.tooltipShortcuts = v) },
  { id: 'appearance.toastSeconds', section: 'appearance', group: 'Tooltips & messages', label: 'How long messages stay on screen', type: 'number', default: 4.5, min: 2, max: 20, step: 0.5, unit: 'seconds', apply: (v: number) => (uiOptions.toastMs = v * 1000), keywords: 'toast notification' },

  // ---------- Timeline ----------
  { id: 'timeline.thumbnails', section: 'timeline', group: 'Clips', label: 'Video thumbnails', description: 'Pictures inside video clips on the timeline.', type: 'select', default: 'filmstrip', options: opts(['filmstrip', 'Continuous (filmstrip)'], ['head', 'First frame only'], ['headtail', 'First and last frames'], ['off', 'None']), refresh: ['timeline'], keywords: 'filmstrip pictures' },
  { id: 'timeline.waveforms', section: 'timeline', group: 'Clips', label: 'Audio waveforms', type: 'toggle', default: true, refresh: ['timeline'] },
  { id: 'timeline.levels', section: 'timeline', group: 'Clips', label: 'Show volume and opacity lines', description: 'A line across clips that you can drag up and down (Ctrl+click adds a keyframe).', type: 'toggle', default: true, refresh: ['timeline'], keywords: 'rubber band keyframes' },
  { id: 'timeline.names', section: 'timeline', group: 'Clips', label: 'Clip names', type: 'toggle', default: true, refresh: ['timeline'] },
  { id: 'timeline.trackHeight', section: 'timeline', group: 'Tracks', label: 'Track height', type: 'select', default: 'medium', options: opts(['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']), refresh: ['timeline'] },
  { id: 'timeline.snapDistance', section: 'timeline', group: 'Snapping', label: 'Snap distance', description: 'How close a clip has to come to an edge, the playhead or a marker to snap to it (S turns snapping on and off).', type: 'number', default: 8, min: 2, max: 30, step: 1, unit: 'px', keywords: 'magnet' },
  { id: 'timeline.stillSeconds', section: 'timeline', group: 'Default durations', label: 'Pictures, titles and mattes', type: 'number', default: 5, min: 0.5, max: 60, step: 0.5, unit: 'seconds', keywords: 'still image length' },
  { id: 'timeline.transitionSeconds', section: 'timeline', group: 'Default durations', label: 'Video transitions', type: 'number', default: 1, min: 0.1, max: 10, step: 0.1, unit: 'seconds' },
  { id: 'timeline.audioTransitionSeconds', section: 'timeline', group: 'Default durations', label: 'Audio transitions', type: 'number', default: 1, min: 0.1, max: 10, step: 0.1, unit: 'seconds' },
  { id: 'timeline.defaultTransition', section: 'timeline', group: 'Default durations', label: 'Default video transition', description: 'What Ctrl+D adds.', type: 'select', default: 'crossDissolve', options: opts(['crossDissolve', 'Cross Dissolve'], ['dipToBlack', 'Dip to Black'], ['dipToWhite', 'Dip to White'], ['blurDissolve', 'Blur Dissolve'], ['wipe', 'Wipe'], ['push', 'Push'], ['zoom', 'Cross Zoom']) },
  { id: 'timeline.dropMode', section: 'timeline', group: 'Editing', label: 'Dropping clips on the timeline', description: 'Hold Ctrl while dropping to do the other.', type: 'select', default: 'overwrite', options: opts(['overwrite', 'Overwrites what’s there'], ['insert', 'Inserts, pushing later clips along']), keywords: 'insert overwrite drag' },
  { id: 'timeline.follow', section: 'timeline', group: 'Editing', label: 'While playing, the timeline', type: 'select', default: 'page', options: opts(['page', 'Turns the page'], ['smooth', 'Scrolls smoothly'], ['off', 'Stays put']), keywords: 'scroll auto' },

  // ---------- Playback ----------
  { id: 'playback.resolution', section: 'playback', group: 'Program monitor', label: 'Playback resolution', description: 'Lower is smoother on slower computers. Exports always use full quality.', type: 'select', default: '1', options: opts(['1', 'Full'], ['0.5', '1/2'], ['0.25', '1/4']), refresh: ['monitor'], keywords: 'quality preview performance' },
  { id: 'playback.safeMargins', section: 'playback', group: 'Program monitor', label: 'Safe margins', description: 'Guides showing where titles stay visible on every screen.', type: 'toggle', default: false, refresh: ['monitor'], keywords: 'title safe action safe' },
  { id: 'playback.handles', section: 'playback', group: 'Program monitor', label: 'Move and size clips in the monitor', description: 'Drag the selected clip, its corners or its rotation handle right in the picture.', type: 'toggle', default: true, refresh: ['monitor'], keywords: 'transform motion direct' },
  { id: 'playback.background', section: 'playback', group: 'Program monitor', label: 'Around the picture', type: 'select', default: 'dark', options: opts(['dark', 'Dark'], ['black', 'Black'], ['mid', 'Grey']), refresh: ['monitor'] },
  { id: 'playback.loop', section: 'playback', group: 'Playing', label: 'Loop when playing in to out', type: 'toggle', default: false, keywords: 'repeat' },
  { id: 'playback.returnOnStop', section: 'playback', group: 'Playing', label: 'Go back to where playing started when stopped', type: 'toggle', default: false },

  // ---------- Media ----------
  { id: 'media.fit', section: 'media', group: 'Fitting', label: 'Pictures of a different size', description: 'How video and pictures that aren’t the sequence’s size fill the frame.', type: 'select', default: 'fit', options: opts(['fit', 'Fit inside the frame'], ['fill', 'Fill the frame (crops)'], ['none', 'Keep their own size']), keywords: 'scale to frame size' },
  { id: 'media.matchFirst', section: 'media', group: 'Fitting', label: 'Match the sequence to the first clip', description: 'When the first video goes into an empty sequence of a different size or frame rate, ask to change the sequence to match it.', type: 'toggle', default: true, keywords: 'sequence settings resolution' },
  { id: 'media.binView', section: 'media', group: 'Project panel', label: 'Show media as', type: 'select', default: 'grid', options: opts(['grid', 'Thumbnails'], ['list', 'A list']), refresh: ['project'] },

  // ---------- Files ----------
  { id: 'files.restore', section: 'files', group: 'Starting', label: 'Show the start page when Frameline opens', type: 'toggle', default: true },
  { id: 'files.autosaveMinutes', section: 'files', group: 'Saving', label: 'Save the project automatically every', description: 'Only projects that were saved once. 0 turns it off.', type: 'number', default: 5, min: 0, max: 60, step: 1, unit: 'minutes', apply: (_v: number, app: App) => app.startAutosave?.(), keywords: 'autosave' },
  { id: 'files.recoveryMinutes', section: 'files', group: 'Saving', label: 'Keep a recovery copy every', description: 'If Frameline closes unexpectedly, the start page offers your unsaved work. 0 turns it off.', type: 'number', default: 2, min: 0, max: 30, step: 1, unit: 'minutes', apply: (_v: number, app: App) => app.startRecovery?.(), keywords: 'crash backup' },
  { id: 'files.undoSteps', section: 'files', group: 'Undo', label: 'Undo steps kept', type: 'number', default: 200, min: 20, max: 1000, step: 10, apply: (v: number, app: App) => app.history && (app.history.limit = v) },

  // ---------- Export ----------
  { id: 'export.hardware', section: 'export', group: 'Encoding', label: 'Use the graphics card to encode', description: 'Much faster on most computers. Turn it off if exports look wrong or fail.', type: 'toggle', default: true, keywords: 'hardware acceleration gpu' },
  { id: 'export.openFolder', section: 'export', group: 'When it’s done', label: 'Show the file in its folder', type: 'toggle', default: false },

  // ---------- Keyboard ----------
  { id: 'keyboard.remember', section: 'keyboard', group: 'Command search', label: 'Remember recently used commands', type: 'toggle', default: true },
  { id: 'keyboard.shortcuts', section: 'keyboard', group: 'Shortcuts', label: 'Keyboard shortcuts', type: 'action', action: { label: 'Show all', run: (app) => app.commands.run('help.shortcuts') } },

  // ---------- Updates ----------
  { id: 'updates.version', section: 'updates', group: 'Version', label: 'Installed version', type: 'info', info: async () => {
    const v = await platform.appVersion();
    return v.includes('-') ? `Frameline ${v} (development build)` : `Frameline ${v}`;
  } },
  { id: 'updates.check', section: 'updates', group: 'Version', label: 'Check for a newer version', type: 'action', desktopOnly: true, action: { label: 'Check now', run: (app) => app.updates.check(false) } },
  { id: 'updates.whatsNew', section: 'updates', group: 'Version', label: "What's new in this version", type: 'action', action: { label: 'Show', run: (app) => app.updates.showWhatsNew() } },
  { id: 'updates.onStartup', section: 'updates', group: 'Automatic updates', label: 'Check for updates when Frameline starts', type: 'toggle', default: true, desktopOnly: true },
  { id: 'updates.autoDownload', section: 'updates', group: 'Automatic updates', label: 'Download updates in the background', description: "You're still asked before anything is installed.", type: 'toggle', default: false, desktopOnly: true },
  { id: 'updates.devBranch', section: 'updates', group: 'Automatic updates', label: 'Developer branch', description: 'Get development builds as soon as they are made. They have the newest features first, but may have bugs.', type: 'toggle', default: false, desktopOnly: true, keywords: 'beta preview development pre-release channel', apply: (v: boolean, app: App) => app.updates?.devBranchChanged(v) },
  { id: 'updates.showNotes', section: 'updates', group: 'Automatic updates', label: "Show what's new after updating", type: 'toggle', default: true },
];
