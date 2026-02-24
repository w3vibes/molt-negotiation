import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { registerAgentRoutes } from './routes/agents.js';
import { registerAutomationRoutes } from './routes/automation.js';
import { registerEscrowRoutes } from './routes/escrow.js';
import { registerLeaderboardRoutes } from './routes/leaderboard.js';
import { registerInstallRoutes } from './routes/install.js';
import { registerReadRoutes } from './routes/read.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSystemRoutes } from './routes/system.js';
import {
  escrowAutomationEnabledByDefault,
  escrowAutomationIntervalMs,
  runEscrowAutomationTick
} from './services/automation.js';
import { createStore, type Store } from './services/store.js';
import { metrics } from './services/metrics.js';

export type ServerOptions = {
  dbFile?: string;
  logger?: boolean;
  store?: Store;
};

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ 
    logger: options.logger ?? true,
    genReqId: () => `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  });

  const store = options.store || createStore({ dbFile: options.dbFile });

  // CORS
  app.register(cors, { 
    origin: true,
    credentials: true
  });

  // Rate limiting
  app.register(rateLimit, {
    max: Number(process.env.NEG_RATE_LIMIT_MAX || 120),
    timeWindow: process.env.NEG_RATE_LIMIT_WINDOW || '1 minute',
    keyGenerator: (request) => {
      return request.headers.authorization || request.ip || 'unknown';
    }
  });

  // Swagger API docs
  app.register(swagger, {
    openapi: {
      info: {
        title: 'MoltNegotiation API',
        version: '0.1.0',
        description: 'Production-first private Agent-to-Agent negotiation platform on EigenCompute'
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local development' }]
    }
  });

  app.register(swaggerUI, {
    routePrefix: '/docs'
  });

  // Metrics hooks
  app.addHook('onRequest', async (req) => {
    (req as typeof req & { _startedAt?: number })._startedAt = Date.now();
  });

  app.addHook('onResponse', async (req, reply) => {
    const startedAt = (req as typeof req & { _startedAt?: number })._startedAt || Date.now();
    const durationMs = Date.now() - startedAt;
    
    metrics.observe({
      route: req.routeOptions?.url || req.url,
      method: req.method,
      statusCode: reply.statusCode,
      durationMs
    });
  });

  // Register routes
  registerSystemRoutes(app, store);
  registerInstallRoutes(app, store);
  registerAgentRoutes(app, store);
  registerSessionRoutes(app, store);
  registerEscrowRoutes(app, store);
  registerReadRoutes(app, store);
  registerLeaderboardRoutes(app, store);
  registerAutomationRoutes(app, store);

  // Escrow automation
  let automationTimer: ReturnType<typeof setInterval> | undefined;

  if (escrowAutomationEnabledByDefault()) {
    const intervalMs = escrowAutomationIntervalMs();
    automationTimer = setInterval(() => {
      try {
        const summary = runEscrowAutomationTick(store);
        if (summary.settled > 0 || summary.refunded > 0 || summary.pending > 0) {
          app.log.info({ summary }, 'escrow_automation_tick');
        }
      } catch (error) {
        app.log.error({ err: error }, 'escrow_automation_tick_failed');
      }
    }, intervalMs);

    automationTimer.unref?.();
  }

  // 404 handler
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({
      ok: false,
      error: {
        code: 'not_found',
        message: 'Route not found'
      }
    });
  });

  // Error handler
  app.setErrorHandler((error, _req, reply) => {
    if (reply.sent) return;
    app.log.error({ err: error }, 'unhandled_error');
    reply.code(500).send({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Internal server error'
      }
    });
  });

  // Cleanup
  app.addHook('onClose', async () => {
    if (automationTimer) {
      clearInterval(automationTimer);
    }
    store.close();
  });

  return app;
}
