import { BrowserWindow } from 'electron';
import { EventEmitter } from 'events';
import { TemplateManager } from './template-manager';
import { Resolution } from './config';

export interface OverlayRendererOptions {
  streamId: number;
  templateName: string;
  data: Record<string, string>;
  resolution: Resolution;
  frameRate: number;
  chromaKeyColor?: string;
}

/**
 * Manages an off-screen Electron BrowserWindow that renders HTML overlays
 * on a green (#00FF00) background and emits raw BGRA frame buffers.
 */
export class OverlayRenderer extends EventEmitter {
  private window: BrowserWindow | null = null;
  private templateManager: TemplateManager;
  private options: OverlayRendererOptions;
  private _currentTemplate: string;
  private _currentData: Record<string, string>;
  private _isRunning: boolean = false;
  private repaintTimer: NodeJS.Timeout | null = null;

  constructor(templateManager: TemplateManager, options: OverlayRendererOptions) {
    super();
    this.templateManager = templateManager;
    this.options = options;
    this._currentTemplate = options.templateName;
    this._currentData = { ...options.data };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get currentTemplate(): string {
    return this._currentTemplate;
  }

  get currentData(): Record<string, string> {
    return { ...this._currentData };
  }

  /**
   * Start the off-screen browser window and begin emitting frames
   */
  async start(): Promise<void> {
    if (this._isRunning) return;

    const { width, height } = this.options.resolution;

    this.window = new BrowserWindow({
      width,
      height,
      show: false,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: false,
      },
    });

    this.window.webContents.setFrameRate(this.options.frameRate);

    // Listen for paint events — each event delivers a rendered frame.
    // On HiDPI (Retina) displays the bitmap may be larger than the logical
    // resolution (e.g. 3840×2160 for a 1920×1080 window). FFmpeg expects
    // exactly `width × height × 4` bytes per frame, so we resize when needed
    // to prevent the image from rolling / tearing.
    let loggedResize = false;
    this.window.webContents.on('paint', (_event, _dirty, image) => {
      const actual = image.getSize();
      let buf: Buffer;
      if (actual.width !== width || actual.height !== height) {
        if (!loggedResize) {
          console.log(`[Renderer ${this.options.streamId}] DPI scaling detected: got ${actual.width}×${actual.height}, expected ${width}×${height} — resizing each frame`);
          loggedResize = true;
        }
        buf = image.resize({ width, height }).toBitmap();
      } else {
        buf = image.getBitmap();
      }
      this.emit('frame', buf, width, height);
    });

    // Load the initial HTML and wait for it to fully render
    await this.loadCurrentTemplate();

    // Explicitly start painting (required on some platforms / Electron versions)
    this.window.webContents.startPainting();

    // Force continuous repainting: off-screen rendering only fires 'paint'
    // events when content changes. For static overlays the paint events stop
    // after the initial render. Calling invalidate() on a timer forces a
    // full repaint every frame interval so FFmpeg receives a steady stream.
    const repaintMs = Math.round(1000 / this.options.frameRate);
    this.repaintTimer = setInterval(() => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.invalidate();
      }
    }, repaintMs);

    console.log(`[Renderer ${this.options.streamId}] Off-screen window started painting at ${this.options.frameRate}fps`);

    this._isRunning = true;
    this.emit('started');
  }

  /**
   * Stop the off-screen browser window
   */
  stop(): void {
    if (!this._isRunning) return;

    if (this.repaintTimer) {
      clearInterval(this.repaintTimer);
      this.repaintTimer = null;
    }

    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
    this._isRunning = false;
    this.emit('stopped');
  }

  /**
   * Change the template being rendered
   */
  async changeTemplate(templateName: string): Promise<void> {
    this._currentTemplate = templateName;
    if (this._isRunning) {
      await this.loadCurrentTemplate();
    }
  }

  /**
   * Update placeholder data. Uses DOM manipulation when possible for smoother updates.
   */
  async updateData(data: Record<string, string>): Promise<void> {
    Object.assign(this._currentData, data);

    if (this._isRunning && this.window && !this.window.isDestroyed()) {
      try {
        // Try DOM-based update first (no page reload)
        const escaped = JSON.stringify(data);
        await this.window.webContents.executeJavaScript(
          `if (window.updatePlaceholders) { window.updatePlaceholders(${escaped}); }`
        );
      } catch {
        // Fallback: full reload with new data
        await this.loadCurrentTemplate();
      }
    }
  }

  /**
   * Replace all placeholder data (full reset)
   */
  async setData(data: Record<string, string>): Promise<void> {
    this._currentData = { ...data };
    if (this._isRunning) {
      await this.loadCurrentTemplate();
    }
  }

  /**
   * Capture a single frame as a PNG buffer (for GUI thumbnails)
   */
  async captureFrame(): Promise<Buffer | null> {
    if (!this._isRunning || !this.window || this.window.isDestroyed()) {
      return null;
    }

    try {
      const image = await this.window.webContents.capturePage();
      return image.toPNG();
    } catch {
      return null;
    }
  }

  /**
   * Load (or reload) the current template with current data
   */
  private async loadCurrentTemplate(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;

    const { width, height } = this.options.resolution;
    const html = this.templateManager.buildOverlayPage(
      this._currentTemplate,
      this._currentData,
      width,
      height,
      this.options.chromaKeyColor,
    );

    // Load HTML as a data URL
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    await this.window.loadURL(dataUrl);
  }
}
