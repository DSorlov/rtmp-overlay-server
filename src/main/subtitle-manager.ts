import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getWhisperModelPath } from './whisper-downloader';

export interface SubtitleManagerOptions {
  streamId: number;
  ffmpegPath: string;
  whisperPath: string;
  audioDevice: string;
  language?: string;     // e.g. 'en', 'fr', 'auto' — empty/auto = auto-detect
  segmentDuration?: number; // seconds per audio segment (default: 3)
}

/**
 * Captures audio from a system device via FFmpeg, feeds segments to whisper.cpp,
 * and emits 'subtitle' events with recognised text.
 *
 * Audio pipeline:
 *   FFmpeg (device → 16 kHz mono s16le stdout) → 3-second WAV segments → whisper.cpp → text
 */
export class SubtitleManager extends EventEmitter {
  private options: SubtitleManagerOptions;
  private ffmpegProcess: ChildProcess | null = null;
  private audioBuffer: Buffer[] = [];
  private audioBytes = 0;
  private segmentTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private processing = false;       // guard against overlapping whisper calls
  private lastSubtitle = '';        // de-duplicate repeated output
  private tmpDir: string;

  // 16 kHz × 1 channel × 2 bytes (s16le)
  private readonly sampleRate = 16000;
  private readonly bytesPerSecond = 16000 * 1 * 2;

  constructor(options: SubtitleManagerOptions) {
    super();
    this.options = options;
    this.tmpDir = path.join(os.tmpdir(), `rtmp-stt-${options.streamId}`);
  }

  /**
   * Start capturing audio and generating subtitles.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Ensure temp directory
    if (!fs.existsSync(this.tmpDir)) {
      fs.mkdirSync(this.tmpDir, { recursive: true });
    }

    this.startAudioCapture();
    console.log(`[Subtitle ${this.options.streamId}] Started`);
  }

  /**
   * Stop capturing and clean up.
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
      this.segmentTimer = null;
    }

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }

    this.audioBuffer = [];
    this.audioBytes = 0;
    this.processing = false;
    this.lastSubtitle = '';

    // Clean up temp files
    try {
      if (fs.existsSync(this.tmpDir)) {
        fs.rmSync(this.tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }

    console.log(`[Subtitle ${this.options.streamId}] Stopped`);
  }

  /**
   * Update the language without restarting the capture pipeline.
   * Takes effect on the next whisper invocation.
   */
  updateLanguage(lang: string): void {
    this.options.language = lang;
    console.log(`[Subtitle ${this.options.streamId}] Language set to ${lang}`);
  }

