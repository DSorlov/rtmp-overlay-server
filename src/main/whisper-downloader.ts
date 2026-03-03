import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { execSync } from 'child_process';

/**
 * Download URLs for whisper.cpp pre-built binaries per platform/arch.
 *
 * Windows:       official ggml-org/whisper.cpp releases (v1.8.3)
 * macOS ARM64:   bizenlabs/whisper-cpp-macos-bin (v1.8.2, Metal GPU)
 * macOS x86_64:  bizenlabs/whisper-cpp-macos-bin (v1.8.2, Accelerate)
 */
const WHISPER_BINARIES: Record<string, { url: string; binaryName: string }> = {
  'win32-x64': {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip',
    binaryName: 'whisper-cli.exe',
  },
  'darwin-x64': {
    url: 'https://github.com/bizenlabs/whisper-cpp-macos-bin/releases/download/v1.8.2-2/whisper-cpp-v1.8.2-macos-x86_64-accelerate.zip',
    binaryName: 'whisper-cli',
  },
  'darwin-arm64': {
    url: 'https://github.com/bizenlabs/whisper-cpp-macos-bin/releases/download/v1.8.2-2/whisper-cpp-v1.8.2-macos-arm64-metal.zip',
    binaryName: 'whisper-cli',
  },
};

/**
 * Whisper model definitions — name, HuggingFace filename, and approximate size.
 */
export interface WhisperModelInfo {
  id: string;
  label: string;
  filename: string;
  url: string;
  sizeMB: number;
}

export const WHISPER_MODELS: WhisperModelInfo[] = [
  { id: 'tiny',     label: 'Tiny (75 MB)',      filename: 'ggml-tiny.bin',     url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',     sizeMB: 75 },
  { id: 'base',     label: 'Base (142 MB)',      filename: 'ggml-base.bin',     url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',     sizeMB: 142 },
  { id: 'small',    label: 'Small (466 MB)',     filename: 'ggml-small.bin',    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',    sizeMB: 466 },
  { id: 'medium',   label: 'Medium (1.5 GB)',    filename: 'ggml-medium.bin',   url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',   sizeMB: 1500 },
  { id: 'large-v3', label: 'Large v3 (3.1 GB)',  filename: 'ggml-large-v3.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin', sizeMB: 3100 },
];

/** Currently active model id (set from config at startup) */
let activeModelId = 'base';

/** Track the in-progress model download so it can be cancelled */
let activeDownloadAbort: (() => void) | null = null;
let activeDownloadModelId: string | null = null;

export function setActiveModel(modelId: string): void {
  const m = WHISPER_MODELS.find(m => m.id === modelId);
  if (m) activeModelId = modelId;
}

/** Clear the active model (no model selected). */
export function clearActiveModel(): void {
  activeModelId = '';
}

function getActiveModel(): WhisperModelInfo {
  return WHISPER_MODELS.find(m => m.id === activeModelId) || WHISPER_MODELS[1]; // fallback to base
}

/**
 * Whisper model to download — defaults to ggml-base.bin (~142 MB).
 */
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_FILENAME = 'ggml-base.bin';

/**
 * Directory where auto-downloaded whisper binary + model are stored.
 */
export function getWhisperUserDir(): string {
  return path.join(app.getPath('userData'), 'whisper');
}

export function getWhisperBinaryPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getWhisperUserDir(), `whisper-cpp${ext}`);
}

export function getWhisperModelPath(): string {
  return path.join(getWhisperUserDir(), getActiveModel().filename);
}

/**
 * Get model path for a specific model id.
 */
export function getWhisperModelPathForId(modelId: string): string {
  const m = WHISPER_MODELS.find(m => m.id === modelId);
  return path.join(getWhisperUserDir(), m ? m.filename : MODEL_FILENAME);
}

/**
 * Search for an existing whisper binary:
 *   1. userData/whisper/ (auto-downloaded)
 *   2. System PATH (user-installed)
 *
 * Returns the absolute path or null if not found.
 */
export function findWhisper(): string | null {
  // 1. Previously downloaded to userData
  const userBin = getWhisperBinaryPath();
  if (fs.existsSync(userBin)) return userBin;

  // 2. System PATH — look for 'whisper-cli' or 'whisper-cpp' or 'main' (whisper.cpp binary names)
  for (const name of ['whisper-cli', 'whisper-cpp', 'main']) {
    try {
      const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
      const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (result) {
        const first = result.split(/\r?\n/)[0].trim();
        if (first) return first;
      }
    } catch {
      // not on PATH
    }
  }

  return null;
}

/**
 * Check if the whisper model file exists.
 */
export function hasWhisperModel(): boolean {
  return fs.existsSync(getWhisperModelPath());
}

/**
 * Get info about all available models, including which are downloaded.
 */
export function getWhisperModelStatus(): Array<WhisperModelInfo & { downloaded: boolean; active: boolean; downloading: boolean }> {
  const dir = getWhisperUserDir();
  return WHISPER_MODELS.map(m => ({
    ...m,
    downloaded: fs.existsSync(path.join(dir, m.filename)),
    active: m.id === activeModelId,
    downloading: m.id === activeDownloadModelId,
  }));
}

// ─── Download helpers ────────────────────────────────────────────

function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number) => void,
  onAbortRegistration?: (abortFn: () => void) => void,
  maxRedirects = 10,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'RTMPOverlayServer/1.0' } }, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect without Location header'));
        res.resume();
        downloadFile(location, destPath, onProgress, onAbortRegistration, maxRedirects - 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;

      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const file = fs.createWriteStream(destPath);

      // Register abort function so caller can cancel the download
      if (onAbortRegistration) {
        onAbortRegistration(() => {
          req.destroy();
          res.destroy();
          file.close();
          try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* ignore */ }
          reject(new Error('Download cancelled'));
        });
      }

      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (totalBytes > 0 && onProgress) {
          onProgress(Math.round((received / totalBytes) * 100));
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', (err) => {
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* ignore */ }
        reject(err);
      });
    });

    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error('Connection timed out'));
    });
  });
}

