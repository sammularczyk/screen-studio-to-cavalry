# Screen Studio → Cavalry

Rebuilds a [Screen Studio](https://www.screen.studio/) project as a Cavalry composition. This is a port of [screen-studio-to-after-effects](https://github.com/aedev-tools/screen-studio-to-after-effects).

## Install

Requires `ffprobe`, which comes with ffmpeg (`brew install ffmpeg`). Screen Studio records at a variable frame rate: the file claims 120fps, but frames are only written when the screen changes. Cavalry plays video frames at a fixed rate, so the video would drift seconds away from the cursor. The script reads each frame's real timestamp and keyframes the Image Shader's **Time** to match. Cavalry will ask you to trust the script the first time it runs `ffprobe`. Without ffprobe the import still works, but it warns you that the video will drift.

1. Copy `ScreenStudioToCavalry.js` into your Cavalry Scripts folder (**Scripts → Show Scripts Folder**).
2. Run it from the **Scripts** menu. A file dialog opens straight away: pick a project and the comp is built.

## What you get

A new composition at the recording's native resolution (or Screen Studio's output aspect ratio, if the project sets one), at 30fps, containing:

- **Background**: the project's solid colour, gradient, or your own background image (with its blur). Screen Studio's built-in wallpapers are its own artwork, so they aren't copied: you get the project's gradient instead and a note to swap in your own image.
- **Screen Recording** group: holds the zoom and pan keyframes. Inside it are:
  - **Screen**: a rounded rectangle with an Image Shader and a Drop Shadow.
  - **Cursor**: a group that follows the mouse. It holds one image per cursor type used (arrow, text beam, custom app cursors and so on), each with its hotspot on the mouse position, swapped with opacity keys when the cursor changes.
- **Slices**: trims, cuts and speed changes are applied, so the comp is as long as the edited timeline. Video, cursor, clicks and zooms all follow it.
- **Zoom**: scale and position keyframes on the group for *every* zoom range. The AE version only did the first one. Zoom length comes from Screen Studio's zoom spring (`screenMovementSpring`). Back-to-back ranges glide into each other. Follow-click ranges pan to the clicks, and manual ranges aim at their target point.
- **Cursor motion**: smoothed with Screen Studio's own mouse spring (the stiffness, damping and mass in `project.json`), or left raw if the project is set to accurate (`disableMouseMovementSpring`). It hides where a slice hides the cursor or when the mouse is idle past Screen Studio's timeout. The linear keyframes are thinned to only the ones needed to stay within 3pt of that path.
- **Webcam** (if recorded): rounded corners, a drop shadow, and placement taken from Screen Studio's camera settings.
- **Audio**: Sound behaviours for the microphone (the enhanced version if there is one) and system audio.

At the top of the script:

- `FPS`: Screen Studio picks the frame rate when you export, so it isn't in the project file.
- `TIME_TOLERANCE` (comp frames) and `CURSOR_TOLERANCE` (points): how far the thinned video Time and cursor keyframes may stray from the real data. Raise them for fewer keys, lower them for more accuracy.

## Known limits

- Cavalry can't load AAC/`.m4a` audio. If a track won't load, the script lists the path so you can convert it to `.wav` and add it yourself.
- Audio plays uncut: Sound behaviours can't follow trims and speed changes.
- The webcam is assumed to be 16:9 (or square if that's what Screen Studio is set to), with Fit Cover so it never stretches. Cavalry can't read video resolution at import time.
- Not yet handled: cursor rotation and click animation, motion blur, and the per-slice "accurate cursor" switch.
- No sample project uses an image background or sets an output aspect ratio, so those two are untested.

## License

MIT. See [LICENSE](LICENSE). Based on [screen-studio-to-after-effects](https://github.com/aedev-tools/screen-studio-to-after-effects) by Michael Nahmias.
