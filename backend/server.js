/**
 * Express server entry point. Serves the static frontend and mounts the API.
 */
import express from 'express';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { router as apiRouter } from './api/routes.js';

const app = express();

app.use(express.json({ limit: '256kb' }));

// Basic request logging.
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.url}`);
  next();
});

// API.
app.use('/api', apiRouter);

// Static frontend.
app.use(express.static(config.paths.frontend));

// SPA-ish fallback to index.html for unknown non-API GETs.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile('index.html', { root: config.paths.frontend });
});

// Centralized error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

app.listen(config.port, () => {
  logger.info(`Buffett/Graham Evaluator running at http://localhost:${config.port}`);
  logger.info('Educational use only — not financial advice.');
});
