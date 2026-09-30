# Screen Studio → Cavalry

Rebuilds a [Screen Studio](https://www.screen.studio/) project as a Cavalry composition. This is a port of [screen-studio-to-after-effects](https://github.com/aedev-tools/screen-studio-to-after-effects).

## Install
Requires **ffmpeg** installed in your command line.

Mac: `brew install ffmpeg` in terminal.

1. Copy `ScreenStudioToCavalry.js` into your Cavalry Scripts folder (**Scripts → Show Scripts Folder**).
2. Run it from the **Scripts** menu. A file dialog opens straight away: pick a project and the comp is built.

## Known limits

- Basic audio support
- The webcam is assumed to be 16:9 (or square if that's what Screen Studio is set to), with Fit Cover so it never stretches. 

## Credits

Made possible by the Canva Creative Team and Claude.

## License

MIT. See [LICENSE](LICENSE). Based on [screen-studio-to-after-effects](https://github.com/aedev-tools/screen-studio-to-after-effects) by Michael Nahmias.
