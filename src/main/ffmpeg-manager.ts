import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { Resolution, EncodingConfig } from './config';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { findFFmpeg } from './ffmpeg-downloader';

export type BackgroundMode = 'chroma' | 'alpha' | 'luma';
export type AudioMode = 'none' | 'template' | 'device';

export interface FFmpegOptions {
  streamId: number;
  rtmpUrl: string;
  resolution: Resolution;
  frameRate: number;
  encoding?: EncodingConfig;
  ffmpegPath?: string;
  backgroundMode?: BackgroundMode;
  audioMode?: AudioMode;
  audioDevice?: string;
}

/**
 * Manages an FFmpeg child process that receives raw BGRA frames via stdin
 * and outputs an H.264/FLV stream to a local RTMP server.
 */
export class FFmpegManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: FFmpegOptions;
  private _isRunning: boolean = false;
  private _restartCount: number = 0;
  private _maxRestarts: number = 3;
  private frameQueue: Buffer[] = [];
  private writing: boolean = false;

  private audioQueue: Buffer[] = [];
  private audioWriting: boolean = false;

  constructor(options: FFmpegOptions) {
    super();
    this.options = options;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Resolve the path to the FFmpeg executable.
   * In packaged mode, looks in the app's resources folder.
   */
  private getFFmpegPath(): string {
    // If an explicit path was passed (e.g. from ensureFFmpeg), use it directly
    if (this.options.ffmpegPath && this.options.ffmpegPath !== 'ffmpeg') {
      return this.options.ffmpegPath;
    }

    // Search all known locations via the shared finder
    const found = findFFmpeg();
    if (found) return found;

    // Last resort: hope it's on PATH
    return 'ffmpeg';
  }

  /**
   * Start the FFmpeg process
   */
  start(): void {
    if (this._isRunning) return;

    const { width, height } = this.options.resolution;
    const ffmpegPath = this.getFFmpegPath();
    const isAlpha = this.options.backgroundMode === 'alpha';
    const audioMode = this.options.audioMode || 'none';
    const isMac = process.platform === 'darwin';
    const enc: EncodingConfig = this.options.encoding || {
      preset: 'ultrafast', profile: 'baseline', level: '4.0', tune: 'zerolatency',
      videoBitrate: 4000, maxBitrate: 4500, bufferSize: 8000, gopSize: 0,
      audioBitrate: 128, pixelFormat: 'yuv420p',
    };

    const args: string[] = [
      // Input 0: raw BGRA frames from stdin
      '-f', 'rawvideo',
      '-pix_fmt', 'bgra',
      '-video_size', `${width}x${height}`,
      '-framerate', `${this.options.frameRate}`,
      '-i', 'pipe:0',
    ];

    // Audio input depends on audioMode
    if (audioMode === 'device' && this.options.audioDevice) {
      // Device audio: platform-specific capture
      if (isMac) {
        args.push(
          '-f', 'avfoundation',
          '-i', `:${this.options.audioDevice}`,
        );
      } else {
        // Windows (dshow)
        args.push(
          '-f', 'dshow',
          '-i', `audio=${this.options.audioDevice}`,
        );
      }
    } else if (audioMode === 'template') {
      // Template audio: raw PCM from pipe:3
      args.push(
        '-f', 's16le',
        '-ar', '44100',
        '-ac', '2',
        '-i', 'pipe:3',
      );
    } else {
      // None: silent audio (hardware mixers require an audio track)
      args.push(
        '-f', 'lavfi',
        '-i', 'anullsrc=r=44100:cl=stereo',
      );
    }

    if (isAlpha) {
      // Alpha mode: stacked-alpha output (top = RGB, bottom = alpha mask)
      args.push(
        '-filter_complex', '[0:v]split=2[rgb][alpha];[alpha]alphaextract[a];[rgb][a]vstack=inputs=2[out]',
        '-map', '[out]',
        '-map', '1:a:0',
      );
    } else {
      // Chroma/luma mode: direct mapping
      args.push(
        '-map', '0:v:0',
        '-map', '1:a:0',
      );
    }

    args.push(
      // Video encoding
      '-c:v', 'libx264',
      '-preset', enc.preset,
    );
    if (enc.tune) {
      args.push('-tune', enc.tune);
    }
    const gopSize = enc.gopSize > 0 ? enc.gopSize : Math.round(this.options.frameRate);
    args.push(
      '-profile:v', enc.profile,
      '-level', enc.level,
      '-pix_fmt', enc.pixelFormat,
      '-b:v', `${enc.videoBitrate}k`,
      '-maxrate', `${enc.maxBitrate}k`,
      '-bufsize', `${enc.bufferSize}k`,
      '-g', `${gopSize}`,

      // Audio encoding
      '-c:a', 'aac',
      '-b:a', `${enc.audioBitrate}k`,
      '-ar', '44100',
      '-ac', '2',

      // Map both streams and set shortest so it stops with video
      '-shortest',

      // Output: RTMP push to local server
      '-f', 'flv',
      this.options.rtmpUrl,
    );

    console.log(`[FFmpeg ${this.options.streamId}] Starting: ${ffmpegPath} ${args.join(' ')}`);

    // stdio: stdin(0)=pipe, stdout(1)=pipe, stderr(2)=pipe, fd3=pipe (for template audio)
    const stdio: Array<'pipe' | 'ignore'> = ['pipe', 'pipe', 'pipe'];
    if (audioMode === 'template') {
      stdio.push('pipe'); // fd 3 for PCM audio input
    }

    this.process = spawn(ffmpegPath, args, {
      stdio,
    });

    this._isRunning = true;

    // CRITICAL: Handle stdin errors to prevent EPIPE crash
    this.process.stdin?.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
        console.warn(`[FFmpeg ${this.options.streamId}] Stdin pipe broken (FFmpeg likely exited)`);
      } else {
        console.error(`[FFmpeg ${this.options.streamId}] Stdin error:`, err.message);
      }
      this._isRunning = false;
      this.frameQueue = [];
      this.audioQueue = [];
    });

    // Handle audio pipe errors (fd 3) for template mode
    const audioPipe = (this.process as any).stdio?.[3] as import('stream').Writable | null;
    if (audioPipe) {
      audioPipe.on('error', (err: any) => {
        if (err.code === 'EPIPE') {
          console.warn(`[FFmpeg ${this.options.streamId}] Audio pipe broken`);
        } else {
          console.error(`[FFmpeg ${this.options.streamId}] Audio pipe error:`, err.message);
        }
        this.audioQueue = [];
      });
    }

    this.process.stdout?.on('data', (data: Buffer) => {
      // FFmpeg stdout (usually empty for this config)
      console.log(`[FFmpeg ${this.options.streamId}] stdout: ${data.toString()}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      // Only log non-progress lines to avoid console spam
      if (!msg.includes('frame=') && !msg.includes('fps=')) {
        console.log(`[FFmpeg ${this.options.streamId}] ${msg.trim()}`);
      }
    });

    this.process.on('close', (code) => {
      console.log(`[FFmpeg ${this.options.streamId}] Process exited with code ${code}`);
      this._isRunning = false;
      this.process = null;

      if (code !== 0 && code !== null && this._restartCount < this._maxRestarts) {
        this._restartCount++;
        console.log(`[FFmpeg ${this.options.streamId}] Restarting (attempt ${this._restartCount}/${this._maxRestarts})`);
        setTimeout(() => this.start(), 1000);
      } else {
        this.emit('stopped', code);
      }
    });

    this.process.on('error', (err) => {
      console.error(`[FFmpeg ${this.options.streamId}] Error:`, err.message);
      this._isRunning = false;
      this.emit('error', err);
    });

    this.emit('started');
  }

  /**
   * Write a raw BGRA frame buffer to FFmpeg's stdin.
   * Uses a queue to prevent backpressure issues.
   */
  writeFrame(buffer: Buffer): void {
    if (!this._isRunning || !this.process?.stdin || !this.process.stdin.writable || this.process.stdin.destroyed) return;

    this.frameQueue.push(buffer);

    // Keep queue bounded — drop oldest frames if falling behind
    while (this.frameQueue.length > 3) {
      this.frameQueue.shift();
    }

    this.drainQueue();
  }

  private drainQueue(): void {
    if (this.writing || this.frameQueue.length === 0) return;
    if (!this.process?.stdin || !this.process.stdin.writable || this.process.stdin.destroyed) {
      this.frameQueue = [];
      return;
    }

    this.writing = true;
    const frame = this.frameQueue.shift()!;

    try {
      const canWrite = this.process.stdin.write(frame);

      if (canWrite) {
        // Buffer accepted — immediately try the next frame
        this.writing = false;
        this.drainQueue();
      } else {
        // Backpressure — wait for a single drain event before continuing
        this.process.stdin.once('drain', () => {
          this.writing = false;
          this.drainQueue();
        });
      }
    } catch (err: any) {
      this.writing = false;
      this.frameQueue = [];
      console.warn(`[FFmpeg ${this.options.streamId}] Write exception:`, err.message);
    }
  }

  /**
   * Write raw PCM audio data to FFmpeg's audio pipe (fd 3).
   * Only used in 'template' audio mode.
   */
  writeAudio(buffer: Buffer): void {
    const audioPipe = (this.process as any)?.stdio?.[3] as import('stream').Writable | undefined;
    if (!this._isRunning || !audioPipe || !audioPipe.writable || audioPipe.destroyed) return;

    this.audioQueue.push(buffer);

    // Keep queue bounded — drop oldest chunks if falling behind
    while (this.audioQueue.length > 10) {
      this.audioQueue.shift();
    }

    this.drainAudioQueue();
  }

  private drainAudioQueue(): void {
    if (this.audioWriting || this.audioQueue.length === 0) return;
    const audioPipe = (this.process as any)?.stdio?.[3] as import('stream').Writable | undefined;
    if (!audioPipe || !audioPipe.writable || audioPipe.destroyed) {
      this.audioQueue = [];
      return;
    }

    this.audioWriting = true;
    const chunk = this.audioQueue.shift()!;

    try {
      const canWrite = audioPipe.write(chunk);
      if (canWrite) {
        this.audioWriting = false;
        this.drainAudioQueue();
      } else {
        audioPipe.once('drain', () => {
          this.audioWriting = false;
          this.drainAudioQueue();
        });
      }
    } catch (err: any) {
      this.audioWriting = false;
      this.audioQueue = [];
      console.warn(`[FFmpeg ${this.options.streamId}] Audio write exception:`, err.message);
    }
  }

  /**
   * Stop the FFmpeg process
   */
  stop(): void {
    if (!this._isRunning || !this.process) return;

    this._restartCount = this._maxRestarts; // Prevent auto-restart
    this.frameQueue = [];
    this.audioQueue = [];

    try {
      // Close audio pipe (fd 3) if present
      const audioPipe = (this.process as any).stdio?.[3] as import('stream').Writable | undefined;
      if (audioPipe && !audioPipe.destroyed) {
        audioPipe.end();
      }

      // Send 'q' to FFmpeg for graceful shutdown
      if (this.process.stdin?.writable) {
        this.process.stdin.end();
      }

      // Force kill after 3 seconds if still running
      const killTimeout = setTimeout(() => {
        if (this.process) {
          // SIGKILL works on both macOS and Windows (Electron maps it)
          this.process.kill('SIGKILL');
        }
      }, 3000);

      this.process.on('close', () => {
        clearTimeout(killTimeout);
      });
    } catch (err) {
      console.error(`[FFmpeg ${this.options.streamId}] Error stopping:`, err);
      if (this.process) {
        this.process.kill('SIGKILL');
      }
    }

    this._isRunning = false;
  }

  /**
   * Reset restart counter (call after a successful long run)
   */
  resetRestartCounter(): void {
    this._restartCount = 0;
  }

  /**
   * List available audio input devices using FFmpeg.
   * Returns an array of device name strings.
   */
  static listAudioDevices(ffmpegPath?: string): Promise<string[]> {
    const resolvedPath = ffmpegPath || findFFmpeg() || 'ffmpeg';
    const isMac = process.platform === 'darwin';

    return new Promise((resolve) => {
      let stderr = '';
      let args: string[];

      if (isMac) {
        args = ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
      } else {
        args = ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'];
      }

      const proc = spawn(resolvedPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.stdout?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', () => {
        const devices: string[] = [];
        if (isMac) {
          // AVFoundation lists audio devices after "AVFoundation audio devices:"
          const audioSection = stderr.split(/AVFoundation audio devices:/i)[1];
          if (audioSection) {
            const lines = audioSection.split('\n');
            for (const line of lines) {
              // Parse lines like: [AVFoundation indev @ ...] [0] Built-in Microphone
              const m = line.match(/\[(\d+)]\s+(.+)/);
              if (m) {
                devices.push(m[1]); // Use index as device identifier for avfoundation
              } else if (line.match(/AVFoundation/i) && devices.length > 0) {
                break; // End of audio section
              }
            }
          }
        } else {
          // dshow lists devices in quotes: "DeviceName" (audio)
          const lines = stderr.split('\n');
          let inAudio = false;
          for (const line of lines) {
            if (line.includes('DirectShow audio devices')) {
              inAudio = true;
              continue;
            }
            if (inAudio && line.includes('DirectShow video devices')) break;
            if (inAudio) {
              const m = line.match(/"([^"]+)"/);
              if (m) devices.push(m[1]);
            }
          }
        }
        resolve(devices);
      });

      proc.on('error', () => resolve([]));

      // Don't let it hang
      setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
      }, 5000);
    });
  }

  /**
   * Get a human-readable name for a device index (macOS avfoundation).
   * Returns an array of { index, name } pairs.
   */
  static listAudioDevicesDetailed(ffmpegPath?: string): Promise<Array<{ index: string; name: string }>> {
    const resolvedPath = ffmpegPath || findFFmpeg() || 'ffmpeg';
    const isMac = process.platform === 'darwin';

    return new Promise((resolve) => {
      let stderr = '';
      let args: string[];

      if (isMac) {
        args = ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
      } else {
        args = ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'];
      }

      const proc = spawn(resolvedPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.stdout?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', () => {
        const devices: Array<{ index: string; name: string }> = [];
        if (isMac) {
          const audioSection = stderr.split(/AVFoundation audio devices:/i)[1];
          if (audioSection) {
            const lines = audioSection.split('\n');
            for (const line of lines) {
              const m = line.match(/\[(\d+)]\s+(.+)/);
              if (m) {
                devices.push({ index: m[1], name: m[2].trim() });
              } else if (line.match(/AVFoundation/i) && devices.length > 0) {
                break;
              }
            }
          }
        } else {
          const lines = stderr.split('\n');
          let inAudio = false;
          let idx = 0;
          for (const line of lines) {
            if (line.includes('DirectShow audio devices')) {
              inAudio = true;
              continue;
            }
            if (inAudio && line.includes('DirectShow video devices')) break;
            if (inAudio) {
              const m = line.match(/"([^"]+)"/);
              if (m) {
                devices.push({ index: String(idx), name: m[1] });
                idx++;
              }
            }
          }
        }
        resolve(devices);
      });

      proc.on('error', () => resolve([]));

      setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
      }, 5000);
    });
  }
}
