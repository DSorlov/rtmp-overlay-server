import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { loadConfig, saveConfig } from './config';
import { TemplateManager } from './template-manager';
import { StreamManager } from './stream-manager';
import { RtmpServer } from './rtmp-server';
import { createApiServer } from './api';
import { ensureFFmpeg } from './ffmpeg-downloader';
import { ensureWhisper, downloadWhisper, setActiveModel, clearActiveModel, getWhisperModelStatus, downloadWhisperModel, deleteWhisperModel, cancelWhisperModelDownload } from './whisper-downloader';
import { FFmpegManager } from './ffmpeg-manager';
import type { FastifyInstance } from 'fastify';

// Enable reliable off-screen rendering on Windows
// (GPU compositing can produce black frames in headless/offscreen windows)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');

// Prevent EPIPE and other uncaught errors from crashing the app
process.on('uncaughtException', (err) => {
  console.error('[Main] Uncaught exception:', err.message);
  // Don't exit — EPIPE errors from FFmpeg pipes are recoverable
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});

let mainWindow: BrowserWindow | null = null;
let streamManager: StreamManager | null = null;
let templateManager: TemplateManager | null = null;
let rtmpServer: RtmpServer | null = null;
let apiServer: FastifyInstance | null = null;
let previewInterval: NodeJS.Timeout | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// ── Network helpers ───────────────────────────────────────────

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      // Skip internal (loopback) and non-IPv4
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return os.hostname(); // fallback to hostname
}

// ── State persistence ─────────────────────────────────────────

interface PersistedStreamState {
  currentTemplate: string;
  placeholderData: Record<string, string>;
  wasRunning: boolean;
}

interface PersistedState {
  streams: Record<number, PersistedStreamState>;
}

function getStatePath(): string {
  return path.join(app.getPath('userData'), 'stream-state.json');
}

function loadPersistedState(): PersistedState | null {
  try {
    const p = getStatePath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const state = JSON.parse(raw) as PersistedState;
      console.log('[Main] Restored saved state from', p);
      return state;
    }
  } catch (err: any) {
    console.warn('[Main] Could not load saved state:', err.message);
  }
  return null;
}

function saveState(): void {
  if (!streamManager) return;
  try {
    const persisted: PersistedState = { streams: {} };
    for (const s of streamManager.getAllStreams()) {
      persisted.streams[s.id] = {
        currentTemplate: s.currentTemplate,
        placeholderData: { ...s.placeholderData },
        wasRunning: s.status === 'running' || s.status === 'starting',
      };
    }
    const p = getStatePath();
    fs.writeFileSync(p, JSON.stringify(persisted, null, 2), 'utf-8');
    console.log('[Main] State saved to', p);
  } catch (err: any) {
    console.warn('[Main] Could not save state:', err.message);
  }
}

// ── Application menu ──────────────────────────────────────────

function showAboutDialog(): void {
  const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf-8'));

  dialog.showMessageBox({
    type: 'info',
    icon,
    title: 'About RTMP Overlay Server',
    message: 'RTMP Overlay Server',
    detail: [
      `Version: ${pkg.version}`,
      `Electron: ${process.versions.electron}`,
      `Node: ${process.versions.node}`,
      `Chrome: ${process.versions.chrome}`,
      '',
      pkg.description || '',
    ].join('\n'),
    buttons: ['OK'],
  });
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { label: 'About RTMP Overlay Server', click: () => showAboutDialog() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      ...(!isMac ? [
        { label: 'About RTMP Overlay Server', click: () => showAboutDialog() } as Electron.MenuItemConstructorOptions,
        { type: 'separator' as const },
      ] : []),
      {
        label: 'Open Templates Folder',
        click: () => {
          if (templateManager) {
            shell.openPath(templateManager.getUserTemplatesDir());
          }
        },
      },
      { type: 'separator' },
      isMac ? { role: 'close' as const } : { role: 'quit' as const },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      ...(isMac ? [
        { type: 'separator' as const },
        { role: 'front' as const },
      ] : [
        { role: 'close' as const },
      ]),
    ],
  });

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

