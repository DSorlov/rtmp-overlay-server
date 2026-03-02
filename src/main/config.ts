import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface StreamConfig {
  id: number;
  streamName: string;
  defaultTemplate: string;
  enabled: boolean;
  chromaKeyColor?: string;
}

export interface Resolution {
  width: number;
  height: number;
}

export interface AppConfig {
  apiPort: number;
  rtmpPort: number;
  streams: StreamConfig[];
  resolution: Resolution;
  frameRate: number;
  ffmpegPath: string;
  chromaKeyColor: string;
}

function getConfigPath(): string {
  // In packaged app, look in resources; in dev, look in project root
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'config', 'config.json');
  }
  return path.join(__dirname, '..', '..', 'config', 'config.json');
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
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
  config.ffmpegPath = config.ffmpegPath || 'ffmpeg';
  config.chromaKeyColor = config.chromaKeyColor || '#00FF00';

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
    })),
    resolution: config.resolution,
    frameRate: config.frameRate,
    ffmpegPath: config.ffmpegPath,
    chromaKeyColor: config.chromaKeyColor,
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), 'utf-8');
  console.log('[Config] Saved to', configPath);
}