  /**
   * Spawn a parallel FFmpeg process that captures audio from the device
   * at 16 kHz mono s16le and pipes to stdout.
   */
  private startAudioCapture(): void {
    const args: string[] = [];

    if (process.platform === 'darwin') {
      args.push('-f', 'avfoundation', '-i', `:${this.options.audioDevice}`);
    } else if (process.platform === 'win32') {
      args.push('-f', 'dshow', '-i', `audio=${this.options.audioDevice}`);
    } else {
      // Linux — pulse/alsa
      args.push('-f', 'pulse', '-i', this.options.audioDevice);
    }

    args.push(
      '-ac', '1',            // mono
      '-ar', '16000',        // 16 kHz
      '-f', 's16le',         // raw PCM
      '-acodec', 'pcm_s16le',
      '-v', 'quiet',
      'pipe:1',              // stdout
    );

    this.ffmpegProcess = spawn(this.options.ffmpegPath, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    this.ffmpegProcess.stdout?.on('data', (chunk: Buffer) => {
      this.audioBuffer.push(chunk);
      this.audioBytes += chunk.length;
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error(`[Subtitle ${this.options.streamId}] FFmpeg error:`, err.message);
    });

    this.ffmpegProcess.on('exit', (code) => {
      if (this.isRunning) {
        console.warn(`[Subtitle ${this.options.streamId}] FFmpeg exited unexpectedly (code ${code})`);
      }
    });

    // Process segments at regular intervals
    const segDuration = this.options.segmentDuration || 3;
    this.segmentTimer = setInterval(() => {
      this.processSegment();
    }, segDuration * 1000);
  }

  /**
   * Take the accumulated audio buffer, write a WAV file, and run whisper.cpp on it.
   * Guarded against concurrent invocations — if whisper is still processing the
   * previous segment the new audio is simply accumulated into the next one.
   */
  private async processSegment(): Promise<void> {
    // Bail out immediately if we've been stopped
    if (!this.isRunning) return;

    if (this.processing) {
      // Previous whisper invocation still running — skip this tick.
      // The audio keeps buffering and will be included in the next segment.
      return;
    }

    if (this.audioBytes < this.bytesPerSecond) {
      // Not enough audio yet (< 1 second)
      return;
    }

    // Ensure tmpDir still exists (may have been cleaned up by stop())
    if (!fs.existsSync(this.tmpDir)) return;

    // Grab current buffer and reset
    const chunks = this.audioBuffer;
    const totalBytes = this.audioBytes;
    this.audioBuffer = [];
    this.audioBytes = 0;

    const pcmData = Buffer.concat(chunks, totalBytes);
    const wavPath = path.join(this.tmpDir, `segment-${Date.now()}.wav`);

    this.processing = true;
    try {
      // Write PCM data as a WAV file
      this.writeWav(wavPath, pcmData);

      // Run whisper.cpp
      const text = await this.runWhisper(wavPath);

      if (text && text.trim()) {
        const cleaned = text.trim();
        // De-duplicate: skip if identical to the previous subtitle
        if (cleaned !== this.lastSubtitle) {
          this.lastSubtitle = cleaned;
          this.emit('subtitle', cleaned);
        }
      }
    } catch (err: any) {
      console.error(`[Subtitle ${this.options.streamId}] Processing error:`, err.message);
    } finally {
      this.processing = false;
      // Clean up segment file and any .txt sidecar whisper may have created
      for (const f of [wavPath, wavPath + '.txt']) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Write raw s16le PCM data as a WAV file (16 kHz, mono, 16-bit).
   */
  private writeWav(filePath: string, pcmData: Buffer): void {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = this.sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcmData.length;

    // WAV header (44 bytes)
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);                              // ChunkID
    header.writeUInt32LE(36 + dataSize, 4);               // ChunkSize
    header.write('WAVE', 8);                              // Format
    header.write('fmt ', 12);                             // Subchunk1ID
    header.writeUInt32LE(16, 16);                         // Subchunk1Size (PCM)
    header.writeUInt16LE(1, 20);                          // AudioFormat (PCM = 1)
    header.writeUInt16LE(numChannels, 22);                // NumChannels
    header.writeUInt32LE(this.sampleRate, 24);            // SampleRate
    header.writeUInt32LE(byteRate, 28);                   // ByteRate
    header.writeUInt16LE(blockAlign, 32);                 // BlockAlign
    header.writeUInt16LE(bitsPerSample, 34);              // BitsPerSample
    header.write('data', 36);                             // Subchunk2ID
    header.writeUInt32LE(dataSize, 40);                   // Subchunk2Size

    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, header);
    fs.writeSync(fd, pcmData);
    fs.closeSync(fd);
  }

  /**
   * Run whisper.cpp on a WAV file and return the recognised text.
   */
  private runWhisper(wavPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const modelPath = getWhisperModelPath();
      const args = [
        '-m', modelPath,
        '-f', wavPath,
        '--no-timestamps',
        '-nt',               // no token timestamps
      ];

      // Language setting
      const lang = this.options.language;
      if (lang && lang !== 'auto') {
        args.push('-l', lang);
      } else {
        args.push('-l', 'auto');
      }

      const proc = spawn(this.options.whisperPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        reject(err);
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`whisper exited with code ${code}: ${stderr}`));
          return;
        }

        // whisper.cpp outputs may include [BLANK_AUDIO] or similar markers — filter them
        const cleaned = stdout
          .replace(/\[BLANK_AUDIO\]/gi, '')
          .replace(/\[.*?\]/g, '')   // remove any bracketed markers
          .trim();

        resolve(cleaned);
      });
    });
  }
}