async function createMainWindow(): Promise<BrowserWindow> {
  // Resolve preload script path — src/renderer/ is included in both dev and packaged builds
  const preloadPath = path.join(app.getAppPath(), 'src', 'renderer', 'preload.js');

  const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'RTMP Overlay Server',
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: '#1a1a2e',
  });

  // Load the dashboard HTML
  const rendererPath = path.join(app.getAppPath(), 'src', 'renderer', 'index.html');

  console.log('[Main] Loading renderer from:', rendererPath);

  await win.loadFile(rendererPath);

  // Minimize to tray instead of closing
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      // On macOS, also hide from dock when minimized to tray
      if (process.platform === 'darwin') {
        app.dock?.hide();
      }
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

// ── System tray ───────────────────────────────────────────────

function createTray(): void {
  const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip('RTMP Overlay Server');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => showWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Double-click (Windows) or click (macOS) to show
  tray.on('double-click', () => showWindow());
  if (process.platform === 'darwin') {
    tray.on('click', () => showWindow());
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Window was destroyed; re-create it
    createMainWindow().then((win) => {
      mainWindow = win;
      if (process.platform === 'darwin') app.dock?.show();
    });
    return;
  }
  if (process.platform === 'darwin') app.dock?.show();
  mainWindow.show();
  mainWindow.focus();
}

