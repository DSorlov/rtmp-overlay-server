import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { app, BrowserWindow, dialog } from 'electron';
import { execSync } from 'child_process';

/**
 * Download URLs for static FFmpeg builds per platform/arch.
 *
 * Windows x64  — BtbN GPL build (includes libx264 for H.264 encoding)
 * macOS x64/arm64 — evermeet.cx release zip (single universal binary)
 */
const FFMPEG_SOURCES: Record<string, { url: string; nested: boolean }> = {
  'win32-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    nested: true,  // zip contains ffmpeg-master-…/bin/ffmpeg.exe
  },
  'darwin-x64': {
    url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    nested: false, // zip contains ffmpeg directly
  },
  'darwin-arm64': {
    url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    nested: false,
  },
};

/**
 * Directory where auto-downloaded FFmpeg is stored.
 * Uses Electron's userData so it survives app updates and is always writable.
 */
export function getFFmpegUserDir(): string {
  return path.join(app.getPath('userData'), 'ffmpeg');
}

/**
 * Full path to the downloaded FFmpeg binary.
 */
export function getFFmpegUserBinaryPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getFFmpegUserDir(), `ffmpeg${ext}`);
}

/**
 * Search for an existing FFmpeg binary in multiple locations (ordered by priority):
 *   1. Bundled with the app (resourcesPath/ffmpeg/)
 *   2. Auto-downloaded (userData/ffmpeg/)
 *   3. Local project folder (dev mode only)
 *   4. System PATH
 *
 * Returns the absolute path or null if not found.
 */
export function findFFmpeg(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';

  // 1. Bundled in resources (placed there by electron-builder extraResources)
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'ffmpeg', `ffmpeg${ext}`);
    if (fs.existsSync(bundled)) return bundled;
  }

  // 2. Previously downloaded to userData
  const userBin = getFFmpegUserBinaryPath();
  if (fs.existsSync(userBin)) return userBin;

  // 3. Local project folder (dev mode)
  if (!app.isPackaged) {
    const local = path.join(__dirname, '..', '..', 'ffmpeg', `ffmpeg${ext}`);
    if (fs.existsSync(local)) return local;
  }

  // 4. System PATH
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    const result = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (result) {
      const first = result.split(/\r?\n/)[0].trim();
      if (first) return first;
    }
  } catch {
    // not on PATH
  }

  return null;
}

// ─── Download helpers ────────────────────────────────────────────

/**
 * Follow redirects and download a file, reporting progress via callback.
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number) => void,
  maxRedirects = 10,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));

    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'RTMPOverlayServer/1.0' } }, (res) => {
      // Handle redirects
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect without Location header'));
        res.resume(); // drain the response
        downloadFile(location, destPath, onProgress, maxRedirects - 1).then(resolve, reject);
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
        fs.unlinkSync(destPath);
        reject(err);
      });
    });

    req.on('error', reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error('Connection timed out'));
    });
  });
}

/**
 * Extract a zip to a directory using platform-native tools.
 */
function extractZip(zipPath: string, destDir: string): void {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  if (process.platform === 'win32') {
    // PowerShell's Expand-Archive (available on Win10+)
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'"`,
      { timeout: 300_000 },
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { timeout: 300_000 });
  }
}

/**
 * After extraction, find the ffmpeg binary inside potentially nested directories
 * (e.g. BtbN builds have ffmpeg-master-…/bin/ffmpeg.exe) and move it to the
 * target directory.
 */
function findAndMoveBinary(extractDir: string, targetDir: string): string {
  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const targetPath = path.join(targetDir, binaryName);

  // If it's already at the top level (evermeet.cx style), just move it
  const topLevel = path.join(extractDir, binaryName);
  if (fs.existsSync(topLevel)) {
    fs.copyFileSync(topLevel, targetPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(targetPath, 0o755);
    }
    return targetPath;
  }

  // Search recursively (BtbN style: nested-dir/bin/ffmpeg.exe)
  const found = findFileRecursive(extractDir, binaryName);
  if (!found) {
    throw new Error(`Could not find ${binaryName} in the downloaded archive`);
  }

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(found, targetPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(targetPath, 0o755);
  }
  return targetPath;
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

function createProgressWindow(parent?: BrowserWindow | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    frame: true,
    title: 'Downloading FFmpeg',
    parent: parent || undefined,
    modal: !!parent,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    backgroundColor: '#1a1a2e',
  });

  win.setMenuBarVisibility(false);

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
  <h3>Downloading FFmpeg…</h3>
  <p class="status" id="status">Connecting…</p>
  <div class="track"><div class="bar" id="bar"></div></div>
  <div class="pct" id="pct">0 %</div>
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
 * Ensure FFmpeg is available. If not found, prompt the user and download it.
 * Returns the absolute path to the ffmpeg binary.
 */
