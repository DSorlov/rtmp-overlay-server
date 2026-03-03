import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { StreamManager } from './stream-manager';
import { TemplateManager } from './template-manager';
import { RtmpServer } from './rtmp-server';
import { saveConfig } from './config';

export async function createApiServer(
  streamManager: StreamManager,
  templateManager: TemplateManager,
  port: number,
  rtmpServer?: RtmpServer,
): Promise<FastifyInstance> {
  const server = Fastify({
    logger: false,
  });

  await server.register(cors, { origin: true });

  // ─── Health Check ─────────────────────────────────────────────

  server.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ─── List All Streams ─────────────────────────────────────────

  server.get('/api/streams', async () => {
    return { streams: streamManager.getAllStreams() };
  });

  // ─── Get Single Stream ────────────────────────────────────────

  server.get<{ Params: { id: string } }>('/api/streams/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const stream = streamManager.getStream(id);
    if (!stream) {
      return reply.code(404).send({ error: `Stream ${id} not found` });
    }
    return stream;
  });

  // ─── Start Stream ────────────────────────────────────────────

  server.post<{ Params: { id: string } }>('/api/streams/:id/start', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    try {
      await streamManager.startStream(id);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Stop Stream ─────────────────────────────────────────────

  server.post<{ Params: { id: string } }>('/api/streams/:id/stop', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    try {
      await streamManager.stopStream(id);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Change Template ─────────────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { template: string };
  }>('/api/streams/:id/template', {
    schema: {
      body: {
        type: 'object',
        required: ['template'],
        properties: {
          template: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { template } = request.body;
    try {
      await streamManager.changeTemplate(id, template);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Update Placeholder Data (merge) ─────────────────────────

  server.patch<{
    Params: { id: string };
    Body: Record<string, string>;
  }>('/api/streams/:id/data', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const data = request.body as Record<string, string>;
    try {
      await streamManager.updateData(id, data);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Replace All Placeholder Data ────────────────────────────

  server.put<{
    Params: { id: string };
    Body: Record<string, string>;
  }>('/api/streams/:id/data', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const data = request.body as Record<string, string>;
    try {
      await streamManager.setData(id, data);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Set Chroma Key Color ────────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { color: string };
  }>('/api/streams/:id/chroma', {
    schema: {
      body: {
        type: 'object',
        required: ['color'],
        properties: {
          color: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { color } = request.body;
    try {
      await streamManager.updateStreamChromaColor(id, color);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Set Background Mode ─────────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { mode: string };
  }>('/api/streams/:id/background-mode', {
    schema: {
      body: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['chroma', 'alpha', 'luma'] },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { mode } = request.body;
    if (mode !== 'chroma' && mode !== 'alpha' && mode !== 'luma') {
      return reply.code(400).send({ error: 'mode must be "chroma", "alpha", or "luma"' });
    }
    try {
      await streamManager.updateStreamBackgroundMode(id, mode);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Set Luma Inverted ────────────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { inverted: boolean };
  }>('/api/streams/:id/luma-inverted', {
    schema: {
      body: {
        type: 'object',
        required: ['inverted'],
        properties: {
          inverted: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { inverted } = request.body;
    try {
      await streamManager.updateStreamLumaInverted(id, inverted);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Set Audio Mode ──────────────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { mode: string };
  }>('/api/streams/:id/audio-mode', {
    schema: {
      body: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['none', 'template', 'device'] },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { mode } = request.body;
    if (mode !== 'none' && mode !== 'template' && mode !== 'device') {
      return reply.code(400).send({ error: 'mode must be "none", "template", or "device"' });
    }
    try {
      await streamManager.updateStreamAudioMode(id, mode);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Set Audio Device ────────────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { device: string };
  }>('/api/streams/:id/audio-device', {
    schema: {
      body: {
        type: 'object',
        required: ['device'],
        properties: {
          device: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { device } = request.body;
    try {
      await streamManager.updateStreamAudioDevice(id, device);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Set Stream Key (streamName) ─────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { key: string };
  }>('/api/streams/:id/stream-key', {
    schema: {
      body: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { key } = request.body;
    try {
      const config = streamManager.getConfig();
      const sc = config.streams.find(s => s.id === id);
      if (sc) {
        sc.streamName = key;
        saveConfig(config);
      }
      await streamManager.updateStreamKey(id, key);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Set Subtitles Enabled ───────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { enabled: boolean };
  }>('/api/streams/:id/subtitles-enabled', {
    schema: {
      body: {
        type: 'object',
        required: ['enabled'],
        properties: {
          enabled: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { enabled } = request.body;
    try {
      const config = streamManager.getConfig();
      const sc = config.streams.find(s => s.id === id);
      if (sc) {
        sc.subtitlesEnabled = enabled;
        saveConfig(config);
      }
      await streamManager.updateStreamSubtitles(id, enabled);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Set Subtitle Language ───────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { language: string };
  }>('/api/streams/:id/subtitle-language', {
    schema: {
      body: {
        type: 'object',
        required: ['language'],
        properties: {
          language: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { language } = request.body;
    try {
      const config = streamManager.getConfig();
      const sc = config.streams.find(s => s.id === id);
      if (sc) {
        sc.subtitleLanguage = language;
        saveConfig(config);
      }
      await streamManager.updateStreamSubtitleLanguage(id, language);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Execute Template Function ────────────────────────────────

  server.post<{
    Params: { id: string };
    Body: { function: string; argument?: string };
  }>('/api/streams/:id/execute', {
    schema: {
      body: {
        type: 'object',
        required: ['function'],
        properties: {
          function: { type: 'string', minLength: 1 },
          argument: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { function: fnName, argument } = request.body;
    try {
      const fnResult = await streamManager.executeFunction(id, fnName, argument);
      if (!fnResult.found) {
        return reply.code(400).send({ error: fnResult.error || 'Function not found' });
      }
      if (fnResult.error) {
        return reply.code(500).send({ error: fnResult.error });
      }
      return { success: true, result: fnResult.result };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Timer: Set Duration ──────────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { seconds: number };
  }>('/api/streams/:id/timer/duration', {
    schema: {
      body: {
        type: 'object',
        required: ['seconds'],
        properties: {
          seconds: { type: 'number', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { seconds } = request.body;
    try {
      streamManager.setTimerDuration(id, seconds);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Timer: Set Direction ─────────────────────────────────────

  server.put<{
    Params: { id: string };
    Body: { direction: string };
  }>('/api/streams/:id/timer/direction', {
    schema: {
      body: {
        type: 'object',
        required: ['direction'],
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
        },
      },
    },
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const { direction } = request.body;
    if (direction !== 'up' && direction !== 'down') {
      return reply.code(400).send({ error: 'direction must be "up" or "down"' });
    }
    try {
      streamManager.setTimerDirection(id, direction);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Timer: Start ─────────────────────────────────────────────

  server.post<{ Params: { id: string } }>('/api/streams/:id/timer/start', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    try {
      streamManager.startTimer(id);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Timer: Stop ──────────────────────────────────────────────

  server.post<{ Params: { id: string } }>('/api/streams/:id/timer/stop', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    try {
      streamManager.stopTimer(id);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── Timer: Reset ─────────────────────────────────────────────

  server.post<{ Params: { id: string } }>('/api/streams/:id/timer/reset', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    try {
      streamManager.resetTimer(id);
      return { success: true, stream: streamManager.getStream(id) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ─── List Templates ──────────────────────────────────────────

  server.get('/api/templates', async () => {
    const list = templateManager.listTemplates();
    const placeholders: Record<string, string[]> = {};
    for (const t of list) {
      placeholders[t] = templateManager.getPlaceholders(t);
    }
    return { templates: list, placeholders };
  });

  // ─── Get Template Placeholders ────────────────────────────────

  server.get<{ Params: { name: string } }>('/api/templates/:name/placeholders', async (request, reply) => {
    const { name } = request.params;
    try {
      const keys = templateManager.getPlaceholders(name);
      return { template: name, placeholders: keys };
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  // ─── Capture Frame (thumbnail) ───────────────────────────────

  server.get<{ Params: { id: string } }>('/api/streams/:id/preview', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const buffer = await streamManager.captureFrame(id);
    if (!buffer) {
      return reply.code(404).send({ error: 'No frame available' });
    }
    return reply.type('image/png').send(buffer);
  });

  // ─── RTMP Stats ──────────────────────────────────────────────

  server.get('/api/stats', async () => {
    const stats = rtmpServer ? rtmpServer.getAllStats() : {};
    return { stats };
  });

  // Start listening
  await server.listen({ port, host: '0.0.0.0' });
  console.log(`[API] Server listening on http://0.0.0.0:${port}`);

  return server;
}
