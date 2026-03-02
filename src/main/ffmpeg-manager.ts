import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { Resolution } from './config';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { findFFmpeg } from './ffmpeg-downloader';

export interface FFmpegOptions {
  streamId: number;
  rtmpUrl: string;
  resolution: Resolution;
  frameRate: number;
  ffmpegPath?: string;
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

    const args = [
      // Input 0: raw BGRA frames from stdin
      '-f', 'rawvideo',
      '-pix_fmt', 'bgra',
      '-video_size', `${width}x${height}`,
      '-framerate', `${this.options.frameRate}`,
      '-i', 'pipe:0',

      // Input 1: silent audio (hardware mixers require an audio track)
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=stereo',

      // Video encoding — baseline profile for maximum hardware compatibility
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-level', '4.0',
      '-pix_fmt', 'yuv420p',
      '-b:v', '4000k',
      '-maxrate', '4500k',
      '-bufsize', '8000k',
      '-g', `${this.options.frameRate}`, // Keyframe every 1 second (better for hardware)

      // Audio encoding — silent AAC track
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',

      // Map both streams and set shortest so it stops with video
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest',

      // Output: RTMP push to local server
      '-f', 'flv',
      this.options.rtmpUrl,
    ];

    console.log(`[FFmpeg ${this.options.streamId}] Starting: ${ffmpegPath} ${args.join(' ')}`);

    this.process = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
    });

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
   * Stop the FFmpeg process
   */
  stop(): void {
    if (!this._isRunning || !this.process) return;

    this._restartCount = this._maxRestarts; // Prevent auto-restart
    this.frameQueue = [];

    try {
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
}