function sendToRenderer(channel: string, data: any): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function setupIPC(): void {
  if (!streamManager || !templateManager) return;

  // Renderer requests initial data (also sent proactively on did-finish-load)
  ipcMain.on('request-init', () => {
    if (!streamManager || !templateManager) return;
    const config = loadConfig();
    // Build placeholder map for all templates
    const templatePlaceholders: Record<string, string[]> = {};
    for (const t of templateManager.listTemplates()) {
      templatePlaceholders[t] = templateManager.getPlaceholders(t);
    }
    sendToRenderer('init-data', {
      streams: streamManager.getAllStreams(),
      templates: templateManager.listTemplates(),
      templatePlaceholders,
      apiPort: config.apiPort,
      rtmpPort: config.rtmpPort,
      resolution: config.resolution,
      frameRate: config.frameRate,
      encoding: config.encoding,
      hostIP: getLocalIP(),
      whisperModels: getWhisperModelStatus(),
    });
  });

  // Renderer requests placeholder keys for a specific template
  ipcMain.on('get-template-placeholders', (_event, templateName: string) => {
    if (!templateManager) return;
    try {
      const keys = templateManager.getPlaceholders(templateName);
      sendToRenderer('template-placeholders', { template: templateName, placeholders: keys });
    } catch (err: any) {
      console.error(`[IPC] getPlaceholders failed for ${templateName}:`, err.message);
    }
  });

  // Renderer requests stream actions
  ipcMain.on('stream-action', async (_event, payload) => {
    const { action, streamId, template, data } = payload;

    try {
      switch (action) {
        case 'start':
          await streamManager!.startStream(streamId);
          break;
        case 'stop':
          await streamManager!.stopStream(streamId);
          break;
        case 'change-template':
          await streamManager!.changeTemplate(streamId, template);
          break;
        case 'update-data':
          await streamManager!.updateData(streamId, data);
          break;
        case 'set-data':
          await streamManager!.setData(streamId, data);
          break;
        case 'set-chroma': {
          const { color } = payload;
          const effectiveColor = color || '#00FF00';
          const config = streamManager!.getConfig();
          const sc = config.streams.find(s => s.id === streamId);
          if (sc) {
            sc.chromaKeyColor = effectiveColor;
            saveConfig(config);
          }
          await streamManager!.updateStreamChromaColor(streamId, effectiveColor);
          break;
        }
        case 'set-background-mode': {
          const { mode } = payload;
          if (mode !== 'chroma' && mode !== 'alpha' && mode !== 'luma') break;
          const config = streamManager!.getConfig();
          const sc = config.streams.find(s => s.id === streamId);
          if (sc) {
            sc.backgroundMode = mode;
            saveConfig(config);
          }
          await streamManager!.updateStreamBackgroundMode(streamId, mode);
          break;
        }
        case 'set-luma-inverted': {
          const { inverted } = payload;
          const config = streamManager!.getConfig();
          const sc = config.streams.find(s => s.id === streamId);
          if (sc) {
            sc.lumaInverted = !!inverted;
            saveConfig(config);
          }
          await streamManager!.updateStreamLumaInverted(streamId, !!inverted);
          break;
        }
        case 'set-audio-mode': {
          const { mode } = payload;
          if (mode !== 'none' && mode !== 'template' && mode !== 'device') break;
          const config = streamManager!.getConfig();
          const sc = config.streams.find(s => s.id === streamId);
          if (sc) {
            sc.audioMode = mode;
            saveConfig(config);
          }
          await streamManager!.updateStreamAudioMode(streamId, mode);
          break;
        }
        case 'set-audio-device': {
          const { device } = payload;
          const config = streamManager!.getConfig();
          const sc = config.streams.find(s => s.id === streamId);
          if (sc) {
            sc.audioDevice = device || '';
            saveConfig(config);
          }
          await streamManager!.updateStreamAudioDevice(streamId, device || '');
          break;
        }
        case 'set-stream-key': {
          const { key } = payload;
          const trimmed = (key || '').trim();
          if (!trimmed) break;
          const config = streamManager!.getConfig();
          const sc = config.streams.find(s => s.id === streamId);
          if (sc) {
            sc.streamName = trimmed;
            saveConfig(config);
          }
          await streamManager!.updateStreamKey(streamId, trimmed);
          break;
        }
        case 'set-subtitles-enabled': {
          const { enabled } = payload;
          const config = streamManager!.getConfig();
          const sc = config.streams.find(s => s.id === streamId);
          if (sc) {
            sc.subtitlesEnabled = !!enabled;
            saveConfig(config);
          }
          // If enabling, ensure whisper binary is downloaded
          if (enabled && !config.whisperPath) {
            try {
              const whisperPath = await downloadWhisper(mainWindow);
              config.whisperPath = whisperPath;
              saveConfig(config);
            } catch {
              // Download cancelled or failed — don't enable subtitles
              if (sc) sc.subtitlesEnabled = false;
              saveConfig(config);
              break;
            }
          }
          // If enabling, ensure a model is downloaded
          if (enabled) {
            const models = getWhisperModelStatus();
            const anyDownloaded = models.some(m => m.downloaded);
            if (!anyDownloaded) {
              // No model available — ask user to pick one
              if (sc) sc.subtitlesEnabled = false;
              saveConfig(config);
              sendToRenderer('whisper-model-needed', { streamId });
              break;
            }
            // If the active model isn't downloaded, auto-select the first downloaded one
            const activeModel = models.find(m => m.active);
            if (!activeModel || !activeModel.downloaded) {
              const firstDownloaded = models.find(m => m.downloaded);
              if (firstDownloaded) {
                setActiveModel(firstDownloaded.id);
                config.whisperModel = firstDownloaded.id;
                saveConfig(config);
              }
            }
          }
          await streamManager!.updateStreamSubtitles(streamId, !!enabled);
          break;
        }
        case 'set-subtitle-language': {
          const { language } = payload;
          const langVal = language || 'auto';
          const config = streamManager!.getConfig();
          const sc = config.streams.find(s => s.id === streamId);
          if (sc) {
            sc.subtitleLanguage = langVal;
            saveConfig(config);
          }
          await streamManager!.updateStreamSubtitleLanguage(streamId, langVal);
          break;
        }
        case 'execute-function': {
          const { functionName, argument } = payload;
          if (!functionName) break;
          const fnResult = await streamManager!.executeFunction(streamId, functionName, argument);
          sendToRenderer('function-result', { streamId, functionName, ...fnResult });
          break;
        }
        case 'timer-set-duration': {
          const { seconds } = payload;
          streamManager!.setTimerDuration(streamId, Number(seconds) || 0);
          break;
        }
        case 'timer-set-direction': {
          const { direction } = payload;
          if (direction !== 'up' && direction !== 'down') break;
          streamManager!.setTimerDirection(streamId, direction);
          break;
        }
        case 'timer-start': {
          streamManager!.startTimer(streamId);
          break;
        }
        case 'timer-stop': {
          streamManager!.stopTimer(streamId);
          break;
        }
        case 'timer-reset': {
          streamManager!.resetTimer(streamId);
          break;
        }
      }
    } catch (err: any) {
      console.error(`[IPC] Action '${action}' failed for stream ${streamId}:`, err.message);
    }
  });

  // Renderer requests audio device list
  ipcMain.on('get-audio-devices', async () => {
    try {
      const config = loadConfig();
      const devices = await FFmpegManager.listAudioDevicesDetailed(config.ffmpegPath);
      sendToRenderer('audio-devices', devices);
    } catch (err: any) {
      console.error('[IPC] get-audio-devices failed:', err.message);
      sendToRenderer('audio-devices', []);
    }
  });

  // ── Whisper model management ──────────────────────────────

  // Get status of all whisper models (downloaded / active)
  ipcMain.on('get-whisper-status', () => {
    sendToRenderer('whisper-status', getWhisperModelStatus());
  });

  // Set the active whisper model
  ipcMain.on('set-whisper-model', (_event, modelId: string) => {
    try {
      setActiveModel(modelId);
      const config = loadConfig();
      config.whisperModel = modelId;
      saveConfig(config);
      sendToRenderer('whisper-status', getWhisperModelStatus());
    } catch (err: any) {
      console.error('[IPC] set-whisper-model failed:', err.message);
    }
  });

  // Download a specific whisper model
  ipcMain.on('download-whisper-model', async (_event, modelId: string) => {
    try {
      await downloadWhisperModel(modelId, mainWindow);
      sendToRenderer('whisper-status', getWhisperModelStatus());
    } catch (err: any) {
      console.error('[IPC] download-whisper-model failed:', err.message);
      sendToRenderer('whisper-status', getWhisperModelStatus());
    }
  });

  // Cancel an active model download
  ipcMain.on('cancel-whisper-download', () => {
    cancelWhisperModelDownload();
  });

  // User picked a model from the model-needed dialog
  ipcMain.on('whisper-model-selected', async (_event, payload: { modelId: string; streamId: number }) => {
    const { modelId, streamId } = payload;
    try {
      // Download the chosen model
      await downloadWhisperModel(modelId, mainWindow);

      // Set it as active
      setActiveModel(modelId);
      const config = loadConfig();
      config.whisperModel = modelId;
      saveConfig(config);

      sendToRenderer('whisper-status', getWhisperModelStatus());

      // Now enable subtitles on the stream that triggered it
      if (streamManager) {
        const sc = config.streams.find(s => s.id === streamId);
        if (sc) {
          sc.subtitlesEnabled = true;
          saveConfig(config);
        }
        await streamManager.updateStreamSubtitles(streamId, true);
      }
    } catch (err: any) {
      console.error('[IPC] whisper-model-selected failed:', err.message);
      sendToRenderer('whisper-status', getWhisperModelStatus());
    }
  });

  // Delete a downloaded whisper model
  ipcMain.on('delete-whisper-model', async (_event, modelId: string) => {
    try {
      const status = getWhisperModelStatus();
      const model = status.find(m => m.id === modelId);

      // If deleting the active model, disable subtitles on all streams first
      if (model && model.active && streamManager) {
        const config = streamManager.getConfig();
        for (const sc of config.streams) {
          if (sc.subtitlesEnabled) {
            sc.subtitlesEnabled = false;
            await streamManager.updateStreamSubtitles(sc.id, false);
          }
        }
        clearActiveModel();
        config.whisperModel = '';
        saveConfig(config);
      }

      deleteWhisperModel(modelId);
      sendToRenderer('whisper-status', getWhisperModelStatus());
    } catch (err: any) {
      console.error('[IPC] delete-whisper-model failed:', err.message);
      sendToRenderer('whisper-status', getWhisperModelStatus());
    }
  });

  // Auto-save output config (resolution, framerate, encoding) without restart
  ipcMain.on('save-output-config', (_event, payload) => {
    if (!streamManager) return;
    try {
      const config = streamManager.getConfig();
      if (payload.resolution) {
        config.resolution = { width: payload.resolution.width, height: payload.resolution.height };
      }
      if (payload.frameRate != null) {
        config.frameRate = payload.frameRate;
      }
      if (payload.encoding) {
        config.encoding = { ...config.encoding, ...payload.encoding };
      }
      saveConfig(config);
      console.log('[Main] Output config auto-saved');
    } catch (err: any) {
      console.error('[Main] Output config save failed:', err.message);
    }
  });

  // Renderer requests settings update
  ipcMain.on('update-settings', async (_event, payload) => {
    if (!streamManager || !templateManager) return;
    const { streamCount, apiPort: newApiPort, rtmpPort: newRtmpPort } = payload;

    try {
      const config = streamManager.getConfig();
      const currentCount = config.streams.length;

      // ─ 1. Reduce streams if count lowered ─
      if (streamCount < currentCount) {
        for (let id = currentCount; id > streamCount; id--) {
          await streamManager.removeStream(id);
        }
        config.streams = config.streams.filter(s => s.id <= streamCount);
      }

      // ─ 2. Add streams if count raised ─
      if (streamCount > currentCount) {
        for (let id = currentCount + 1; id <= streamCount; id++) {
          const streamName = `overlay${id}`;
          const sc = { id, streamName, defaultTemplate: 'lower-third.html', enabled: true };
          config.streams.push(sc);
          streamManager.addStream(sc);
        }
      }

      // ─ 3. Handle RTMP port change ─
      const rtmpChanged = newRtmpPort && newRtmpPort !== config.rtmpPort;
      if (rtmpChanged) {
        // Stop all streams first
        await streamManager.stopAll();
        // Restart RTMP server on new port
        if (rtmpServer) {
          rtmpServer.stop();
          rtmpServer = null;
        }
        config.rtmpPort = newRtmpPort;
        rtmpServer = new RtmpServer(newRtmpPort);
        rtmpServer.start();
        rtmpServer.on('stats-update', (stats: Record<string, any>) => {
          sendToRenderer('rtmp-stats', stats);
        });
        streamManager.updateRtmpPort(newRtmpPort);
      }

      // ─ 4. Handle API port change ─
      const apiChanged = newApiPort && newApiPort !== config.apiPort;
      if (apiChanged) {
        if (apiServer) {
          await apiServer.close();
          apiServer = null;
        }
        config.apiPort = newApiPort;
        apiServer = await createApiServer(streamManager, templateManager, newApiPort, rtmpServer!);
      }

      // ─ 5. Save config to disk ─
      saveConfig(config);

      // ─ 6. Send refreshed state to renderer ─
      const templatePlaceholders: Record<string, string[]> = {};
      for (const t of templateManager.listTemplates()) {
        templatePlaceholders[t] = templateManager.getPlaceholders(t);
      }
      sendToRenderer('init-data', {
        streams: streamManager.getAllStreams(),
        templates: templateManager.listTemplates(),
        templatePlaceholders,
        apiPort: config.apiPort,
        rtmpPort: config.rtmpPort,
        resolution: config.resolution,
        frameRate: config.frameRate,
        encoding: config.encoding,
        hostIP: getLocalIP(),
        whisperModels: getWhisperModelStatus(),
      });

      sendToRenderer('settings-saved', { success: true });
      console.log('[Main] Settings updated successfully');
    } catch (err: any) {
      console.error('[Main] Settings update failed:', err.message);
      sendToRenderer('settings-saved', { success: false, error: err.message });
    }
  });
}

