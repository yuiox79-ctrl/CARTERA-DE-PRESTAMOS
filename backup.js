'use strict';
// Respaldo completo de los datos en JSON y restauración (para copias de seguridad y para mudar el sistema).

const { db, audit } = require('./db');
const { now, today, addDays, HttpError } = require('./util');
const { putBlob, getBlob, deleteBlob } = require('./blobs');

// Orden de inserción que respeta las relaciones entre tablas. Las sesiones no se respaldan.
const TABLES = ['users', 'settings', 'counters', 'clients', 'loans', 'installments', 'schedule_versions', 'billing_mode_changes',
  'invoices', 'accumulated_docs', 'adjustments', 'payments', 'allocations', 'notes', 'audit_log', 'job_runs'];

function exportBackup() {
  const tables = {};
  for (const t of TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
  return { app: 'cartera-prestamos', version: 1, exported_at: now(), tables };
}

function restoreBackup(backup, userId) {
  if (!backup || backup.app !== 'cartera-prestamos' || !backup.tables || typeof backup.tables !== 'object') {
    throw new HttpError(400, 'El archivo no es un respaldo válido de este sistema.');
  }
  // Copia de lo que hay ahora, por si la restauración no era lo que se quería.
  createSnapshot('pre_restauracion', userId);
  const keepDownload = db.prepare("SELECT value FROM settings WHERE key = 'last_download_at'").get();
  const counts = {};
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      // Los usuarios y sesiones actuales se conservan: las contraseñas no viajan entre instalaciones.
      const DATA = TABLES.filter((t) => t !== 'users');
      for (const t of [...DATA].reverse()) db.prepare(`DELETE FROM ${t}`).run();
      for (const t of DATA) {
        const rows = Array.isArray(backup.tables[t]) ? backup.tables[t] : [];
        const cols = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
        for (const r of rows) {
          const keys = Object.keys(r).filter((k) => cols.has(k));
          if (!keys.length) continue;
          db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => r[k]));
        }
        counts[t] = rows.length;
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  // La fecha del último respaldo descargado pertenece a esta instalación, no al respaldo.
  if (keepDownload) setSetting('last_download_at', keepDownload.value);
  audit(userId, {
    entity: 'respaldo', action: 'restaurar',
    summary: `Datos restaurados desde un respaldo del ${String(backup.exported_at || '').slice(0, 16)}: ${counts.clients || 0} cliente(s), ${counts.loans || 0} préstamo(s), ${counts.payments || 0} pago(s)`,
  });
  return counts;
}

// ===== Copias internas =====
const KEEP = 10;                // copias que se conservan (las más antiguas se borran): ~1 mes
const AUTO_EVERY_DAYS = 3;      // copia automática cada 3 días
const DOWNLOAD_REMIND_DAYS = 7; // recordatorio para descargar una copia a un archivo
const KIND_LABEL = { automatica: 'Automática (cada 3 días)', manual: 'Manual', pre_restauracion: 'Antes de restaurar' };

function createSnapshot(kind, userId = null) {
  const b = exportBackup();
  const t = b.tables;
  const info = db.prepare('INSERT INTO backups(kind, created_at, user_id, clients, loans, payments, size) VALUES (?,?,?,?,?,?,0)')
    .run(kind, b.exported_at, userId, t.clients.length, t.loans.length, t.payments.length);
  const id = info.lastInsertRowid;
  const size = putBlob('backup:' + id, JSON.stringify(b));
  db.prepare('UPDATE backups SET size = ? WHERE id = ?').run(size, id);
  // Conserva solo las más recientes.
  for (const old of db.prepare('SELECT id FROM backups ORDER BY id DESC LIMIT -1 OFFSET ?').all(KEEP)) {
    deleteBlob('backup:' + old.id);
    db.prepare('DELETE FROM backups WHERE id = ?').run(old.id);
  }
  return id;
}

function listSnapshots() {
  return db.prepare('SELECT b.*, u.name AS user_name FROM backups b LEFT JOIN users u ON u.id = b.user_id ORDER BY b.id DESC').all()
    .map((b) => ({ ...b, kind_label: KIND_LABEL[b.kind] || b.kind }));
}

function getSnapshot(id) {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(Number(id));
  if (!row) throw new HttpError(404, 'Copia no encontrada.');
  const text = getBlob('backup:' + row.id);
  if (!text) throw new HttpError(410, 'El contenido de esta copia ya no está disponible.');
  return { row, text };
}

/** Copia automática: si la última automática tiene 3 días o más (o no hay ninguna). */
function maybeAutoBackup() {
  const last = db.prepare("SELECT created_at FROM backups WHERE kind = 'automatica' ORDER BY id DESC LIMIT 1").get();
  if (last && last.created_at.slice(0, 10) > addDays(today(), -AUTO_EVERY_DAYS)) return null;
  const hasData = db.prepare('SELECT COUNT(*) n FROM clients').get().n;
  if (!hasData && !last) return null;
  return createSnapshot('automatica');
}

/** Estado para el recordatorio: cuándo se descargó un respaldo a un archivo por última vez. */
function backupStatus() {
  const last = db.prepare("SELECT value FROM settings WHERE key = 'last_download_at'").get();
  const lastDownload = last && last.value ? last.value : null;
  const days = lastDownload ? Math.floor((Date.parse(today()) - Date.parse(lastDownload.slice(0, 10))) / 86400000) : null;
  const lastAuto = db.prepare("SELECT created_at FROM backups WHERE kind = 'automatica' ORDER BY id DESC LIMIT 1").get();
  const hasData = db.prepare('SELECT COUNT(*) n FROM clients').get().n > 0;
  return { last_download_at: lastDownload, days_since_download: days, last_auto_at: lastAuto ? lastAuto.created_at : null,
    remind: hasData && (days === null || days >= DOWNLOAD_REMIND_DAYS) };
}

function setSetting(key, value) {
  if (!db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key).changes) db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run(key, value);
}

function markDownloaded() {
  setSetting('last_download_at', now());
}

module.exports = { exportBackup, restoreBackup, createSnapshot, listSnapshots, getSnapshot, maybeAutoBackup, backupStatus, markDownloaded, TABLES };
