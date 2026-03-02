import { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { loadConfig, saveConfig } from './config';
import { TemplateManager } from './template-manager';
import { StreamManager } from './stream-manager';
import { RtmpServer } from './rtmp-server';
import { createApiServer } from './api';
import { ensureFFmpeg } from './ffmpeg-downloader';
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
      hostIP: getLocalIP(),
      chromaKeyColor: config.chromaKeyColor,
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
          const config = streamManager!.getConfig();
          const sc = config.streams.find(s => s.id === streamId);
          if (sc) {
            if (!color || color === config.chromaKeyColor) {
              delete sc.chromaKeyColor;
            } else {
              sc.chromaKeyColor = color;
            }
            saveConfig(config);
          }
          const effectiveColor = color || config.chromaKeyColor;
          await streamManager!.updateStreamChromaColor(streamId, effectiveColor);
          break;
        }
      }
    } catch (err: any) {
      console.error(`[IPC] Action '${action}' failed for stream ${streamId}:`, err.message);
    }
  });

  // Renderer requests settings update
  ipcMain.on('update-settings', async (_event, payload) => {
    if (!streamManager || !templateManager) return;
    const { streamCount, streamKeys, apiPort: newApiPort, rtmpPort: newRtmpPort, chromaKeyColor: newChromaKeyColor } = payload;

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
          const streamName = (streamKeys && streamKeys[id]) || `overlay${id}`;
          const sc = { id, streamName, defaultTemplate: 'lower-third.html', enabled: true };
          config.streams.push(sc);
          streamManager.addStream(sc);
        }
      }

      // ─ 3. Update stream keys for existing streams ─
      if (streamKeys) {
        for (const [idStr, key] of Object.entries(streamKeys)) {
          const id = Number(idStr);
          if (id > streamCount) continue;
          const sc = config.streams.find(s => s.id === id);
          if (sc) sc.streamName = key as string;
          await streamManager.updateStreamKey(id, key as string);
        }
      }

      // ─ 4. Handle RTMP port change ─
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

      // ─ 5. Handle API port change ─
      const apiChanged = newApiPort && newApiPort !== config.apiPort;
      if (apiChanged) {
        if (apiServer) {
          await apiServer.close();
          apiServer = null;
        }
        config.apiPort = newApiPort;
        apiServer = await createApiServer(streamManager, templateManager, newApiPort, rtmpServer!);
      }

      // ─ 6. Update default chroma key color ─
      if (newChromaKeyColor && newChromaKeyColor !== config.chromaKeyColor) {
        config.chromaKeyColor = newChromaKeyColor;
        // Update any stream that was using the old global default
        for (const state of streamManager.getAllStreams()) {
          const sc = config.streams.find(s => s.id === state.id);
          if (sc && !sc.chromaKeyColor) {
            // Stream uses global default — update its effective color (restarts if running)
            await streamManager.updateStreamChromaColor(state.id, newChromaKeyColor);
          }
        }
      }

      // ─ 7. Save config to disk ─
      saveConfig(config);

      // ─ 7. Send refreshed state to renderer ─
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
        hostIP: getLocalIP(),
        chromaKeyColor: config.chromaKeyColor,
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

    // Initialize template manager
    templateManager = new TemplateManager();
    const templates = templateManager.listTemplates();
    console.log(`[Main] Found ${templates.length} templates: ${templates.join(', ')}`);

    // Ensure FFmpeg is available (downloads automatically if missing)
    const ffmpegPath = await ensureFFmpeg();
    config.ffmpegPath = ffmpegPath;
    console.log(`[Main] Using FFmpeg: ${ffmpegPath}`);

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
          hostIP: getLocalIP(),
          chromaKeyColor: config.chromaKeyColor,
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