export async function ensureFFmpeg(parentWindow?: BrowserWindow | null): Promise<string> {
  const existing = findFFmpeg();
  if (existing) {
    console.log(`[FFmpeg] Found at: ${existing}`);
    return existing;
  }

  console.log('[FFmpeg] Not found anywhere, prompting for download…');

  const platformKey = `${process.platform}-${process.arch}`;
  const source = FFMPEG_SOURCES[platformKey];

  if (!source) {
    const msg = `No automatic FFmpeg download available for ${process.platform} ${process.arch}.\n\nPlease install FFmpeg manually and make sure it is on your system PATH.`;
    dialog.showErrorBox('FFmpeg Not Found', msg);
    throw new Error(msg);
  }

  // Ask the user
  const choice = await dialog.showMessageBox({
    type: 'question',
    title: 'FFmpeg Required',
    message: 'FFmpeg was not found on this system.',
    detail:
      'FFmpeg is required to encode overlay streams.\n\n' +
      'Would you like to download it automatically?\n' +
      `(approx. ${process.platform === 'win32' ? '130' : '30'} MB)`,
    buttons: ['Download Now', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });

  if (choice.response === 1) {
    throw new Error('FFmpeg download cancelled by user');
  }

  // Set up temp paths
  const tmpDir = path.join(app.getPath('temp'), 'rtmp-overlay-ffmpeg');
  const zipPath = path.join(tmpDir, 'ffmpeg-download.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  const targetDir = getFFmpegUserDir();

  // Clean up any previous partial downloads
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  const progressWin = createProgressWindow(parentWindow);

  try {
    // ── Step 1: Download ──
    console.log(`[FFmpeg] Downloading from: ${source.url}`);
    updateProgress(progressWin, 0, 'Downloading…');

    await downloadFile(source.url, zipPath, (pct) => {
      updateProgress(progressWin, Math.round(pct * 0.8), `Downloading… ${pct}%`);
    });

    // ── Step 2: Extract ──
    console.log('[FFmpeg] Extracting…');
    updateProgress(progressWin, 82, 'Extracting archive…');
    extractZip(zipPath, extractDir);

    // ── Step 3: Locate & move binary ──
    updateProgress(progressWin, 92, 'Installing…');
    const binaryPath = findAndMoveBinary(extractDir, targetDir);
    console.log(`[FFmpeg] Installed to: ${binaryPath}`);

    // ── Step 4: Verify ──
    updateProgress(progressWin, 97, 'Verifying…');
    try {
      const version = execSync(`"${binaryPath}" -version`, { encoding: 'utf-8', timeout: 10_000 });
      const firstLine = version.split('\n')[0];
      console.log(`[FFmpeg] Version: ${firstLine}`);
    } catch (verifyErr: any) {
      console.warn('[FFmpeg] Could not verify version, but binary exists:', verifyErr.message);
    }

    updateProgress(progressWin, 100, 'Done!');

    // Brief pause so the user sees 100%
    await new Promise((r) => setTimeout(r, 800));

    return binaryPath;
  } catch (err: any) {
    console.error('[FFmpeg] Download/install failed:', err.message);
    dialog.showErrorBox(
      'FFmpeg Download Failed',
      `Could not download FFmpeg:\n\n${err.message}\n\nPlease install FFmpeg manually and ensure it is on your system PATH.`,
    );
    throw err;
  } finally {
    // Close progress window — use destroy() because closable:false blocks close() on Windows
    if (!progressWin.isDestroyed()) {
      progressWin.destroy();
    }
    // Clean up temp files
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  }
}
