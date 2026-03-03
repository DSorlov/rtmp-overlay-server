# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-03-03

### Added

- **Per-stream background modes**: chroma key, alpha channel (stacked alpha), and luma key with configurable chroma color and luma inversion
- **Per-stream audio support**: template audio capture or system audio device input, mixed into the RTMP output
- **Subtitle system**: real-time speech-to-text subtitles using whisper.cpp with 99-language support
- **Timer system**: per-stream server-side timer (count up/down) with start, stop, reset, and set controls; displayed via `data-timer` elements in templates
- **Configurable resolution and frame rate**: preset and custom resolutions (up to 4K), PAL and NTSC frame rates including 23.976, 29.97, and 59.94 fps
- **Encoding settings**: full H.264 configuration — preset, profile, level, tune, video/audio bitrate, max bitrate, buffer size, GOP size, and pixel format
- **Template function execution**: call global JavaScript functions on overlays via the API or Companion with structured return values
- **User templates directory**: templates synced to `~/Documents/RTMP Overlay Server/templates` for easy customization

### Fixed

- Broken ARM build for macOS
- Streaming settings not applied when updated
- Missing settings and options

## [1.0.0] - 2026-03-02

### Added

- Dynamic HTML overlay rendering with Electron
- Template system using html
- REST API for controlling overlays, templates, and stream settings
- Bitfocus Companion module for remote control integration
- Cross-platform builds for Windows and macOS
