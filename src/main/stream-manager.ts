import { EventEmitter } from 'events';
import { OverlayRenderer } from './overlay-renderer';
import { FFmpegManager } from './ffmpeg-manager';
import { TemplateManager } from './template-manager';
import { SubtitleManager } from './subtitle-manager';
import { AppConfig, StreamConfig, BackgroundMode, AudioMode } from './config';

export type StreamStatus = 'stopped' | 'starting' | 'running' | 'error';

export type TimerDirection = 'up' | 'down';

export interface TimerState {
  running: boolean;
  direction: TimerDirection;
  /** Total preset duration in seconds (used for countdown) */
  duration: number;
  /** Current elapsed/remaining seconds */
  remaining: number;
  /** Formatted display string (HH:MM:SS or MM:SS) */
  display: string;
}

export interface StreamState {
  id: number;
  status: StreamStatus;
  rtmpUrl: string;
  streamName: string;
  currentTemplate: string;
  placeholderData: Record<string, string>;
  enabled: boolean;
  chromaKeyColor: string;
  backgroundMode: BackgroundMode;
  lumaInverted: boolean;
  audioMode: AudioMode;
  audioDevice: string;
  subtitlesEnabled: boolean;
  subtitleLanguage: string;
  timer: TimerState;
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
  private subtitleManagers: Map<number, SubtitleManager> = new Map();
  private states: Map<number, StreamState> = new Map();

  /** Per-stream countdown/countup interval handles */
  private timerIntervals: Map<number, NodeJS.Timeout> = new Map();

