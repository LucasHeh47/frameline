# Developing Frameline

Frameline is an [Electron](https://www.electronjs.org/) app written in TypeScript, with no UI framework. Video is decoded and encoded with the WebCodecs API through [Mediabunny](https://mediabunny.dev/), pictures are composited with WebGL 2, and sound is mixed with the Web Audio API — so there's no ffmpeg or other native code.

## Setup

You need [Node.js](https://nodejs.org/) 22 and Git. Then:

```
git clone https://github.com/LucasHeh47/frameline.git
cd frameline
npm install
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the app with hot reload |
| `npm start` | Builds, then runs the production app |
| `npm test` | Runs the test suite (Vitest) |
| `npm run typecheck` | Type-checks the app and the Electron code |
| `npm run build` | Builds `dist/` (UI) and `dist-electron/` (main + preload) |
| `npm run dist` | Builds the Windows installer and portable exe into `release/` |

## Project layout

| Path | Contents |
| --- | --- |
| `src/core/` | The editor's model, with no UI: projects, sequences, tracks and clips (`project.ts`), every edit (`edit.ts`: insert, overwrite, razor, ripple / roll / slip / slide trims, rate stretch, speed, transitions…), what plays at a frame (`timeline.ts`), keyframes (`anim.ts`), effect definitions (`effects.ts`), presets, undo, timecode, captions and LUTs |
| `src/render/` | The WebGL 2 compositor: shaders for Motion, blend modes, every video effect and transition, and titles |
| `src/media/` | Media on the UI side: probing files, thumbnails and waveforms (`library.ts`), live playback (`player.ts`), audio effects (`audioGraph.ts`) and export (`export.ts`) |
| `src/ui/` | The interface: the app shell (`app.ts`), panel layout and workspaces (`layout.ts`), menus, commands and shortcuts, start page |
| `src/ui/timeline/` | The timeline (drawn on a canvas) and the tools |
| `src/ui/panels/` | Program and Source monitors, Project, Effect Controls, Effects, Lumetri Color, Audio Mixer, Markers, History |
| `src/ui/dialogs/` | Sequence settings, Speed / Duration, audio gain, scene detection, captions, export |
| `electron/` | Main process (windows, files, the `media://` protocol, export writing, recovery, updates) and the preload bridge |
| `tests/` | Unit tests for the model |

## How it fits together

- **One model, everywhere.** `core/timeline.ts` says what's on screen and what's heard at any frame, transitions included. The Program monitor, the exporter and the audio mixer all ask it, so the preview and the exported file match.
- **Timeline positions are frames**; where a clip starts in its file is in seconds, so media of any frame rate can go in any sequence.
- **Every change is undoable**: `App.edit(label, fn)` copies the project, runs the change and records the copy. Dragging uses `App.liveEdit` (one undo step per drag); the timeline previews drags on a copy of the sequence.
- **Playback** keeps a `<video>` element per visible clip in step with the playhead and routes each clip's sound through Web Audio (volume, balance, effects, track and master levels). The compositor draws the elements' current frames.
- **Export** decodes exact frames with Mediabunny, draws them with the same compositor, mixes the sound offline with the same audio graph, encodes with WebCodecs and streams the file to disk through the main process.
- **Files** reach the UI through the `media://` protocol (with byte ranges, so long videos seek without loading). The main process only serves files the user picked, dropped, or that an opened project uses.

## Testing without dialogs

Running an unpackaged build with `FRAMELINE_TEST_SAVE_DIR=<folder>` makes save dialogs (projects, exports, frames) answer with that folder instead of asking. Use a separate profile so your own settings aren't touched:

```
npx electron . clip.mp4 --user-data-dir=%TEMP%\frameline-test
```

Media files given on the command line are imported into the new project.

## Releases

Pushes to `develop` publish a development build (a pre-release like `v0.1.0-beta.3`); tags like `v0.1.0` on `main` publish a release. Installed copies update themselves from these.
