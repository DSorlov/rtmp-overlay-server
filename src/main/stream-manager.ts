import { EventEmitter } from 'events';
import { OverlayRenderer } from './overlay-renderer';
import { FFmpegManager } from './ffmpeg-manager';
import { TemplateManager } from './template-manager';
import { AppConfig, StreamConfig } from './config';

export type StreamStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface StreamState {
  id: number;
  status: StreamStatus;
  rtmpUrl: string;
  streamName: string;
  currentTemplate: string;
  placeholderData: Record<string, string>;
  enabled: boolean;
  chromaKeyColor: string;
  error?: string;
}

/**
 * Orchestrates the lifecycle of up to 4 overlay streams.
 * Each stream consists of an OverlayRenderer (HTML → frames) and FFmpegManager (frames → RTMP).
 */
export class StreamManager extends EventEmitter {
  private config: AppConfig;
  private templateManager: TemplateManager;
  private renderers: Map<number, OverlayRenderer> = new Map();
  private ffmpegProcesses: Map<number, FFmpegManager> = new Map();
  private states: Map<number, StreamState> = new Map();

  constructor(config: AppConfig, templateManager: TemplateManager) {
    super();
    this.config = config;
    this.templateManager = templateManager;

    // Initialize state for each configured stream
    for (const streamConfig of config.streams) {
      const rtmpUrl = `rtmp://127.0.0.1:${config.rtmpPort}/live/${streamConfig.streamName}`;
      this.states.set(streamConfig.id, {
        id: streamConfig.id,
        status: 'stopped',
        rtmpUrl,
        streamName: streamConfig.streamName,
        currentTemplate: streamConfig.defaultTemplate,
        placeholderData: {},
        enabled: streamConfig.enabled,
        chromaKeyColor: streamConfig.chromaKeyColor || config.chromaKeyColor,
      });
    }
  }

  /**
   * Get the state of all streams
   */
  getAllStreams(): StreamState[] {
    return Array.from(this.states.values());
  }

  /**
   * Restore persisted state (template + placeholder data) from a previous session.
   * Returns the IDs of streams that were running so the caller can auto-start them.
   */
  restoreState(saved: Record<number, { currentTemplate: string; placeholderData: Record<string, string>; wasRunning?: boolean }>): number[] {
    const toAutoStart: number[] = [];
    for (const [idStr, data] of Object.entries(saved)) {
      const id = Number(idStr);
      const state = this.states.get(id);
      if (!state) continue;

      // Only restore the template if it actually exists
      const templates = this.templateManager.listTemplates();
      if (data.currentTemplate && templates.includes(data.currentTemplate)) {
        state.currentTemplate = data.currentTemplate;
      }

      if (data.placeholderData && typeof data.placeholderData === 'object') {
        state.placeholderData = { ...data.placeholderData };
      }

      if (data.wasRunning) {
        toAutoStart.push(id);
      }
    }
    console.log('[StreamManager] Restored persisted state');
    return toAutoStart;
  }

  /**
   * Get the state of a single stream
   */
  getStream(id: number): StreamState | undefined {
    return this.states.get(id);
  }

