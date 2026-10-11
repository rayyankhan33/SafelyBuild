import cors from 'cors';
import express from 'express';
import { pool } from './db/pool.js';
import { errorHandler } from './http.js';
import { inferenceHealth } from './inference.js';
import { router as authRouter } from './routes/auth.js';
import { router as projectRouter } from './routes/projects.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    let db = false;
    try { await pool.query('SELECT 1'); db = true; } catch { /* reported below */ }
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', database: db, inference: await inferenceHealth() });
  });

  app.use('/api', authRouter);
  app.use('/api', projectRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'no such endpoint' } }));
  app.use(errorHandler);
  return app;
}
