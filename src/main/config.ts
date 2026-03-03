import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export type BackgroundMode = 'chroma' | 'alpha' | 'luma';
export type AudioMode = 'none' | 'template' | 'device';

export interface StreamConfig {
  id: number;
  streamName: string;
  defaultTemplate: string;
  enabled: boolean;
  chromaKeyColor?: string;
  backgroundMode?: BackgroundMode;
  lumaInverted?: boolean;
  audioMode?: AudioMode;
  audioDevice?: string;
  subtitlesEnabled?: boolean;
  subtitleLanguage?: string;
}

export interface Resolution {
  width: number;
  height: number;
}

export interface EncodingConfig {
  preset: string;       // ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow
  profile: string;      // baseline, main, high
  level: string;        // 3.0, 3.1, 4.0, 4.1, 4.2, 5.0, 5.1
  tune: string;         // zerolatency, film, animation, grain, stillimage, (empty)
  videoBitrate: number; // kbps
  maxBitrate: number;   // kbps
  bufferSize: number;   // kbps
  gopSize: number;      // keyframe interval in frames (0 = auto = 1 second)
  audioBitrate: number; // kbps
  pixelFormat: string;  // yuv420p, yuv444p
}

export interface AppConfig {
  apiPort: number;
  rtmpPort: number;
  streams: StreamConfig[];
  resolution: Resolution;
  frameRate: number;
  encoding: EncodingConfig;
  ffmpegPath: string;
  whisperPath: string;
  whisperModel: string;  // e.g. 'tiny', 'base', 'small', 'medium', 'large-v3'
}

function getConfigPath(): string {
  // In packaged app, look in resources; in dev, look in project root
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'config', 'config.json');
  }
  return path.join(__dirname, '..', '..', 'config', 'config.json');
}

function createDefaultConfig(): AppConfig {
  const streams: StreamConfig[] = [];
  for (let i = 1; i <= 4; i++) {
    streams.push({
      id: i,
      streamName: `overlay${i}`,
      defaultTemplate: 'lower-third.html',
      enabled: true,
    });
  }
  return {
    apiPort: 3000,
    rtmpPort: 1935,
    streams,
    resolution: { width: 1920, height: 1080 },
    frameRate: 30,
    encoding: {
      preset: 'ultrafast',
      profile: 'baseline',
      level: '4.0',
      tune: 'zerolatency',
      videoBitrate: 4000,
      maxBitrate: 4500,
      bufferSize: 8000,
      gopSize: 0,
      audioBitrate: 128,
      pixelFormat: 'yuv420p',
    },
    ffmpegPath: 'ffmpeg',
    whisperPath: '',
    whisperModel: 'base',
  };
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    // New install — create default config with 4 streams
    const defaultCfg = createDefaultConfig();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(defaultCfg, null, 2), 'utf-8');
    console.log('[Config] Created default config at', configPath);
    return defaultCfg;
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config: AppConfig = JSON.parse(raw);

  // Validate
  if (!config.streams || !Array.isArray(config.streams)) {
    throw new Error('Config must have a "streams" array');
  }

  if (config.streams.length > 12) {
    throw new Error('Maximum 12 streams supported');
  }

  // Check for duplicate stream names
  const names = config.streams.map((s) => s.streamName);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) {
    throw new Error('Each stream must have a unique streamName');
  }

  // Check for duplicate IDs
  const ids = config.streams.map((s) => s.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    throw new Error('Each stream must have a unique ID');
  }

  // Defaults
  config.apiPort = config.apiPort || 3000;
  config.rtmpPort = config.rtmpPort || 1935;
  config.resolution = config.resolution || { width: 1920, height: 1080 };
  config.frameRate = config.frameRate || 30;
  config.encoding = config.encoding || {
    preset: 'ultrafast',
    profile: 'baseline',
    level: '4.0',
    tune: 'zerolatency',
    videoBitrate: 4000,
    maxBitrate: 4500,
    bufferSize: 8000,
    gopSize: 0,
    audioBitrate: 128,
    pixelFormat: 'yuv420p',
  };
  // Fill in any missing encoding fields with defaults
  config.encoding.preset = config.encoding.preset || 'ultrafast';
  config.encoding.profile = config.encoding.profile || 'baseline';
  config.encoding.level = config.encoding.level || '4.0';
  config.encoding.tune = config.encoding.tune || 'zerolatency';
  config.encoding.videoBitrate = config.encoding.videoBitrate || 4000;
  config.encoding.maxBitrate = config.encoding.maxBitrate || 4500;
  config.encoding.bufferSize = config.encoding.bufferSize || 8000;
  config.encoding.gopSize = config.encoding.gopSize ?? 0;
  config.encoding.audioBitrate = config.encoding.audioBitrate || 128;
  config.encoding.pixelFormat = config.encoding.pixelFormat || 'yuv420p';
  config.ffmpegPath = config.ffmpegPath || 'ffmpeg';
  config.whisperPath = config.whisperPath || '';
  config.whisperModel = config.whisperModel || 'base';

  return config;
}

export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  // Only persist the serialisable fields (not the runtime ffmpegPath override)
  const toSave = {
    apiPort: config.apiPort,
    rtmpPort: config.rtmpPort,
    streams: config.streams.map(s => ({
      id: s.id,
      streamName: s.streamName,
      defaultTemplate: s.defaultTemplate,
      enabled: s.enabled,
      ...(s.chromaKeyColor ? { chromaKeyColor: s.chromaKeyColor } : {}),
      ...(s.backgroundMode ? { backgroundMode: s.backgroundMode } : {}),
      ...(s.lumaInverted != null ? { lumaInverted: s.lumaInverted } : {}),
      ...(s.audioMode ? { audioMode: s.audioMode } : {}),
      ...(s.audioDevice ? { audioDevice: s.audioDevice } : {}),
      ...(s.subtitlesEnabled != null ? { subtitlesEnabled: s.subtitlesEnabled } : {}),
      ...(s.subtitleLanguage ? { subtitleLanguage: s.subtitleLanguage } : {}),
    })),
    resolution: config.resolution,
    frameRate: config.frameRate,
    encoding: config.encoding,
    ffmpegPath: config.ffmpegPath,
    whisperModel: config.whisperModel || 'base',
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), 'utf-8');
  console.log('[Config] Saved to', configPath);
}
