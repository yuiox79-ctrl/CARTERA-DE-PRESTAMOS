'use strict';
// Eliminación de préstamos y clientes (solo administrador).
// Lo eliminado pasa a la papelera durante 30 días: se guarda una copia completa de sus filas y se puede restaurar.
// Pasado ese plazo, o con "Eliminar definitivamente", se borra para siempre. Todo queda en la bitácora.

const { db, audit } = require('./db');
const { refreshLoanStatus } = require('./billing');
const { fmtCOP, now, today, addDays, HttpError } = require('./util');
const { putBlob, getBlob, deleteBlob } = require('./blobs');

const TRASH_DAYS = 30;

// Orden de restauración y referencias entre tablas (para reasignar números internos si ya están ocupados).
const ORDER = ['clients', 'loans', 'installments', 'schedule_versions', 'billing_mode_changes', 'invoices', 'accumulated_docs',
  'adjustments', 'payments', 'allocations', 'notes'];
const REFS = {
  loans: { client_id: 'clients' },
  installments: { loan_id: 'loans' },
  schedule_versions: { loan_id: 'loans' },
  billing_mode_changes: { loan_id: 'loans' },
  invoices: { loan_id: 'loans', client_id: 'clients', installment_id: 'installments' },
  accumulated_docs: { loan_id: 'loans', client_id: 'clients', invoice_id: 'invoices' },
  adjustments: { invoice_id: 'invoices', loan_id: 'loans', client_id: 'clients' },
  payments: { loan_id: 'loans', client_id: 'clients' },
  allocations: { payment_id: 'payments', invoice_id: 'invoices' },
  notes: { client_id: 'clients' },
};

/** Copia de todas las filas de un préstamo (y las aplicaciones que lo tocan). */
function loanBundle(loanId) {
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  return {
    loans: q('SELECT * FROM loans WHERE id = ?', loanId),
    installments: q('SELECT * FROM installments WHERE loan_id = ?', loanId),
    schedule_versions: q('SELECT * FROM schedule_versions WHERE loan_id = ?', loanId),
    billing_mode_changes: q('SELECT * FROM billing_mode_changes WHERE loan_id = ?', loanId),
    invoices: q('SELECT * FROM invoices WHERE loan_id = ?', loanId),
    accumulated_docs: q('SELECT * FROM accumulated_docs WHERE loan_id = ?', loanId),
    adjustments: q('SELECT * FROM adjustments WHERE loan_id = ?', loanId),
    payments: q('SELECT * FROM payments WHERE loan_id = ?', loanId),
    allocations: q(`SELECT * FROM allocations WHERE invoice_id IN (SELECT id FROM invoices WHERE loan_id = ?)
        OR payment_id IN (SELECT id FROM payments WHERE loan_id = ?)`, loanId, loanId),
  };
}
function merge(into, b) { for (const [t, rows] of Object.entries(b)) { into[t] = into[t] || []; for (const r of rows) if (!into[t].some((x) => x.id === r.id)) into[t].push(r); } return into; }