function startPreviewUpdates(): void {
  // Periodically capture thumbnails and send to the GUI
  previewInterval = setInterval(async () => {
    if (!streamManager || !mainWindow || mainWindow.isDestroyed()) return;

    for (const stream of streamManager.getAllStreams()) {
      if (stream.status === 'running') {
        try {
          const pngBuffer = await streamManager.captureFrame(stream.id);
          if (pngBuffer) {
            const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
            sendToRenderer('preview-frame', {
              streamId: stream.id,
              dataUrl,
            });
          }
        } catch {
          // Ignore capture errors
        }
      }
    }
  }, 2000); // Update previews every 2 seconds
}

async function main(): Promise<void> {
  console.log('[Main] RTMP Overlay Server starting...');

  try {
    // Load configuration
    const config = loadConfig();
    console.log(`[Main] Loaded config: ${config.streams.length} streams, RTMP port ${config.rtmpPort}, API port ${config.apiPort}`);

    // Initialize template manager and sync bundled templates to user directory
    templateManager = new TemplateManager();
    const updatedTemplates = templateManager.syncTemplates();
    const templates = templateManager.listTemplates();
    console.log(`[Main] Templates dir: ${templateManager.getUserTemplatesDir()}`);
    console.log(`[Main] Found ${templates.length} templates: ${templates.join(', ')}`);
    if (updatedTemplates.length > 0) {
      console.log(`[Main] ${updatedTemplates.length} bundled template(s) have newer versions`);
    }

    // Ensure FFmpeg is available (downloads automatically if missing)
    const ffmpegPath = await ensureFFmpeg();
    config.ffmpegPath = ffmpegPath;
    console.log(`[Main] Using FFmpeg: ${ffmpegPath}`);

    // Check for whisper.cpp (don't prompt — download happens when subtitles are first enabled)
    const whisperPath = await ensureWhisper();
    config.whisperPath = whisperPath;
    if (whisperPath) {
      console.log(`[Main] Using Whisper: ${whisperPath}`);
    } else {
      console.log('[Main] Whisper not found — will download when subtitles are enabled');
    }

    // Set the active whisper model from config
    setActiveModel(config.whisperModel || 'base');

    // Start the RTMP server
    rtmpServer = new RtmpServer(config.rtmpPort);
    rtmpServer.start();

    // Forward RTMP client stats to the GUI
    rtmpServer.on('stats-update', (stats: Record<string, any>) => {
      sendToRenderer('rtmp-stats', stats);
    });

    // Initialize stream manager
    streamManager = new StreamManager(config, templateManager);

    // Restore persisted state (template selections + placeholder data + running status)
    const savedState = loadPersistedState();
    let autoStartIds: number[] = [];
    if (savedState) {
      autoStartIds = streamManager.restoreState(savedState.streams);
    }

    // Forward stream updates to the GUI
    streamManager.on('streamUpdate', (state) => {
      sendToRenderer('stream-update', state);
      // When a stream stops, clear its RTMP stats immediately
      // (node-media-server may not detect FFmpeg disconnect promptly)
      if (state.status === 'stopped' && rtmpServer) {
        rtmpServer.clearStreamStats(state.streamName);
      }
    });

    // Start the REST API server
    apiServer = await createApiServer(streamManager, templateManager, config.apiPort, rtmpServer);

    // Set up IPC BEFORE creating the window (so handlers are ready when renderer loads)
    setupIPC();

    // Set up application menu
    buildAppMenu();

    // Create the GUI window
    mainWindow = await createMainWindow();

    // Create system tray icon
    createTray();

    // Push initial data to the renderer after a short delay
    // to ensure the preload bridge and renderer listeners are ready
    setTimeout(() => {
      console.log('[Main] Sending init-data to renderer');
      if (streamManager && templateManager) {
        const templatePlaceholders: Record<string, string[]> = {};
        for (const t of templateManager.listTemplates()) {
          templatePlaceholders[t] = templateManager.getPlaceholders(t);
        }
        sendToRenderer('init-data', {
          streams: streamManager.getAllStreams(),
          templates: templateManager.listTemplates(),
          templatePlaceholders,
          apiPort: config.apiPort,
          rtmpPort: config.rtmpPort,
          resolution: config.resolution,
          frameRate: config.frameRate,
          encoding: config.encoding,
          hostIP: getLocalIP(),
          whisperModels: getWhisperModelStatus(),
        });
      }
    }, 300);

    // Start sending preview frames to the GUI
    startPreviewUpdates();

    // Auto-start streams that were running in the previous session
    if (autoStartIds.length > 0) {
      console.log('[Main] Auto-starting streams that were previously running:', autoStartIds);
      for (const id of autoStartIds) {
        streamManager.startStream(id).catch((err: any) => {
          console.warn(`[Main] Failed to auto-start stream ${id}:`, err.message);
        });
      }
    }

    // Prompt user if bundled templates have been updated
    if (updatedTemplates.length > 0 && mainWindow) {
      const names = updatedTemplates.map(t => t.name);
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Update All', 'Skip'],
        defaultId: 1,
        cancelId: 1,
        title: 'Template Updates Available',
        message: `${names.length} included template${names.length > 1 ? 's have' : ' has'} been updated:`,
        detail: names.join('\n') + '\n\nWould you like to replace your copies with the new versions? Your customisations will be lost for the selected templates.',
      });
      if (result.response === 0) {
        templateManager.applyBundledUpdates(names);
        console.log('[Main] User accepted template updates');
        // Reload updated templates in any running streams
        if (streamManager) {
          await streamManager.reloadTemplates(names);
        }
        // Refresh template list in the renderer
        const templatePlaceholders: Record<string, string[]> = {};
        for (const t of templateManager.listTemplates()) {
          templatePlaceholders[t] = templateManager.getPlaceholders(t);
        }
        sendToRenderer('templates-updated', templateManager.listTemplates());
        sendToRenderer('init-data', {
          streams: streamManager!.getAllStreams(),
          templates: templateManager.listTemplates(),
          templatePlaceholders,
          apiPort: config.apiPort,
          rtmpPort: config.rtmpPort,
          resolution: config.resolution,
          frameRate: config.frameRate,
          encoding: config.encoding,
          hostIP: getLocalIP(),
          whisperModels: getWhisperModelStatus(),
        });
      } else {
        console.log('[Main] User skipped template updates');
      }
    }

    console.log('[Main] Application ready');
  } catch (err: any) {
    console.error('[Main] Failed to start:', err.message);
    dialog.showErrorBox('Startup Error', `The application failed to start:\n\n${err.message}`);
    app.quit();
  }
}