function extractZip(zipPath: string, destDir: string): void {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'"`,
      { timeout: 300_000 },
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { timeout: 300_000 });
  }
}

function findFileRecursive(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = findFileRecursive(fullPath, name);
      if (result) return result;
    } else if (entry.name === name) {
      return fullPath;
    }
  }
  return null;
}

// ─── Progress window ────────────────────────────────────────────

function createProgressWindow(title: string, parent?: BrowserWindow | null, showCancel = false): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: showCancel ? 230 : 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    frame: true,
    title,
    parent: parent || undefined,
    modal: !!parent,
    webPreferences: {
      nodeIntegration: showCancel,
      contextIsolation: !showCancel,
    },
    backgroundColor: '#1a1a2e',
  });

  win.setMenuBarVisibility(false);

  const cancelBtnHtml = showCancel
    ? `<div style="text-align:center"><button id="cancel-btn" style="display:none;margin-top:10px;padding:5px 18px;border:1px solid #ef5350;border-radius:4px;background:transparent;color:#ef5350;font-size:12px;font-weight:600;cursor:pointer;">Cancel</button></div>`
    : '';

  const cancelScript = showCancel
    ? `<script>
        const { ipcRenderer } = require('electron');
        document.getElementById('cancel-btn').addEventListener('click', () => {
          ipcRenderer.send('cancel-download');
          document.getElementById('cancel-btn').disabled = true;
          document.getElementById('cancel-btn').textContent = 'Cancelling…';
        });
      </script>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body {
    margin: 0; padding: 24px 28px;
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: #1a1a2e; color: #e0e0e0;
    display: flex; flex-direction: column; justify-content: center; height: calc(100vh - 48px);
  }
  h3 { margin: 0 0 6px; font-size: 16px; color: #fff; }
  .status { font-size: 13px; color: #90caf9; margin-bottom: 14px; }
  .track { width: 100%; height: 22px; background: rgba(255,255,255,0.08); border-radius: 11px; overflow: hidden; }
  .bar { height: 100%; width: 0%; background: linear-gradient(90deg, #4fc3f7, #29b6f6); border-radius: 11px;
         transition: width 0.3s ease; }
  .pct { text-align: center; margin-top: 8px; font-size: 13px; color: #78909c; }
</style>
</head>
<body>
  <h3 id="title">${title}…</h3>
  <p class="status" id="status">Connecting…</p>
  <div class="track"><div class="bar" id="bar"></div></div>
  <div class="pct" id="pct">0 %</div>
  ${cancelBtnHtml}
  ${cancelScript}
</body>
</html>`;

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

