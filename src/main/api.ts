import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { StreamManager } from './stream-manager';
import { TemplateManager } from './template-manager';
import { RtmpServer } from './rtmp-server';

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
