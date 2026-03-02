import NodeMediaServer = require('node-media-server');
import { EventEmitter } from 'events';

/**
 * Per-stream session info tracked by the RTMP server
 */
export interface RtmpStreamStats {
  /** Number of viewers (play sessions) */
  viewers: number;
  /** Whether a publisher (FFmpeg) is actively pushing */
  publishing: boolean;
}

/**
 * Manages the built-in RTMP server (node-media-server v2.x) that accepts
 * incoming FFmpeg pushes and relays streams to external consumers (OBS, VLC, etc.).
 *
 * Architecture:
 *   FFmpeg → pushes to rtmp://127.0.0.1:PORT/live/streamN
 *   Clients → pull from  rtmp://HOST:PORT/live/streamN
 *
 * Emits:
 *   'stats-update' — whenever a client connects/disconnects
 */
export class RtmpServer extends EventEmitter {
  private nms: any = null;
  private port: number;
  private _isRunning: boolean = false;

  /** Track publishers: streamPath → session id */
  private publishers: Map<string, string> = new Map();

  /** Track players: streamPath → Set of session ids */
  private players: Map<string, Set<string>> = new Map();

  constructor(port: number) {
    super();
    this.port = port;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Get stats for a specific stream path (e.g. '/live/stream1')
   */
  getStreamStats(streamName: string): RtmpStreamStats {
    const streamPath = `/live/${streamName}`;
    return {
      publishing: this.publishers.has(streamPath),
      viewers: this.players.get(streamPath)?.size ?? 0,
    };
  }

  /**
   * Get stats for all known streams
   */
  getAllStats(): Record<string, RtmpStreamStats> {
    const result: Record<string, RtmpStreamStats> = {};
    const allPaths = new Set([...this.publishers.keys(), ...this.players.keys()]);
    for (const streamPath of allPaths) {
      // Extract stream name from path  /live/stream1 → stream1
      const name = streamPath.replace(/^\/live\//, '');
      result[name] = {
        publishing: this.publishers.has(streamPath),
        viewers: this.players.get(streamPath)?.size ?? 0,
      };
    }
    return result;
  }

  /**
   * Start the RTMP server
   */
  start(): void {
    if (this._isRunning) return;

    const config = {
      logType: 1, // 0=none, 1=error, 2=normal, 3=debug
      rtmp: {
        port: this.port,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60,
      },
    };

    this.nms = new NodeMediaServer(config);

    // node-media-server v2.x event signatures: (id, streamPath, args)

    this.nms.on('preConnect', (id: string, args: any) => {
      console.log(`[RTMP] Client connecting: ${id}`, args);
    });

    this.nms.on('doneConnect', (id: string, args: any) => {
      console.log(`[RTMP] Client disconnected: ${id}`);
      // Clean up any stale publish/play sessions for this id
      for (const [path, pubId] of this.publishers.entries()) {
        if (pubId === id) {
          this.publishers.delete(path);
          this.emitStatsUpdate();
          break;
        }
      }
      for (const [path, playerSet] of this.players.entries()) {
        if (playerSet.delete(id)) {
          if (playerSet.size === 0) this.players.delete(path);
          this.emitStatsUpdate();
          break;
        }
      }
    });

    this.nms.on('postPublish', (id: string, streamPath: string, args: any) => {
      console.log(`[RTMP] Publishing: ${streamPath} (session ${id})`);
      this.publishers.set(streamPath, id);
      this.emitStatsUpdate();
    });

    this.nms.on('donePublish', (id: string, streamPath: string, args: any) => {
      console.log(`[RTMP] Unpublished: ${streamPath} (session ${id})`);
      this.publishers.delete(streamPath);
      this.emitStatsUpdate();
    });

    this.nms.on('postPlay', (id: string, streamPath: string, args: any) => {
      console.log(`[RTMP] Playing: ${streamPath} (session ${id})`);
      if (!this.players.has(streamPath)) {
        this.players.set(streamPath, new Set());
      }
      this.players.get(streamPath)!.add(id);
      this.emitStatsUpdate();
    });

    this.nms.on('donePlay', (id: string, streamPath: string, args: any) => {
      console.log(`[RTMP] Stopped playing: ${streamPath} (session ${id})`);
      const playerSet = this.players.get(streamPath);
      if (playerSet) {
        playerSet.delete(id);
        if (playerSet.size === 0) this.players.delete(streamPath);
      }
      this.emitStatsUpdate();
    });

    this.nms.run();
    this._isRunning = true;

    console.log(`[RTMP] Server listening on 0.0.0.0:${this.port}`);
  }

  /**
   * Stop the RTMP server
   */
  stop(): void {
    if (!this._isRunning || !this.nms) return;

    this.nms.stop();
    this.nms = null;
    this._isRunning = false;
    this.publishers.clear();
    this.players.clear();

    console.log('[RTMP] Server stopped');
  }

  /**
   * Get the local push URL for a stream (used by FFmpeg)
   */
  getPushUrl(streamName: string): string {
    return `rtmp://127.0.0.1:${this.port}/live/${streamName}`;
  }

  /**
   * Get the public URL for a stream (used by external consumers)
   */
  getPlayUrl(streamName: string, host: string = 'localhost'): string {
    return `rtmp://${host}:${this.port}/live/${streamName}`;
  }

  /**
   * Explicitly clear publishing state for a stream.
   * Called when the stream manager stops a stream (kills FFmpeg)
   * because NMS may not detect the socket closure immediately.
   */
  clearStreamStats(streamName: string): void {
    const streamPath = `/live/${streamName}`;

    // Force-reject the stale publisher via NMS v2.x internal API
    try {
      const sessions = this.nms?.sessions;
      if (sessions) {
        const pubId = this.publishers.get(streamPath);
        if (pubId && sessions.has(pubId)) {
          const session = sessions.get(pubId);
          console.log(`[RTMP] Force-closing stale publisher session ${pubId} for ${streamPath}`);
          session.reject();
        }
      }
    } catch (err: any) {
      console.warn(`[RTMP] Could not clear NMS session: ${err.message}`);
    }

    // Clear our own tracking maps
    let changed = false;
    if (this.publishers.has(streamPath)) {
      this.publishers.delete(streamPath);
      changed = true;
    }
    if (this.players.has(streamPath)) {
      this.players.delete(streamPath);
      changed = true;
    }
    if (changed) {
      this.emitStatsUpdate();
    }
  }

  private emitStatsUpdate(): void {
    this.emit('stats-update', this.getAllStats());
  }
}
