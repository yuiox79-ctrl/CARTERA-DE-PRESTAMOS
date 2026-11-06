'use strict';
// Historial general: une la bitácora (acciones de los usuarios) con las ejecuciones del proceso automático
// de facturación que produjeron cambios, en una sola línea de tiempo.

const { db } = require('./db');
const { today } = require('./util');

const SOURCE = `
  SELECT 'a' AS src, a.id, a.at, a.user_id, a.client_id, a.entity, a.entity_id, a.action, a.summary, a.detail FROM audit_log a
  UNION ALL
  SELECT 'j', j.id, j.started_at, NULL, NULL, 'sistema', NULL, 'facturar',
    'Facturación automática: ' || COALESCE(j.invoices_created, 0) || ' factura(s) emitida(s)'
      || CASE WHEN COALESCE(j.docs_created, 0) > 0 THEN ', ' || j.docs_created || ' resumen(es) acumulado(s)' ELSE '' END
      || CASE WHEN COALESCE(j.loans_closed, 0) > 0 THEN ', ' || j.loans_closed || ' préstamo(s) cancelado(s)' ELSE '' END,
    NULL
  FROM job_runs j WHERE COALESCE(j.invoices_created, 0) + COALESCE(j.docs_created, 0) + COALESCE(j.loans_closed, 0) > 0`;

/** Grupos que ve el usuario (chips de filtro). */
const GROUPS = {
  clientes: "h.entity = 'cliente' AND h.action NOT IN ('eliminar','restaurar')",
  prestamos: "h.entity = 'prestamo' AND h.action NOT IN ('eliminar','restaurar')",
  pagos: "h.entity = 'pago'",
  facturas: "h.entity = 'factura'",
  notas: "h.entity = 'nota'",
  eliminaciones: "(h.action IN ('eliminar','restaurar','vaciar') OR h.entity = 'papelera')",
  sistema: "h.entity IN ('sistema','configuracion','respaldo','usuario')",
};

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function where(q) {
  const w = ['1=1'];
  const p = [];
  if (GROUPS[q.group]) w.push(GROUPS[q.group]);
  const text = String(q.q || '').trim();
  if (text) {
    w.push('(h.summary LIKE ? OR c.full_name LIKE ? OR u.name LIKE ? OR h.detail LIKE ?)');
    p.push(`%${text}%`, `%${text}%`, `%${text}%`, `%${text}%`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { w.push('substr(h.at, 1, 10) >= ?'); p.push(q.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) { w.push('substr(h.at, 1, 10) <= ?'); p.push(q.to); }
  return { sql: w.join(' AND '), p };
}

const FROM = `FROM (${SOURCE}) h LEFT JOIN users u ON u.id = h.user_id LEFT JOIN clients c ON c.id = h.client_id`;

function listHistory(q) {
  const size = Math.min(Math.max(Number(q.size) || 40, 1), 200);
  const page = Math.max(Number(q.page) || 1, 1);
  const { sql, p } = where(q);
  const total = db.prepare(`SELECT COUNT(*) n ${FROM} WHERE ${sql}`).get(...p).n;
  const rows = db.prepare(`SELECT h.*, u.name AS user_name, c.full_name AS client_name, c.code AS client_code ${FROM}
      WHERE ${sql} ORDER BY h.at DESC, h.src, h.id DESC LIMIT ? OFFSET ?`).all(...p, size, (page - 1) * size);
  const t = today();
  const groupCols = Object.entries(GROUPS).map(([k, cond]) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) AS ${k}`).join(', ');
  const stats = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN substr(h.at, 1, 10) = ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN substr(h.at, 1, 10) >= ? THEN 1 ELSE 0 END) AS week,
      MIN(h.at) AS first_at, ${groupCols} ${FROM}`).get(t, addDays(t, -6));
  return { rows, total, page, size, stats };
}

function exportRows(q) {
  const { sql, p } = where(q);
  return db.prepare(`SELECT h.*, u.name AS user_name, c.full_name AS client_name ${FROM} WHERE ${sql} ORDER BY h.at DESC, h.src, h.id DESC`).all(...p);
}

module.exports = { listHistory, exportRows, GROUPS };