  /** Debounce timers for coalescing rapid setting changes into one restart */
  private restartTimers: Map<number, NodeJS.Timeout> = new Map();
  /** Tracks whether a restart is currently in progress per stream */
  private restartInProgress: Set<number> = new Set();
  /** Marks that another restart was requested while one was already running */
  private restartPending: Set<number> = new Set();

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
        chromaKeyColor: streamConfig.chromaKeyColor || '#00FF00',
        backgroundMode: streamConfig.backgroundMode || 'chroma',
        lumaInverted: streamConfig.lumaInverted || false,
        audioMode: streamConfig.audioMode || 'none',
        audioDevice: streamConfig.audioDevice || '',
        subtitlesEnabled: streamConfig.subtitlesEnabled || false,
        subtitleLanguage: streamConfig.subtitleLanguage || 'auto',
        timer: { running: false, direction: 'down', duration: 300, remaining: 300, display: '05:00' },
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
        backgroundMode: state.backgroundMode,
        lumaInverted: state.lumaInverted,
        audioMode: state.audioMode,
      });

      // Create FFmpeg process
      const ffmpeg = new FFmpegManager({
        streamId: id,
        rtmpUrl: state.rtmpUrl,
        resolution: this.config.resolution,
        frameRate: this.config.frameRate,
        encoding: this.config.encoding,
        ffmpegPath: this.config.ffmpegPath,
        backgroundMode: state.backgroundMode,
        audioMode: state.audioMode,
        audioDevice: state.audioDevice,
      });

      // Wire frame events: renderer paint → ffmpeg stdin
      renderer.on('frame', (buffer: Buffer) => {
        ffmpeg.writeFrame(buffer);
      });

      // Wire audio events: renderer audio → ffmpeg audio pipe
      if (state.audioMode === 'template') {
        renderer.on('audio', (pcmBuffer: Buffer) => {
          ffmpeg.writeAudio(pcmBuffer);
        });
      }

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

      // Start subtitle manager if subtitles are enabled and audio device is set
      if (state.subtitlesEnabled && state.audioMode === 'device' && state.audioDevice && this.config.whisperPath) {
        const subtitleMgr = new SubtitleManager({
          streamId: id,
          ffmpegPath: this.config.ffmpegPath,
          whisperPath: this.config.whisperPath,
          audioDevice: state.audioDevice,
          language: state.subtitleLanguage || 'auto',
        });
        subtitleMgr.on('subtitle', (text: string) => {
          renderer.showSubtitle(text);
        });
        subtitleMgr.start();
        this.subtitleManagers.set(id, subtitleMgr);
      }

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
      renderer.removeAllListeners();
      renderer.stop();
      this.renderers.delete(id);
    }

    // Stop subtitle manager
    const subtitleMgr = this.subtitleManagers.get(id);
    if (subtitleMgr) {
      subtitleMgr.stop();
      this.subtitleManagers.delete(id);
    }

    // Remove FFmpeg event listeners BEFORE stopping so late 'close' events
    // (which fire asynchronously with non-zero exit codes) don't overwrite
    // the state back to 'error' during an intentional restart.
    const ffmpeg = this.ffmpegProcesses.get(id);
    if (ffmpeg) {
      ffmpeg.removeAllListeners();
      ffmpeg.stop();
      this.ffmpegProcesses.delete(id);
    }

    state.status = 'stopped';
    state.error = undefined;
    this.emitUpdate(id);

    console.log(`[StreamManager] Stream ${id} stopped`);
  }

  /**
   * Schedule a debounced restart for a stream.  Rapid setting changes within
   * 300 ms are coalesced into a single stop → start cycle, and concurrent
   * restarts are serialized so a new FFmpeg never races a still-disconnecting
   * RTMP session.
   */
  private scheduleRestart(id: number): void {
    const existing = this.restartTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.restartTimers.delete(id);
      this.executeRestart(id);
    }, 300);
    this.restartTimers.set(id, timer);
  }

  private async executeRestart(id: number): Promise<void> {
    if (this.restartInProgress.has(id)) {
      // Another restart is running — flag that we need one more when it finishes
      this.restartPending.add(id);
      return;
    }

    this.restartInProgress.add(id);
    try {
      await this.stopStream(id);
      // Wait for RTMP session to fully tear down
      await new Promise((resolve) => setTimeout(resolve, 500));
      await this.startStream(id);
    } catch (err: any) {
      console.error(`[StreamManager] Restart failed for stream ${id}:`, err.message);
    } finally {
      this.restartInProgress.delete(id);
      // If another restart was requested while we were busy, run it now
      if (this.restartPending.has(id)) {
        this.restartPending.delete(id);
        this.executeRestart(id);
      }
    }
  }

  /**
   * Reload the template for all running renderers (e.g. after template files update on disk).
   * Optionally limit to specific template names.
   */
  async reloadTemplates(names?: string[]): Promise<void> {
    for (const [id, renderer] of this.renderers) {
      const state = this.states.get(id);
      if (!state) continue;
      if (names && !names.includes(state.currentTemplate)) continue;
      try {
        await renderer.changeTemplate(state.currentTemplate);
        console.log(`[StreamManager] Reloaded template for stream ${id}`);
      } catch (err: any) {
        console.warn(`[StreamManager] Failed to reload template for stream ${id}:`, err.message);
      }
    }
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
  /**
   * Call a global JS function on the overlay template.
   */
  async executeFunction(id: number, name: string, arg?: string): Promise<{ found: boolean; result?: any; error?: string }> {
    const renderer = this.renderers.get(id);
    if (!renderer) return { found: false, error: 'Stream is not running' };
    return renderer.executeFunction(name, arg);
  }

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
      chromaKeyColor: streamConfig.chromaKeyColor || '#00FF00',
      backgroundMode: streamConfig.backgroundMode || 'chroma',
      lumaInverted: streamConfig.lumaInverted || false,
      audioMode: streamConfig.audioMode || 'none',
      audioDevice: streamConfig.audioDevice || '',
      subtitlesEnabled: streamConfig.subtitlesEnabled || false,
      subtitleLanguage: streamConfig.subtitleLanguage || 'auto',
      timer: { running: false, direction: 'down', duration: 300, remaining: 300, display: '05:00' },
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

    state.streamName = newStreamName;
    state.rtmpUrl = `rtmp://127.0.0.1:${this.config.rtmpPort}/live/${newStreamName}`;
    this.emitUpdate(id);

    if (state.status === 'running' || state.status === 'starting') {
      this.scheduleRestart(id);
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

    state.chromaKeyColor = color;
    this.emitUpdate(id);

    if (state.status === 'running' || state.status === 'starting') {
      this.scheduleRestart(id);
    }
    console.log(`[StreamManager] Stream ${id} chroma color changed to ${color}`);
  }

  /**
   * Update the background mode for a specific stream. Restarts if running.
   */
  async updateStreamBackgroundMode(id: number, mode: BackgroundMode): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.backgroundMode === mode) return;

    state.backgroundMode = mode;
    this.emitUpdate(id);

    if (state.status === 'running' || state.status === 'starting') {
      this.scheduleRestart(id);
    }
    console.log(`[StreamManager] Stream ${id} background mode changed to ${mode}`);
  }

  /**
   * Update the luma invert setting for a specific stream. Restarts if running.
   */
  async updateStreamLumaInverted(id: number, inverted: boolean): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.lumaInverted === inverted) return;

    state.lumaInverted = inverted;
    this.emitUpdate(id);

    if (state.status === 'running' || state.status === 'starting') {
      this.scheduleRestart(id);
    }
    console.log(`[StreamManager] Stream ${id} luma inverted changed to ${inverted}`);
  }

  /**
   * Update the audio mode for a specific stream. Restarts if running.
   */
  async updateStreamAudioMode(id: number, mode: AudioMode): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.audioMode === mode) return;

    state.audioMode = mode;
    this.emitUpdate(id);

    if (state.status === 'running' || state.status === 'starting') {
      this.scheduleRestart(id);
    }
    console.log(`[StreamManager] Stream ${id} audio mode changed to ${mode}`);
  }

  /**
   * Update the audio device for a specific stream. Restarts if running.
   */
  async updateStreamAudioDevice(id: number, device: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.audioDevice === device) return;

    state.audioDevice = device;
    this.emitUpdate(id);

    if (state.status === 'running' || state.status === 'starting') {
      this.scheduleRestart(id);
    }
    console.log(`[StreamManager] Stream ${id} audio device changed to ${device}`);
  }

  /**
   * Update the subtitles enabled state for a specific stream.
   * Hot-starts or stops the subtitle manager without restarting the stream.
   */
  async updateStreamSubtitles(id: number, enabled: boolean): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.subtitlesEnabled === enabled) return;

    state.subtitlesEnabled = enabled;
    this.emitUpdate(id);

    // Only manage subtitle manager if stream is actually running
    if (state.status === 'running' || state.status === 'starting') {
      if (enabled && state.audioMode === 'device' && state.audioDevice && this.config.whisperPath) {
        // Start subtitle manager (if not already running)
        if (!this.subtitleManagers.has(id)) {
          const renderer = this.renderers.get(id);
          const subtitleMgr = new SubtitleManager({
            streamId: id,
            ffmpegPath: this.config.ffmpegPath,
            whisperPath: this.config.whisperPath,
            audioDevice: state.audioDevice,
            language: state.subtitleLanguage || 'auto',
          });
          subtitleMgr.on('subtitle', (text: string) => {
            if (renderer) renderer.showSubtitle(text);
          });
          subtitleMgr.start();
          this.subtitleManagers.set(id, subtitleMgr);
        }
      } else {
        // Stop subtitle manager
        const subtitleMgr = this.subtitleManagers.get(id);
        if (subtitleMgr) {
          subtitleMgr.stop();
          this.subtitleManagers.delete(id);
        }
      }
    }

    console.log(`[StreamManager] Stream ${id} subtitles ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Update the subtitle language for a specific stream.
   * Updates the subtitle manager in-place without restarting the stream.
   */
  async updateStreamSubtitleLanguage(id: number, language: string): Promise<void> {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.subtitleLanguage === language) return;

    state.subtitleLanguage = language;
    this.emitUpdate(id);

    // Update the live subtitle manager (takes effect on the next whisper segment)
    const subtitleMgr = this.subtitleManagers.get(id);
    if (subtitleMgr) {
      subtitleMgr.updateLanguage(language);
    }

    console.log(`[StreamManager] Stream ${id} subtitle language changed to ${language}`);
  }

  // ── Timer helpers ─────────────────────────────────────────────

  private formatTime(totalSeconds: number): string {
    const s = Math.max(0, Math.round(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  private pushTimerToOverlay(id: number): void {
    const state = this.states.get(id);
    if (!state) return;
    const renderer = this.renderers.get(id);
    if (renderer) {
      renderer.updateTimer(state.timer.display, state.timer.running);
    }
  }

  /**
   * Set the timer duration (in seconds) for a stream.
   * Also resets remaining to the new duration.
   */
  setTimerDuration(id: number, seconds: number): void {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    state.timer.duration = seconds;
    state.timer.remaining = seconds;
    state.timer.display = this.formatTime(seconds);
    this.pushTimerToOverlay(id);
    this.emitUpdate(id);
  }

  /**
   * Set the timer direction for a stream.
   */
  setTimerDirection(id: number, direction: TimerDirection): void {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    state.timer.direction = direction;
    this.emitUpdate(id);
  }

  /**
   * Start the timer for a stream.
   */
  startTimer(id: number): void {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    if (state.timer.running) return;

    state.timer.running = true;
    this.pushTimerToOverlay(id);
    this.emitUpdate(id);

    const interval = setInterval(() => {
      const st = this.states.get(id);
      if (!st || !st.timer.running) {
        clearInterval(interval);
        this.timerIntervals.delete(id);
        return;
      }

      if (st.timer.direction === 'down') {
        st.timer.remaining = Math.max(0, st.timer.remaining - 1);
        st.timer.display = this.formatTime(st.timer.remaining);
        if (st.timer.remaining <= 0) {
          st.timer.running = false;
          clearInterval(interval);
          this.timerIntervals.delete(id);
        }
      } else {
        st.timer.remaining += 1;
        st.timer.display = this.formatTime(st.timer.remaining);
      }

      this.pushTimerToOverlay(id);
      this.emitUpdate(id);
    }, 1000);

    this.timerIntervals.set(id, interval);
    console.log(`[StreamManager] Timer started on stream ${id} (${state.timer.direction})`);
  }

  /**
   * Stop (pause) the timer for a stream.
   */
  stopTimer(id: number): void {
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    state.timer.running = false;

    const interval = this.timerIntervals.get(id);
    if (interval) {
      clearInterval(interval);
      this.timerIntervals.delete(id);
    }

    this.pushTimerToOverlay(id);
    this.emitUpdate(id);
    console.log(`[StreamManager] Timer stopped on stream ${id}`);
  }

  /**
   * Reset the timer back to its configured duration.
   */
  resetTimer(id: number): void {
    this.stopTimer(id);
    const state = this.states.get(id);
    if (!state) throw new Error(`Stream ${id} not found`);
    state.timer.remaining = state.timer.direction === 'down' ? state.timer.duration : 0;
    state.timer.display = this.formatTime(state.timer.remaining);
    this.pushTimerToOverlay(id);
    this.emitUpdate(id);
    console.log(`[StreamManager] Timer reset on stream ${id}`);
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
