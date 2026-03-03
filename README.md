# RTMP Overlay Server

A cross-platform application (Windows & macOS) that creates RTMP streams, each outputting a render of an HTML template with chroma, luma, or stacked alpha to be used for overlays. A built-in RTMP server allows external apps (OBS, VLC, etc.) or mixers to connect and consume the streams. The system also supports using whisper.cpp to automatically interpret 99 languages and produce subtitles.

## Getting Started

1. Download the installer from the [Releases](../../releases) page or build from source (see [Development](#development))
2. Launch the application — FFmpeg will be downloaded automatically on first run
3. The dashboard shows 4 streams by default, each with a preview and controls
4. Click **Start** on a stream to begin outputting RTMP
5. Connect from OBS, VLC, or any RTMP client using `rtmp://hostname:1935/live/overlay1`

## Streams

Each stream renders an HTML template to an RTMP output. You can run up to 12 streams simultaneously, each with independent settings.

### Starting & Stopping

Use the **Start** / **Stop** buttons in the dashboard, the REST API, or a Companion button to control each stream.

### Choosing a Template

Select a template from the dropdown on each stream card. The template changes immediately, even while the stream is running.

### Editing Placeholder Values

Each template has named placeholders (e.g. `name`, `title`, `scoreA`). Fill in values using the input fields on the stream card and click **Update** to push them to the overlay.

### Stream Key

Each stream has a configurable RTMP stream key (default `overlay1`, `overlay2`, etc.). Change it in the stream settings to use a custom name. Clients connect to `rtmp://hostname:1935/live/<key>`.

## Background Modes

Each stream can use one of three background modes, selectable from the stream settings.

### Chroma Key

The default mode. The overlay background is filled with a solid colour (default green `#00FF00`) which can be keyed out in your video mixer or OBS using a chroma key filter. The colour is configurable per stream.

### Alpha Channel (Stacked Alpha)

Renders the overlay twice — once normally and once with only the alpha information — and stacks them vertically in a single frame (top = colour, bottom = alpha mask). Use this with mixers that support stacked alpha keying for pixel-perfect transparency.

### Luma Key

Uses black (`#000000`) or white (`#FFFFFF`) as the background. The downstream keyer removes the background based on luminance. Toggle "Invert" to switch between black and white backgrounds.

## Audio

Each stream supports three audio modes:

- **None** — Silent output (default)
- **Template** — Captures audio produced by the HTML page itself (e.g. `<audio>` or `<video>` elements)
- **Device** — Captures audio from a system audio input device (microphone, line-in, virtual cable)

Select the audio mode and device from the stream settings panel.

## Subtitles

Real-time speech-to-text subtitles powered by [whisper.cpp](https://github.com/ggerganov/whisper.cpp), supporting 99 languages.

### Setting Up a Whisper Model

1. Open **Settings** → **Speech Recognition Model**
2. Download a model (larger = more accurate but slower):
   - **tiny** (~75 MB) — Fastest, lowest accuracy
   - **base** (~142 MB) — Good balance for most use cases
   - **small** (~466 MB) — Better accuracy
   - **medium** (~1.5 GB) — High accuracy
   - **large-v3** (~3.1 GB) — Best accuracy
3. The whisper.cpp binary is downloaded automatically when subtitles are first enabled

### Using Subtitles

1. Enable subtitles on a stream (toggle in the stream panel or via API)
2. Select the spoken language (or "auto" for detection)
3. Audio from the stream's audio source is transcribed in real time
4. Subtitles appear as TV-style captions at the bottom of the overlay

A dedicated `subtitle.html` template is included, though subtitles are injected into any template automatically.

## Timer

Each stream has a built-in server-side timer that can count up or down.

- **Start / Stop / Reset** from the GUI Timer panel, the REST API, or Companion
- **Set duration** to configure a countdown starting point
- **Direction** — Count up from zero or count down from a set duration
- Templates display the timer on elements with the `data-timer` attribute (e.g. the scoreboard uses it for the match clock)

## Templates

Templates are HTML files stored in `~/Documents/RTMP Overlay Server/templates/`. Bundled templates are synced to this directory on first launch, and the app prompts to update them when newer versions are available. You can add your own templates to this folder — they appear in the template dropdown automatically.

### Included Templates

| Template | Description | Placeholders |
|----------|-------------|--------------|
| **lower-third.html** | Broadcast-style lower third | `name`, `title` |
| **breaking-news.html** | Breaking news banner | `headline`, `message` |
| **scoreboard.html** | Sports scoreboard with timer | `teamA`, `teamB`, `scoreA`, `scoreB` |
| **simple-text.html** | Centred text overlay with timer | `message`, `subtitle` |
| **title-card.html** | Full-screen title card with timer | `title`, `subtitle` |
| **name-tag.html** | Name tag overlay | `name`, `title` |
| **minimal-lower.html** | Minimal lower third | `name`, `title` |
| **sidebar.html** | Side panel overlay | `title`, `content` |
| **subtitle.html** | Dedicated subtitle display | — |

### Creating Your Own Templates

Create an HTML file in the templates folder. Use `{{placeholder}}` for dynamic values and `data-placeholder="key"` attributes for live DOM updates:

```html
<div class="score" data-placeholder="score">{{score}}</div>
```

For timer display, use the `data-timer` attribute:

```html
<span data-timer>00:00</span>
```

Templates can also expose JavaScript functions callable via the API or Companion:

```html
<script>
  window.showAlert = function(message) {
    // your logic here
    return { shown: true };
  };
</script>
```

## Connecting from External Applications

All streams are served from a single RTMP port (default `1935`) with different stream keys.

### OBS Studio

1. Add a **Media Source** → uncheck "Local File" → Input: `rtmp://hostname:1935/live/overlay1`
2. Apply the appropriate filter for your background mode:
   - **Chroma mode** — Add a **Chroma Key** filter to remove the green background
   - **Alpha mode** — Use a stacked alpha shader or plugin
   - **Luma mode** — Add a **Luma Key** filter to remove the black or white background

### VLC

Open Network Stream → `rtmp://hostname:1935/live/overlay1`

### FFplay

```bash
ffplay rtmp://hostname:1935/live/overlay1
```

## Settings

All settings are accessible from the **Settings** page in the GUI.

### General

- **Stream count** — Number of streams (1–12). Changing this requires Apply & Save.
- **API port** — Port for the REST API (default `3000`). Requires Apply & Save.
- **RTMP port** — Port for the built-in RTMP server (default `1935`). Requires Apply & Save.

### Stream Output

- **Resolution** — Presets: 1920×1080, 1280×720, 3840×2160, 2560×1440, 1024×576, or custom
- **Frame rate** — 15, 23.976 (NTSC Film), 24, 25 (PAL), 29.97 (NTSC), 30, 50 (PAL), 59.94 (NTSC), 60 fps

### Encoding

Full H.264 configuration: preset, profile, level, tune, video bitrate, max bitrate, buffer size, GOP size, audio bitrate, and pixel format.

> Stream Output and Encoding settings **auto-save** on change and take effect on the next stream start.

## Companion Module

A [Bitfocus Companion](https://bitfocus.io/companion) module is included for hardware control surface integration.

- **Actions** — Start/stop streams, change template, update placeholders, set chroma colour, set background mode, set audio mode, toggle subtitles, set subtitle language, timer start/stop/toggle/reset/set, execute template functions
- **Feedbacks** — Stream running/stopped status, subtitle enabled state, timer running state
- **Variables** — Timer display, subtitle status, stream status per stream

---

## Technical Reference

### Architecture

```
┌──────────────────────────────────────────────────────┐
│              Electron App (Windows / macOS)           │
│                                                       │
│  ┌──────────┐    ┌────────────────────────────┐      │
│  │ REST API │    │ Off-Screen BrowserWindows   │      │
│  │ (Fastify)│───▶│                             │      │
│  │          │    │                              │      │
│  │ Control  │    │ HTML template + BG colour    │      │
│  └──────────┘    └──────────┬─────────────────┘      │
│                             │ paint event (BGRA)      │
│  ┌──────────┐               ▼                         │
│  │   GUI    │    ┌────────────────────────────┐      │
│  │Dashboard │    │  FFmpeg child processes     │      │
│  │ (preview │    │                             │      │
│  │  + ctrl) │    │  stdin ← raw frames         │      │
│  └──────────┘    │  output → RTMP push         │      │
│                  └──────────┬─────────────────┘      │
│                             │ rtmp://localhost:1935   │
│                  ┌──────────▼─────────────────┐      │
│                  │  Built-in RTMP Server       │      │
│                  │  (node-media-server)         │      │
│                  │  /live/overlay1..overlay4    │      │
│                  └────────────────────────────┘      │
└──────────────────────────────────────────────────────┘
         ▲
         │ Clients connect:
         │ rtmp://hostname:1935/live/overlay1
```

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/streams` | List all streams with status |
| `GET` | `/api/streams/:id` | Get single stream details |
| `POST` | `/api/streams/:id/start` | Start a stream |
| `POST` | `/api/streams/:id/stop` | Stop a stream |
| `PUT` | `/api/streams/:id/template` | Change template: `{ "template": "scoreboard.html" }` |
| `PATCH` | `/api/streams/:id/data` | Update placeholders (merge): `{ "name": "John" }` |
| `PUT` | `/api/streams/:id/data` | Replace all placeholders: `{ "name": "John", "title": "Host" }` |
| `PUT` | `/api/streams/:id/chroma` | Set chroma key colour: `{ "color": "#00FF00" }` |
| `PUT` | `/api/streams/:id/background-mode` | Set background mode: `{ "mode": "chroma\|alpha\|luma" }` |
| `PUT` | `/api/streams/:id/luma-inverted` | Set luma inversion: `{ "inverted": true }` |
| `PUT` | `/api/streams/:id/audio-mode` | Set audio mode: `{ "mode": "none\|template\|device" }` |
| `PUT` | `/api/streams/:id/audio-device` | Set audio device: `{ "device": "deviceId" }` |
| `PUT` | `/api/streams/:id/stream-key` | Set stream key: `{ "key": "mystream" }` |
| `PUT` | `/api/streams/:id/subtitles-enabled` | Enable/disable subtitles: `{ "enabled": true }` |
| `PUT` | `/api/streams/:id/subtitle-language` | Set subtitle language: `{ "language": "en" }` |
| `POST` | `/api/streams/:id/execute` | Call template function: `{ "function": "myFunc", "argument": "value" }` |
| `POST` | `/api/streams/:id/timer/start` | Start the timer |
| `POST` | `/api/streams/:id/timer/stop` | Stop (pause) the timer |
| `POST` | `/api/streams/:id/timer/reset` | Reset the timer to zero |
| `PUT` | `/api/streams/:id/timer/duration` | Set timer duration: `{ "seconds": 300 }` |
| `PUT` | `/api/streams/:id/timer/direction` | Set timer direction: `{ "direction": "up\|down" }` |
| `GET` | `/api/streams/:id/preview` | Capture current frame as PNG |
| `GET` | `/api/templates` | List available templates with placeholders |
| `GET` | `/api/templates/:name/placeholders` | Get placeholders for a specific template |
| `GET` | `/api/stats` | Get RTMP server statistics |

#### API Examples

```bash
# Start stream 1
curl -X POST http://localhost:3000/api/streams/1/start

# Set template
curl -X PUT http://localhost:3000/api/streams/1/template \
  -H "Content-Type: application/json" \
  -d '{"template": "scoreboard.html"}'

# Update placeholder values
curl -X PATCH http://localhost:3000/api/streams/1/data \
  -H "Content-Type: application/json" \
  -d '{"teamA": "Eagles", "teamB": "Hawks", "scoreA": "3", "scoreB": "1"}'

# Switch to alpha channel mode
curl -X PUT http://localhost:3000/api/streams/1/background-mode \
  -H "Content-Type: application/json" \
  -d '{"mode": "alpha"}'

# Enable subtitles in English
curl -X PUT http://localhost:3000/api/streams/1/subtitles-enabled \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
curl -X PUT http://localhost:3000/api/streams/1/subtitle-language \
  -H "Content-Type: application/json" \
  -d '{"language": "en"}'

# Start a 5-minute countdown timer
curl -X PUT http://localhost:3000/api/streams/1/timer/duration \
  -H "Content-Type: application/json" \
  -d '{"seconds": 300}'
curl -X PUT http://localhost:3000/api/streams/1/timer/direction \
  -H "Content-Type: application/json" \
  -d '{"direction": "down"}'
curl -X POST http://localhost:3000/api/streams/1/timer/start

# Stop stream
curl -X POST http://localhost:3000/api/streams/1/stop
```

### Configuration File

The configuration file is at `config/config.json`. Most settings can be changed from the GUI, but the file can also be edited directly.

```json
{
  "apiPort": 3000,
  "rtmpPort": 1935,
  "streams": [
    { "id": 1, "streamName": "overlay1", "defaultTemplate": "lower-third.html", "enabled": true },
    { "id": 2, "streamName": "overlay2", "defaultTemplate": "lower-third.html", "enabled": true },
    { "id": 3, "streamName": "overlay3", "defaultTemplate": "lower-third.html", "enabled": true },
    { "id": 4, "streamName": "overlay4", "defaultTemplate": "lower-third.html", "enabled": true }
  ],
  "resolution": { "width": 1920, "height": 1080 },
  "frameRate": 30,
  "encoding": {
    "preset": "ultrafast",
    "profile": "baseline",
    "level": "4.0",
    "tune": "zerolatency",
    "videoBitrate": 4000,
    "maxBitrate": 4500,
    "bufferSize": 8000,
    "gopSize": 0,
    "audioBitrate": 128,
    "pixelFormat": "yuv420p"
  },
  "ffmpegPath": "ffmpeg",
  "whisperModel": "base"
}
```

### Development

#### Prerequisites

- **Node.js** 18+ and npm
- **FFmpeg** — automatically downloaded on first run, or install manually:
  - **Windows**: Download from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) or [BtbN](https://github.com/BtbN/FFmpeg-Builds/releases)
  - **macOS**: `brew install ffmpeg`

#### Running from Source

```bash
npm install
npm start        # Build & launch
npm run dev      # Same as start
```

#### Packaging

```bash
npm run package           # Build for current platform
npm run package:win       # Build Windows NSIS installer
npm run package:mac       # Build macOS DMG (x64 + arm64)
npm run package:portable  # Build Windows portable .exe
```

Output is in the `release/` directory.