// ── Electron App Lifecycle ────────────────────────

app.whenReady().then(main);

/**
 * Perform all cleanup: save state, stop streams, stop servers.
 * Call this before quitting so child processes don't keep the app alive.
 */
async function shutdownAll(): Promise<void> {
  console.log('[Main] Shutting down...');

  // Save UI state (template selections + placeholder data)
  saveState();

  // Stop preview updates
  if (previewInterval) {
    clearInterval(previewInterval);
    previewInterval = null;
  }

  // Stop all streams (kills FFmpeg child processes)
  if (streamManager) {
    await streamManager.stopAll();
    streamManager = null;
  }

  // Stop RTMP server
  if (rtmpServer) {
    rtmpServer.stop();
    rtmpServer = null;
  }

  // Close API server
  if (apiServer) {
    await apiServer.close();
    apiServer = null;
  }
}

app.on('window-all-closed', () => {
  // Don't quit — the app lives in the tray
  // (window is hidden, not destroyed, unless isQuitting)
});

app.on('activate', async () => {
  // On macOS, re-show/re-create the window when dock icon is clicked
  showWindow();
});

app.on('before-quit', async (e) => {
  isQuitting = true;
  if (streamManager || rtmpServer || apiServer) {
    e.preventDefault();
    await shutdownAll();
    // Destroy tray icon
    if (tray) { tray.destroy(); tray = null; }
    app.exit(0);
  }
});
