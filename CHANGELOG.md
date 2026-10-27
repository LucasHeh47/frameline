# Changelog

## Unreleased

- **Smoother playback.** While playing, Frameline redid a lot of work on every frame: the timeline (waveforms and all) was redrawn just to move the playhead, panels made the page lay itself out again, the play button and every keyframe row were rebuilt, and the Markers list was rebuilt (which also interrupted typing a marker's name). It now does about a third of the work.
- **Fixed a leak** that added listeners to the duration readout on every frame while playing.
- Filmstrip thumbnails and the waveforms of long files are worked out faster.
- **Checking for updates** no longer says something went wrong when there's no regular release yet.

## 0.1.0

The first version of Frameline, a video editor in the style of Premiere Pro.

- **Projects and media:** import video (MP4, MOV, WebM, MKV), sound (MP3, WAV, M4A, OGG, FLAC) and pictures, or drop them on the window. The Project panel shows thumbnails you can scrub, bins, sequences and missing files to locate. Projects save automatically and are recovered after a crash.
- **Timeline:** as many video and audio tracks as you need, with thumbnails and waveforms, snapping, markers, in and out points, track lock, mute, solo and sync lock. Clips and their sound stay linked.
- **Editing tools:** Selection, Track Select, Ripple, Rolling, Rate Stretch, Razor, Slip, Slide, Hand, Zoom and Type, with Premiere's keys. Insert and overwrite, lift and extract, ripple delete, Ctrl+K to cut, Q / W to trim to the playhead, nudging, copy, paste and paste attributes.
- **Source and Program monitors:** mark the part of a file you want and drop it in; move, scale and rotate clips right in the picture, and edit titles there.
- **Effect Controls with keyframes:** Motion, Opacity and blend modes, speed and reverse, frame holds, volume and balance, with easing.
- **Effects:** Lumetri Color (with Auto and .cube looks), Brightness & Contrast, Hue / Saturation, Black & White, Sepia, Tint, Invert, Posterize, Gaussian Blur, Sharpen, Glow, Ultra Key (green screen), Luma Key, Crop, Flip, Mask, Drop Shadow, Mosaic and Film Grain; adjustment layers; presets for fades, slow zooms, picture-in-picture and looks.
- **Transitions:** Cross Dissolve, Dip to Black / White, Blur Dissolve, Wipe, Iris, Slide, Push and Cross Zoom; audio crossfades.
- **Titles and captions:** title styles (lower third, subtitle, big statement…), and subtitles from .srt / .vtt files (and back).
- **Sound:** an Audio Mixer with faders, balance and meters; Amplify, EQ, Highpass, Lowpass, Dynamics, Reverb, Delay and Channels; audio gain and normalize; voice-over recording onto a track; auto-ducking of music under speech.
- **Smart helpers:** remove pauses (automatic jump cuts), beat markers and cut at markers, reframe a sequence to vertical or square, YouTube chapters from markers, scene edit detection, match the sequence to the first clip, Lumetri Auto, and waveform / RGB parade / vectorscope scopes in Lumetri Color.
- **Export:** MP4 (H.264), WebM (VP9) and MOV, or M4A / WAV sound, using the graphics card's encoder; presets for YouTube, Shorts / Reels / TikTok and podcasts; loudness normalization (−14 LUFS and others) with a peak limiter; Export Frame for stills.
