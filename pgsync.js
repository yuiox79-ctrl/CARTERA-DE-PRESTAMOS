'use strict';
// Persistencia en PostgreSQL (Supabase).
//
// El sistema calcula con SQLite en memoria (mismas consultas, vistas y reglas de siempre) y PostgreSQL es la
// base de datos oficial: al arrancar se cargan todas las filas desde PostgreSQL y cada cambio se escribe allí
// antes de responder. Unos disparadores (triggers) anotan qué filas cambiaron para enviar solo esas.

const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT -> número
const { db } = require('./db');
const { installChangeLog, takeChanges, restoreChanges, markChanged, pendingCount } = require('./changelog');

// Tabla -> clave primaria. Se sincroniza todo, incluidas las sesiones (para no cerrar sesión al reiniciar).
const TABLES = {
  users: 'id', settings: 'key', counters: 'name', sessions: 'token', clients: 'id', loans: 'id', installments: 'id',
  schedule_versions: 'id', billing_mode_changes: 'id', invoices: 'id', accumulated_docs: 'id', adjustments: 'id',
  payments: 'id', allocations: 'id', notes: 'id', audit_log: 'id', job_runs: 'id', backups: 'id', trash: 'id', blob_chunks: 'id',
};
const BATCH = 200;

let pool = null;
let flushing = Promise.resolve();
let lastError = null;
let retryTimer = null;
const quote = (c) => `"${c}"`;

function pgType(sqliteType) {
  const t = String(sqliteType || '').toUpperCase();
  if (t.includes('INT')) return 'BIGINT';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'DOUBLE PRECISION';
  return 'TEXT';
}
function columns(t) { return db.prepare(`PRAGMA table_info(${t})`).all(); }

/** Crea en PostgreSQL las tablas y columnas que falten, a partir del esquema de SQLite. */
async function ensureSchema(client) {
  for (const [t, pk] of Object.entries(TABLES)) {
    const cols = columns(t);
    const defs = cols.map((c) => `${quote(c.name)} ${pgType(c.type)}${c.name === pk ? ' PRIMARY KEY' : ''}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${quote(t)} (${defs.join(', ')})`);
    for (const c of cols) await client.query(`ALTER TABLE ${quote(t)} ADD COLUMN IF NOT EXISTS ${quote(c.name)} ${pgType(c.type)}`);
    // Supabase publica el esquema "public" por su API REST: con RLS activo y sin políticas, nadie puede leer
    // estas tablas por esa vía. Este servidor se conecta como dueño de las tablas y no se ve afectado.
    await client.query(`ALTER TABLE ${quote(t)} ENABLE ROW LEVEL SECURITY`);
  }
}

const toSqlite = (v) => (v === undefined ? null : v);

/** Envía a PostgreSQL las filas pendientes. Las anotaciones se borran solo cuando se guardaron bien. */
function flush() {
  flushing = flushing.then(async () => {
    const pending = takeChanges(TABLES);
    if (!pending.length) { lastError = null; return; }
    const byTable = {};
    for (const p of pending) (byTable[p.table] ||= []).push(p);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      for (const [t, list] of Object.entries(byTable)) {
        const pk = TABLES[t];
        const cols = columns(t).map((c) => c.name);
        const rows = list.filter((c) => c.row).map((c) => c.row);
        const gone = list.filter((c) => !c.row).map((c) => String(c.pk));
        if (gone.length) await client.query(`DELETE FROM ${quote(t)} WHERE CAST(${quote(pk)} AS TEXT) = ANY($1)`, [gone]);
        for (let i = 0; i < rows.length; i += BATCH) {
          const chunk = rows.slice(i, i + BATCH);
          const params = [];
          const values = chunk.map((r) => `(${cols.map((c) => { params.push(r[c]); return `$${params.length}`; }).join(',')})`);
          const updates = cols.filter((c) => c !== pk).map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`);
          await client.query(`INSERT INTO ${quote(t)} (${cols.map(quote).join(',')}) VALUES ${values.join(',')}
            ON CONFLICT (${quote(pk)}) DO ${updates.length ? 'UPDATE SET ' + updates.join(', ') : 'NOTHING'}`, params);
        }
      }
      await client.query('COMMIT');
      if (lastError) console.log('[supabase] Cambios pendientes guardados.');
      lastError = null;
    } catch (e) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      restoreChanges(pending);
      lastError = e;
      console.error('[supabase] No se pudieron guardar los cambios; se reintentará:', e.message);
      scheduleRetry();
    } finally {
      if (client) client.release();
    }
  });
  return flushing;
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; flush(); }, 15000);
}

/** Conecta, crea las tablas si faltan y carga todos los datos de PostgreSQL en el motor de cálculo. */
async function init(url) {
  const ssl = /localhost|127\.0\.0\.1/.test(url) || process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false };
  pool = new Pool({ connectionString: url, ssl, max: 4, idleTimeoutMillis: 30000 });
  pool.on('error', (e) => console.error('[supabase] Error de conexión:', e.message));
  const client = await pool.connect();
  const loaded = {};
  try {
    await ensureSchema(client);
    for (const [t, pk] of Object.entries(TABLES)) {
      const { rows } = await client.query(`SELECT * FROM ${quote(t)} ORDER BY ${quote(pk)}`);
      loaded[t] = rows;
    }
  } finally {
    client.release();
  }
  // Carga en SQLite (los datos de PostgreSQL reemplazan los valores por defecto creados al iniciar).
  const fkOff = () => db.pragma('foreign_keys = OFF');
  fkOff();
  const hadUsers = loaded.users.length > 0;
  db.transaction(() => {
    if (hadUsers) db.prepare('DELETE FROM users').run();
    for (const [t, rows] of Object.entries(loaded)) {
      const cols = new Set(columns(t).map((c) => c.name));
      for (const r of rows) {
        const keys = Object.keys(r).filter((k) => cols.has(k));
        db.prepare(`INSERT OR REPLACE INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => toSqlite(r[k])));
      }
    }
  })();
  db.pragma('foreign_keys = ON');
  installChangeLog(TABLES);
  // Lo que existe aquí pero no en PostgreSQL (configuración por defecto, usuario inicial) se envía ahora.
  db.transaction(() => {
    for (const [t, pk] of Object.entries(TABLES)) {
      const remote = new Set(loaded[t].map((r) => String(r[pk])));
      for (const r of db.prepare(`SELECT ${pk} AS k FROM ${t}`).all()) if (!remote.has(String(r.k))) markChanged(t, r.k);
    }
  })();
  await flush();
  if (lastError) throw lastError;
  const n = (t) => loaded[t].length;
  console.log(`[supabase] Conectado. Cargados: ${n('clients')} cliente(s), ${n('loans')} préstamo(s), ${n('payments')} pago(s).`);
}

/** Middleware: en cada operación que modifica datos, espera a que PostgreSQL confirme antes de responder. */
function middleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const send = res.json.bind(res);
  const end = res.end.bind(res);
  let done = false;
  const wrap = (fn) => (...args) => {
    if (done) return fn(...args);
    done = true;
    flush().then(() => {
      const p = pendingCount();
      if (p && !res.headersSent) res.setHeader('X-Sync-Pending', String(p));
      fn(...args);
    });
    return res;
  };
  res.json = wrap(send);
  res.end = wrap(end);
  next();
}

function status() {
  return { enabled: !!pool, pending: pendingCount(), error: lastError ? lastError.message : null };
}

async function close() { await flushing; if (pool) await pool.end(); }

module.exports = { init, flush, middleware, status, close, TABLES };
