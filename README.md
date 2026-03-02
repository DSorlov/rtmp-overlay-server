# RTMP Overlay Server

A cross-platform application (Windows & macOS) that creates up to 4 RTMP streams, each outputting a greenscreen (#00FF00) background with HTML-rendered overlays. A built-in RTMP server allows external apps (OBS, VLC, etc.) to connect and consume the streams. Templates use `{{placeholder}}` syntax and are controlled via a REST API and a built-in GUI dashboard.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              Electron App (Windows / macOS)           │
│                                                       │
│  ┌──────────┐    ┌────────────────────────────┐      │
│  │ REST API │    │ Off-Screen BrowserWindows   │      │
│  │ (Fastify)│───▶│ (up to 4, one per stream)   │      │
│  │          │    │                              │      │
│  │ Control  │    │ HTML template + #00FF00 BG   │      │
│  └──────────┘    └──────────┬─────────────────┘      │
│                             │ paint event (BGRA)      │
│  ┌──────────┐               ▼                         │
│  │   GUI    │    ┌────────────────────────────┐      │
│  │Dashboard │    │  FFmpeg child processes     │      │
│  │ (preview │    │  (up to 4)                  │      │
│  │  + ctrl) │    │  stdin ← raw frames         │      │
│  └──────────┘    │  output → RTMP push         │      │
│                  └──────────┬─────────────────┘      │
│                             │ rtmp://localhost:1935   │
│                  ┌──────────▼─────────────────┐      │
│                  │  Built-in RTMP Server       │      │
│                  │  (node-media-server)         │      │
│                  │  /live/stream1..stream4      │      │
│                  └────────────────────────────┘      │
└──────────────────────────────────────────────────────┘
         ▲
         │ Clients connect:
         │ rtmp://hostname:1935/live/stream1
```

## Prerequisites

- **Node.js** 18+ and npm
- **FFmpeg** (must be on PATH, or placed in the `ffmpeg/` folder)
  - **Windows**: Download from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (full build) or [BtbN](https://github.com/BtbN/FFmpeg-Builds/releases)
  - **macOS**: `brew install ffmpeg`

## Setup

```bash
npm install
```

### FFmpeg Setup

**Windows:** Place `ffmpeg.exe` in the `ffmpeg/` directory at the project root, or ensure it's on your system PATH.

**macOS:** Install via Homebrew: `brew install ffmpeg`. It will be found automatically on PATH. Alternatively, place the `ffmpeg` binary in the `ffmpeg/` directory.

## Development

```bash
npm start        # Build & launch
npm run dev      # Same as start (build + launch)
```

## Configuration

Edit `config/config.json`:

```json
{
  "apiPort": 3000,
  "rtmpPort": 1935,
  "streams": [
    { "id": 1, "streamName": "stream1", "defaultTemplate": "lower-third.html", "enabled": true },
    { "id": 2, "streamName": "stream2", "defaultTemplate": "lower-third.html", "enabled": true },
    { "id": 3, "streamName": "stream3", "defaultTemplate": "lower-third.html", "enabled": false },
    { "id": 4, "streamName": "stream4", "defaultTemplate": "lower-third.html", "enabled": false }
  ],
  "resolution": { "width": 1920, "height": 1080 },
  "frameRate": 30,
  "ffmpegPath": "ffmpeg"
}
```

- **rtmpPort** — The single port for the built-in RTMP server (default `1935`)
- **streamName** — Used as the RTMP stream key under `/live/` (e.g., `rtmp://host:1935/live/stream1`)

## REST API

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
| `GET` | `/api/streams/:id/preview` | Capture current frame as PNG |
| `GET` | `/api/templates` | List available templates |

### Examples

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
  -d '{"teamA": "Eagles", "teamB": "Hawks", "scoreA": "3", "scoreB": "1", "time": "45:00"}'

# Stop stream
curl -X POST http://localhost:3000/api/streams/1/stop
```

## Templates

Templates are HTML files in the `templates/` folder. Use `{{placeholder}}` syntax for dynamic values. The background is always forced to `#00FF00` (green screen).

For live DOM-based updates (without page reload), add `data-placeholder="key"` attributes to elements:

```html
<div class="score" data-placeholder="score">{{score}}</div>
```

### Included Templates

- **lower-third.html** — Broadcast-style lower third (`{{name}}`, `{{title}}`)
- **scoreboard.html** — Sports scoreboard (`{{teamA}}`, `{{teamB}}`, `{{scoreA}}`, `{{scoreB}}`, `{{time}}`)
- **simple-text.html** — Centered text overlay (`{{message}}`, `{{subtitle}}`)

## Receiving the RTMP Stream

All streams are served from a single RTMP port (default `1935`) with different stream keys.

### VLC
Open Network Stream → `rtmp://hostname:1935/live/stream1`

### FFplay
```bash
ffplay rtmp://hostname:1935/live/stream1
```

### OBS Studio
Add a **Media Source** → Uncheck "Local File" → Input: `rtmp://hostname:1935/live/stream1`

Then apply a **Chroma Key** filter to remove the green background.

## Packaging

```bash
npm run package           # Build for current platform
npm run package:win       # Build Windows NSIS installer
npm run package:mac       # Build macOS DMG (x64 + arm64)
npm run package:portable  # Build Windows portable .exe
```

Output is in the `release/` directory.