function toTrash(kind, label, clientName, summary, reason, userId, bundle) {
  const t = now();
  const info = db.prepare(`INSERT INTO trash(kind, label, client_name, summary, reason, deleted_at, deleted_by, expires_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(kind, label, clientName, summary, reason, t, userId, addDays(today(), TRASH_DAYS));
  putBlob('trash:' + info.lastInsertRowid, JSON.stringify(bundle));
  return info.lastInsertRowid;
}

/** Borra un préstamo y todo lo que depende de él. Devuelve un resumen. Debe ejecutarse dentro de una transacción. */
function purgeLoan(loanId) {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  const inv = 'SELECT id FROM invoices WHERE loan_id = ?';
  const pay = 'SELECT id FROM payments WHERE loan_id = ?';
  // Préstamos de otros pagos que se verán afectados (saldo a favor aplicado entre préstamos).
  const touched = db.prepare(`SELECT DISTINCT i.loan_id FROM allocations a JOIN invoices i ON i.id = a.invoice_id
      WHERE a.payment_id IN (${pay}) AND i.loan_id <> ?`).all(loanId, loanId).map((r) => r.loan_id);
  const summary = {
    numero: loan.number,
    capital: loan.principal,
    facturas: db.prepare('SELECT COUNT(*) n FROM invoices WHERE loan_id = ?').get(loanId).n,
    pagos: db.prepare('SELECT COUNT(*) n FROM payments WHERE loan_id = ?').get(loanId).n,
    recibido: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE loan_id = ? AND status = 'activo'").get(loanId).s,
  };
  db.prepare(`DELETE FROM allocations WHERE invoice_id IN (${inv}) OR payment_id IN (${pay})`).run(loanId, loanId);
  db.prepare('DELETE FROM adjustments WHERE loan_id = ?').run(loanId);
  db.prepare('DELETE FROM accumulated_docs WHERE loan_id = ?').run(loanId);
  db.prepare('DELETE FROM invoices WHERE loan_id = ?').run(loanId);
  db.prepare('DELETE FROM payments WHERE loan_id = ?').run(loanId);
  db.prepare('DELETE FROM installments WHERE loan_id = ?').run(loanId);
  db.prepare('DELETE FROM schedule_versions WHERE loan_id = ?').run(loanId);
  db.prepare('DELETE FROM billing_mode_changes WHERE loan_id = ?').run(loanId);
  db.prepare('DELETE FROM loans WHERE id = ?').run(loanId);
  for (const id of touched) refreshLoanStatus(id);
  return summary;
}

function describe(s) {
  return `${s.numero}: capital ${fmtCOP(s.capital)}, ${s.facturas} factura(s), ${s.pagos} pago(s) por ${fmtCOP(s.recibido)}`;
}

function deleteLoan(loanId, userId, reason) {
  return db.transaction(() => {
    const loan = db.prepare('SELECT l.client_id, c.full_name FROM loans l JOIN clients c ON c.id = l.client_id WHERE l.id = ?').get(loanId);
    const bundle = loanBundle(loanId);
    const s = purgeLoan(loanId);
    const trashId = toTrash('prestamo', s.numero, loan.full_name, describe(s), reason, userId, bundle);
    audit(userId, { clientId: loan.client_id, entity: 'prestamo', entityId: loanId, action: 'eliminar', summary: `Préstamo enviado a la papelera (${describe(s)}). Motivo: ${reason}`, detail: s });
    return { ...s, trash_id: trashId };
  })();
}

function deleteClient(clientId, userId, reason) {
  return db.transaction(() => {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
    const bundle = { clients: [c], notes: db.prepare('SELECT * FROM notes WHERE client_id = ?').all(clientId) };
    for (const r of db.prepare('SELECT id FROM loans WHERE client_id = ?').all(clientId)) merge(bundle, loanBundle(r.id));
    merge(bundle, { payments: db.prepare('SELECT * FROM payments WHERE client_id = ?').all(clientId) });
    merge(bundle, { allocations: db.prepare('SELECT * FROM allocations WHERE payment_id IN (SELECT id FROM payments WHERE client_id = ?)').all(clientId) });
    const loans = db.prepare('SELECT id FROM loans WHERE client_id = ?').all(clientId).map((r) => purgeLoan(r.id));
    // Pagos o aplicaciones sueltas que pudieran quedar del cliente.
    db.prepare('DELETE FROM allocations WHERE payment_id IN (SELECT id FROM payments WHERE client_id = ?)').run(clientId);
    db.prepare('DELETE FROM payments WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM notes WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
    audit(userId, {
      entity: 'cliente', entityId: clientId, action: 'eliminar',
      summary: `Cliente ${c.code} (${c.full_name}, ${c.id_type} ${c.id_number}) enviado a la papelera con ${loans.length} préstamo(s)${loans.length ? ': ' + loans.map(describe).join('; ') : ''}. Motivo: ${reason}`,
      detail: { cliente: c, prestamos: loans },
    });
    const trashId = toTrash('cliente', `${c.code} · ${c.full_name}`, c.full_name,
      `${loans.length} préstamo(s)${loans.length ? ': ' + loans.map(describe).join('; ') : ''}`, reason, userId, bundle);
    return { loans: loans.length, trash_id: trashId };
  })();
}

// ===== Papelera =====
function listTrash() {
  return db.prepare('SELECT t.*, u.name AS user_name FROM trash t LEFT JOIN users u ON u.id = t.deleted_by ORDER BY t.id DESC').all()
    .map((t) => ({ ...t, days_left: Math.max(0, Math.round((Date.parse(t.expires_at) - Date.parse(today())) / 86400000)) }));
}

function getTrash(id) {
  const t = db.prepare('SELECT * FROM trash WHERE id = ?').get(Number(id));
  if (!t) throw new HttpError(404, 'El elemento ya no está en la papelera.');
  return t;
}

/** Restaura lo eliminado. Si algún número interno ya fue ocupado por un registro nuevo, se le asigna otro. */
function restoreTrash(id, userId) {
  const t = getTrash(id);
  const bundle = JSON.parse(getBlob('trash:' + t.id) || '{}');
  return db.transaction(() => {
    const map = {};
    const counts = {};
    for (const table of ORDER) {
      const rows = bundle[table] || [];
      map[table] = new Map();
      const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      let next = (db.prepare(`SELECT COALESCE(MAX(id), 0) m FROM ${table}`).get().m) + 1;
      counts[table] = 0;
      for (const original of rows) {
        const r = { ...original };
        let skip = false;
        for (const [col, ref] of Object.entries(REFS[table] || {})) {
          if (r[col] == null) continue;
          if (map[ref] && map[ref].has(r[col])) r[col] = map[ref].get(r[col]);
          else if (!db.prepare(`SELECT 1 FROM ${ref} WHERE id = ?`).get(r[col])) {
            if (table === 'loans') throw new HttpError(409, 'El cliente de este préstamo ya no existe. Restaure primero el cliente desde la papelera.');
            skip = true; // referencia a algo que ya no existe (p. ej., un pago de otro préstamo eliminado)
          }
        }
        if (skip) continue;
        if (table === 'clients') {
          const dup = db.prepare('SELECT code, full_name FROM clients WHERE id_number = ?').get(r.id_number);
          if (dup) throw new HttpError(409, `No se puede restaurar: la identificación ${r.id_number} ya pertenece a ${dup.full_name} (${dup.code}).`);
        }
        const oldId = r.id;
        if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(r.id)) r.id = next++;
        else next = Math.max(next, r.id + 1);
        map[table].set(oldId, r.id);
        const keys = Object.keys(r).filter((k) => cols.has(k));
        db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => r[k]));
        counts[table]++;
      }
    }
    for (const l of bundle.loans || []) refreshLoanStatus(map.loans.get(l.id));
    const clientId = (bundle.clients && bundle.clients[0] && map.clients.get(bundle.clients[0].id)) || (bundle.loans && bundle.loans[0] && map.loans.size ? db.prepare('SELECT client_id FROM loans WHERE id = ?').get(map.loans.get(bundle.loans[0].id)).client_id : null);
    deleteBlob('trash:' + t.id);
    db.prepare('DELETE FROM trash WHERE id = ?').run(t.id);
    audit(userId, { clientId, entity: t.kind === 'cliente' ? 'cliente' : 'prestamo', action: 'restaurar', summary: `${t.kind === 'cliente' ? 'Cliente' : 'Préstamo'} ${t.label} restaurado desde la papelera (${counts.loans || 0} préstamo(s), ${counts.payments || 0} pago(s))` });
    return { kind: t.kind, client_id: clientId, loan_id: map.loans && bundle.loans && bundle.loans[0] ? map.loans.get(bundle.loans[0].id) : null, counts };
  })();
}

function deleteTrashForever(id, userId, auto = false) {
  const t = getTrash(id);
  db.transaction(() => {
    deleteBlob('trash:' + t.id);
    db.prepare('DELETE FROM trash WHERE id = ?').run(t.id);
    audit(userId, { entity: 'papelera', entityId: t.id, action: 'vaciar', summary: `${t.kind === 'cliente' ? 'Cliente' : 'Préstamo'} ${t.label} eliminado definitivamente de la papelera${auto ? ' (cumplió 30 días)' : ''}` });
  })();
}

/** Borra para siempre lo que lleva más de 30 días en la papelera. */
function purgeExpiredTrash() {
  const expired = db.prepare('SELECT id FROM trash WHERE expires_at < ?').all(today());
  for (const t of expired) deleteTrashForever(t.id, null, true);
  return expired.length;
}

module.exports = { deleteLoan, deleteClient, listTrash, restoreTrash, deleteTrashForever, purgeExpiredTrash, TRASH_DAYS };
