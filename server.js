'use strict';
// Servidor del sistema de administración de préstamos, facturación mensual y cartera.

const path = require('path');
const express = require('express');
const compression = require('compression');
const { HttpError } = require('./server/util');
const { login, logout, requireAuth } = require('./server/auth');
const { startScheduler } = require('./server/billing');
const pgsync = process.env.DATABASE_URL ? require('./server/pgsync') : null;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // detrás del proxy HTTPS de Render u otro proveedor
app.use(compression()); // respuestas comprimidas: páginas y datos llegan más rápido
app.use('/api/backup/restore', express.json({ limit: '100mb' }));
app.use(express.json({ limit: '1mb' }));
app.get('/healthz', (req, res) => res.json({ ok: true }));
const { syncToday } = require('./server/db');
app.use('/api', (req, res, next) => { syncToday(); next(); });
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

if (pgsync) { app.use('/api/login', pgsync.middleware); app.use('/api/logout', pgsync.middleware); }
app.post('/api/login', login);
app.post('/api/logout', logout);

const api = express.Router();
api.use(requireAuth);
if (pgsync) api.use(pgsync.middleware);
api.get('/sync-status', (req, res) => res.json(pgsync ? pgsync.status() : { enabled: false }));
api.use('/clients', require('./server/routes/clients'));
api.use('/loans', require('./server/routes/loans'));
api.use('/invoices', require('./server/routes/invoices'));
api.use('/payments', require('./server/routes/payments'));
api.use('/', require('./server/routes/reports'));
api.use('/', require('./server/routes/admin'));
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist'), { maxAge: '30d', immutable: true }));
// Archivos de la interfaz: el navegador los guarda, pero confirma que no cambiaron (ETag) para recibir siempre la última versión.
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0, etag: true, lastModified: true }));
app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Solicitud con formato inválido.' });
  if (err && /UNIQUE constraint failed: invoices/.test(err.message)) return res.status(409).json({ error: 'Ya existe una factura vigente para esa cuota (protección contra duplicados).' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

if (require.main === module) {
  (async () => {
    if (pgsync) {
      console.log('[supabase] Conectando a PostgreSQL…');
      await pgsync.init(process.env.DATABASE_URL);
    }
    const port = Number(process.env.PORT) || 3000;
    const server = app.listen(port, () => console.log(`[cartera] Servidor escuchando en http://localhost:${port}`));
    if (process.env.DISABLE_SCHEDULER !== '1') startScheduler(pgsync ? () => pgsync.flush() : null);
    const stop = async () => { server.close(); if (pgsync) await pgsync.close(); process.exit(0); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  })().catch((e) => {
    console.error('[cartera] No se pudo iniciar:', e.message);
    process.exit(1);
  });
}

module.exports = app;