function updateProgress(win: BrowserWindow, percent: number, status?: string): void {
  if (win.isDestroyed()) return;
  win.webContents.executeJavaScript(`
    document.getElementById('bar').style.width = '${percent}%';
    document.getElementById('pct').textContent = '${percent} %';
    ${status ? `document.getElementById('status').textContent = '${status}';` : ''}
  `).catch(() => {});
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Ensure whisper.cpp binary + model are available. Downloads automatically if missing.
 * Returns the absolute path to the whisper binary, or empty string if unavailable.
 */
export async function ensureWhisper(parentWindow?: BrowserWindow | null): Promise<string> {
  const existing = findWhisper();
  const modelExists = hasWhisperModel();

  if (existing && modelExists) {
    console.log(`[Whisper] Binary at: ${existing}, model at: ${getWhisperModelPath()}`);
    return existing;
  }

  console.log('[Whisper] Binary or model missing, will download when subtitles are first enabled');

  // Don't auto-prompt at startup — return empty string.
  // Download will be triggered when user enables subtitles.
  return '';
}

/**
 * Download whisper binary + model with a progress dialog.
 * Called when the user first enables subtitles.
 */
export async function downloadWhisper(parentWindow?: BrowserWindow | null): Promise<string> {
  const platformKey = `${process.platform}-${process.arch}`;
  const source = WHISPER_BINARIES[platformKey];

  if (!source) {
    const msg = `No automatic whisper.cpp download available for ${process.platform} ${process.arch}.\n\nPlease install whisper.cpp manually.`;
    dialog.showErrorBox('Whisper Not Found', msg);
    throw new Error(msg);
  }

  const choice = await dialog.showMessageBox({
    type: 'question',
    title: 'Whisper.cpp Required for Subtitles',
    message: 'Whisper.cpp speech recognition is needed for live subtitles.',
    detail:
      'This will download:\n' +
      '• whisper.cpp binary (~5 MB)\n' +
      '• Base speech model (~142 MB)\n\n' +
      'Download now?',
    buttons: ['Download Now', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });

  if (choice.response === 1) {
    throw new Error('Whisper download cancelled by user');
  }

  const tmpDir = path.join(app.getPath('temp'), 'rtmp-overlay-whisper');
  const targetDir = getWhisperUserDir();

  // Clean up any previous partial downloads
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  const progressWin = createProgressWindow('Downloading Whisper', parentWindow);

  try {
    const needBinary = !findWhisper();
    const needModel = !hasWhisperModel();

    let binaryPath = findWhisper() || '';

    // ── Step 1: Download pre-built binary ──
    if (needBinary) {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

      const zipPath = path.join(tmpDir, 'whisper.zip');
      const extractDir = path.join(tmpDir, 'extracted');

      console.log(`[Whisper] Downloading binary from: ${source.url}`);
      updateProgress(progressWin, 0, 'Downloading whisper.cpp…');

      await downloadFile(source.url, zipPath, (pct) => {
        updateProgress(progressWin, Math.round(pct * 0.15), `Downloading binary… ${pct}%`);
      });

      updateProgress(progressWin, 16, 'Extracting binary…');
      extractZip(zipPath, extractDir);

      // Find the CLI binary and copy to target
      const found = findFileRecursive(extractDir, source.binaryName);
      if (!found) {
        throw new Error(`Could not find ${source.binaryName} in the downloaded archive`);
      }

      // Copy required shared libraries (DLLs on Windows, dylibs on macOS)
      const extractParent = path.dirname(found);
      for (const entry of fs.readdirSync(extractParent)) {
        if (entry.endsWith('.dll') || entry.endsWith('.dylib')) {
          fs.copyFileSync(path.join(extractParent, entry), path.join(targetDir, entry));
        }
      }

      // Also walk one level up — bizenlabs zips put libs in lib/ alongside bin/
      const extractGrandparent = path.dirname(extractParent);
      const libDir = path.join(extractGrandparent, 'lib');
      if (fs.existsSync(libDir) && fs.statSync(libDir).isDirectory()) {
        for (const entry of fs.readdirSync(libDir)) {
          if (entry.endsWith('.dylib') || entry.endsWith('.dll')) {
            fs.copyFileSync(path.join(libDir, entry), path.join(targetDir, entry));
          }
        }
      }

      binaryPath = getWhisperBinaryPath();
      fs.copyFileSync(found, binaryPath);
      if (process.platform !== 'win32') {
        fs.chmodSync(binaryPath, 0o755);
      }
      console.log(`[Whisper] Binary installed to: ${binaryPath}`);
    }

    // ── Step 2: Download model ──
    if (needModel) {
      const modelPath = getWhisperModelPath();
      console.log(`[Whisper] Downloading model from: ${MODEL_URL}`);
      updateProgress(progressWin, 25, 'Downloading speech model (~142 MB)…');

      await downloadFile(MODEL_URL, modelPath, (pct) => {
        const overall = 25 + Math.round(pct * 0.7);
        updateProgress(progressWin, overall, `Downloading model… ${pct}%`);
      });

      console.log(`[Whisper] Model installed to: ${modelPath}`);
    }

    updateProgress(progressWin, 100, 'Done!');
    await new Promise((r) => setTimeout(r, 800));

    return binaryPath;
  } catch (err: any) {
    console.error('[Whisper] Download/install failed:', err.message);
    dialog.showErrorBox(
      'Whisper Download Failed',
      `Could not download whisper.cpp:\n\n${err.message}\n\nSubtitles will be unavailable until whisper.cpp is installed.`,
    );
    throw err;
  } finally {
    if (!progressWin.isDestroyed()) {
      progressWin.destroy();
    }
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * Download a specific whisper model by id. Shows a progress dialog.
 * Returns the path to the downloaded model file.
 */
export async function downloadWhisperModel(
  modelId: string,
  parentWindow?: BrowserWindow | null,
): Promise<string> {
  const model = WHISPER_MODELS.find(m => m.id === modelId);
  if (!model) throw new Error(`Unknown whisper model: ${modelId}`);

  const modelPath = path.join(getWhisperUserDir(), model.filename);

  // Already downloaded?
  if (fs.existsSync(modelPath)) {
    console.log(`[Whisper] Model ${model.id} already at: ${modelPath}`);
    return modelPath;
  }

  // Ensure whisper dir exists
  const dir = getWhisperUserDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const progressWin = createProgressWindow(`Downloading ${model.label}`, parentWindow, true);

  activeDownloadModelId = modelId;

  // Listen for cancel from the progress window's Cancel button
  const cancelHandler = () => {
    if (activeDownloadAbort) activeDownloadAbort();
  };
  ipcMain.on('cancel-download', cancelHandler);

  try {
    console.log(`[Whisper] Downloading model ${model.id} from: ${model.url}`);
    updateProgress(progressWin, 0, `Downloading ${model.label}…`);

    await downloadFile(model.url, modelPath, (pct) => {
      updateProgress(progressWin, pct, `Downloading ${model.label}… ${pct}%`);
    }, (abortFn) => {
      activeDownloadAbort = abortFn;
      // Show the Cancel button now that the download is active
      progressWin.webContents.executeJavaScript(`
        const cancelBtn = document.getElementById('cancel-btn');
        if (cancelBtn) cancelBtn.style.display = 'inline-block';
      `).catch(() => {});
    });

    updateProgress(progressWin, 100, 'Done!');
    console.log(`[Whisper] Model ${model.id} installed to: ${modelPath}`);
    await new Promise((r) => setTimeout(r, 600));

    return modelPath;
  } catch (err: any) {
    console.error(`[Whisper] Model download failed:`, err.message);
    // Clean up partial download
    try { if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath); } catch { /* ignore */ }
    throw err;
  } finally {
    ipcMain.removeListener('cancel-download', cancelHandler);
    activeDownloadAbort = null;
    activeDownloadModelId = null;
    if (!progressWin.isDestroyed()) progressWin.destroy();
  }
}

/**
 * Cancel an active model download (if any).
 */
export function cancelWhisperModelDownload(): void {
  if (activeDownloadAbort) {
    console.log('[Whisper] Cancelling active model download');
    activeDownloadAbort();
  }
}

/**
 * Delete a downloaded model file.
 */
export function deleteWhisperModel(modelId: string): boolean {
  const model = WHISPER_MODELS.find(m => m.id === modelId);
  if (!model) return false;
  const modelPath = path.join(getWhisperUserDir(), model.filename);
  if (fs.existsSync(modelPath)) {
    fs.unlinkSync(modelPath);
    console.log(`[Whisper] Deleted model: ${modelPath}`);
    return true;
  }
  return false;
}