  /**
   * Start a specific stream
   */
  async startStream(id: number): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.status === 'running' || state.status === 'starting') {
      throw new Error(`Stream ${id} is already ${state.status}`);
    }

    state.status = 'starting';
    state.error = undefined;
    this.emitUpdate(id);

    try {
      // Create overlay renderer
      const renderer = new OverlayRenderer(this.templateManager, {
        streamId: id,
        templateName: state.currentTemplate,
        data: state.placeholderData,
        resolution: this.config.resolution,
        frameRate: this.config.frameRate,
        chromaKeyColor: state.chromaKeyColor,
      });

      // Create FFmpeg process
      const ffmpeg = new FFmpegManager({
        streamId: id,
        rtmpUrl: state.rtmpUrl,
        resolution: this.config.resolution,
        frameRate: this.config.frameRate,
        ffmpegPath: this.config.ffmpegPath,
      });

      // Wire frame events: renderer paint → ffmpeg stdin
      renderer.on('frame', (buffer: Buffer) => {
        ffmpeg.writeFrame(buffer);
      });

      // Handle FFmpeg lifecycle events
      ffmpeg.on('stopped', (code: number) => {
        if (code !== 0) {
          state.status = 'error';
          state.error = `FFmpeg exited with code ${code}`;
        } else {
          state.status = 'stopped';
        }
        this.emitUpdate(id);
      });

      ffmpeg.on('error', (err: Error) => {
        state.status = 'error';
        state.error = err.message;
        this.emitUpdate(id);
      });

      // Start FFmpeg (pushes to local RTMP server)
      ffmpeg.start();

      // Then start the renderer (which will begin feeding frames)
      await renderer.start();

      this.renderers.set(id, renderer);
      this.ffmpegProcesses.set(id, ffmpeg);

      state.status = 'running';
      this.emitUpdate(id);

      console.log(`[StreamManager] Stream ${id} started → ${state.rtmpUrl}`);
    } catch (err: any) {
      state.status = 'error';
      state.error = err.message;
      this.emitUpdate(id);
      throw err;
    }
  }

  /**
   * Stop a specific stream
   */
  async stopStream(id: number): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);

    // Stop renderer
    const renderer = this.renderers.get(id);
    if (renderer) {
      renderer.stop();
      this.renderers.delete(id);
    }

    // Stop FFmpeg
    const ffmpeg = this.ffmpegProcesses.get(id);
    if (ffmpeg) {
      ffmpeg.stop();
      this.ffmpegProcesses.delete(id);
    }

    state.status = 'stopped';
    state.error = undefined;
    this.emitUpdate(id);

    console.log(`[StreamManager] Stream ${id} stopped`);
  }

  /**
   * Change the template for a specific stream
   */
  async changeTemplate(id: number, templateName: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);

    // Verify template exists
    const templates = this.templateManager.listTemplates();
    if (!templates.includes(templateName)) {
      throw new Error(`Template not found: ${templateName}`);
    }

    state.currentTemplate = templateName;

    const renderer = this.renderers.get(id);
    if (renderer) {
      await renderer.changeTemplate(templateName);
    }

    this.emitUpdate(id);
    console.log(`[StreamManager] Stream ${id} template changed to ${templateName}`);
  }

  /**
   * Update placeholder data for a specific stream (merge)
   */
  async updateData(id: number, data: Record<string, string>): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);

    Object.assign(state.placeholderData, data);

    const renderer = this.renderers.get(id);
    if (renderer) {
      await renderer.updateData(data);
    }

    this.emitUpdate(id);
  }

  /**
   * Replace all placeholder data for a specific stream
   */
  async setData(id: number, data: Record<string, string>): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);

    state.placeholderData = { ...data };

    const renderer = this.renderers.get(id);
    if (renderer) {
      await renderer.setData(data);
    }

    this.emitUpdate(id);
  }

  /**
   * Capture a thumbnail PNG for a stream (for GUI preview)
   */
  async captureFrame(id: number): Promise<Buffer | null> {
    const renderer = this.renderers.get(id);
    if (!renderer) return null;
    return renderer.captureFrame();
  }

  /**
   * Stop all streams (used during app shutdown)
   */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.states.keys()).map((id) =>
      this.stopStream(id).catch((err) =>
        console.error(`Error stopping stream ${id}:`, err)
      )
    );
    await Promise.all(promises);
  }

  /**
   * Dynamically add a new stream (used when stream count is increased via settings).
   */
  addStream(streamConfig: StreamConfig): void {
    if (this.states.has(streamConfig.id)) return; // already exists
    const rtmpUrl = `rtmp://127.0.0.1:${this.config.rtmpPort}/live/${streamConfig.streamName}`;
    this.states.set(streamConfig.id, {
      id: streamConfig.id,
      status: 'stopped',
      rtmpUrl,
      streamName: streamConfig.streamName,
      currentTemplate: streamConfig.defaultTemplate,
      placeholderData: {},
      enabled: streamConfig.enabled,
      chromaKeyColor: streamConfig.chromaKeyColor || this.config.chromaKeyColor,
    });
    console.log(`[StreamManager] Added stream ${streamConfig.id} (${streamConfig.streamName})`);
  }

  /**
   * Dynamically remove a stream (stops it first if running).
   */
  async removeStream(id: number): Promise<void> {
    const state = this.states.get(id);
    if (!state) return;
    if (state.status === 'running' || state.status === 'starting') {
      await this.stopStream(id);
    }
    this.states.delete(id);
    console.log(`[StreamManager] Removed stream ${id}`);
  }

  /**
   * Update the stream key (streamName) for a stream. Stops and restarts if running.
   */
  async updateStreamKey(id: number, newStreamName: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.streamName === newStreamName) return;

    const wasRunning = state.status === 'running' || state.status === 'starting';
    if (wasRunning) {
      await this.stopStream(id);
    }

    state.streamName = newStreamName;
    state.rtmpUrl = `rtmp://127.0.0.1:${this.config.rtmpPort}/live/${newStreamName}`;
    this.emitUpdate(id);

    if (wasRunning) {
      await this.startStream(id);
    }
    console.log(`[StreamManager] Stream ${id} key changed to ${newStreamName}`);
  }

  /**
   * Update the RTMP port in all stream URLs (called when RTMP port changes).
   */
  updateRtmpPort(newPort: number): void {
    this.config.rtmpPort = newPort;
    for (const [id, state] of this.states) {
      state.rtmpUrl = `rtmp://127.0.0.1:${newPort}/live/${state.streamName}`;
      this.emitUpdate(id);
    }
  }

  /**
   * Update the chroma key color for a specific stream. Restarts if running.
   */
  async updateStreamChromaColor(id: number, color: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.chromaKeyColor === color) return;

    const wasRunning = state.status === 'running' || state.status === 'starting';
    if (wasRunning) {
      await this.stopStream(id);
    }

    state.chromaKeyColor = color;
    this.emitUpdate(id);

    if (wasRunning) {
      await this.startStream(id);
    }
    console.log(`[StreamManager] Stream ${id} chroma color changed to ${color}`);
  }

  /**
   * Get the underlying config (for external mutation).
   */
  getConfig(): AppConfig {
    return this.config;
  }

  private emitUpdate(id: number): void {
    const state = this.states.get(id);
    if (state) {
      this.emit('streamUpdate', { ...state });
    }
  }
}
