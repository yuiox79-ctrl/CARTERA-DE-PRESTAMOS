'use strict';
// Facturación automática vinculada al calendario de cada préstamo.
// Se ejecuta en el servidor (no depende de que la página esté abierta).

const { db, setting, nextNumber, audit, syncToday } = require('./db');
const { today, now, addDays, monthLabel, fmtCOP, fmtDate } = require('./util');

/** Emite la factura de una cuota. Si ya existe una vigente, devuelve null (protección contra duplicados). */
function issueInvoiceForInstallment(inst, { generatedBy = 'automatico', userId = null, issueDate = null } = {}) {
  const exists = db.prepare("SELECT id FROM invoices WHERE installment_id = ? AND status <> 'anulada'").get(inst.id);
  if (exists) return null;
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(inst.loan_id);
  if (!loan || loan.status === 'anulado') return null;

  const lead = Number(setting('invoice_lead_days')) || 0;
  let issue = issueDate || addDays(inst.due_date, -lead);
  if (issue < loan.disbursed_at) issue = loan.disbursed_at;
  if (issue > today()) issue = today();
  const period_month = inst.due_date.slice(0, 7);
  const totalInst = db.prepare('SELECT COUNT(*) n FROM installments WHERE loan_id = ? AND active = 1').get(loan.id).n;
  const period_label = `Cuota ${inst.number}/${totalInst} · ${monthLabel(period_month)}`;
  const number = nextNumber('invoice', 'invoice_prefix');
  const info = db.prepare(`INSERT INTO invoices(number, loan_id, client_id, installment_id, period_month, period_label, issue_date,
      due_date, concept, installment_amount, other_amount, total, billing_mode, generated_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`)
    .run(number, loan.id, loan.client_id, inst.id, period_month, period_label, issue, inst.due_date,
      `Cuota ${inst.number} del préstamo ${loan.number}`, inst.amount, inst.amount, loan.billing_mode, generatedBy, now());
  const invoiceId = info.lastInsertRowid;
  audit(userId, {
    clientId: loan.client_id, entity: 'factura', entityId: invoiceId, action: 'emitir',
    summary: `Factura ${number} emitida (${generatedBy === 'automatico' ? 'automática' : 'manual'}) por ${fmtCOP(inst.amount)}, vence ${fmtDate(inst.due_date)}`,
  });
  let doc = null;
  if (loan.billing_mode === 'acumulada') doc = createAccumulatedDoc(loan, invoiceId, issue);
  return { invoiceId, number, doc };
}

/**
 * Documento acumulado: resumen del saldo (saldo anterior + nueva cuota − abonos).
 * Es solo de consulta: no crea deuda; la deuda real vive en las facturas originales.
 */
function createAccumulatedDoc(loan, invoiceId, issueDate) {
  const inv = db.prepare('SELECT * FROM v_invoice WHERE id = ?').get(invoiceId);
  const prevDoc = db.prepare('SELECT * FROM accumulated_docs WHERE loan_id = ? ORDER BY id DESC LIMIT 1').get(loan.id);
  const previous = db.prepare(`SELECT id, number, period_label, due_date, amount_due, paid, balance, computed_status
      FROM v_invoice WHERE loan_id = ? AND status <> 'anulada' AND id <> ? AND due_date <= ? AND balance > 0 ORDER BY due_date`)
    .all(loan.id, invoiceId, inv.due_date);
  const prev_balance = previous.reduce((a, r) => a + r.balance, 0);
  let payments_since = 0;
  if (prevDoc) {
    payments_since = db.prepare(`SELECT COALESCE(SUM(a.amount),0) s FROM allocations a JOIN invoices i ON i.id = a.invoice_id
        WHERE i.loan_id = ? AND a.active = 1 AND a.created_at > ?`).get(loan.id, prevDoc.created_at).s;
  }
  const total_due = prev_balance + inv.balance;
  const number = nextNumber('accumulated', 'acc_prefix');
  const detail = { previous, new_invoice: { id: inv.id, number: inv.number, period_label: inv.period_label, due_date: inv.due_date, amount: inv.amount_due } };
  const r = db.prepare(`INSERT INTO accumulated_docs(number, loan_id, client_id, invoice_id, period_month, issue_date, prev_doc_total,
      payments_since, prev_balance, new_installment, total_due, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(number, loan.id, loan.client_id, invoiceId, inv.period_month, issueDate, prevDoc ? prevDoc.total_due : 0,
      payments_since, prev_balance, inv.balance, total_due, JSON.stringify(detail), now());
  return { id: r.lastInsertRowid, number };
}

/** Marca como pagado (cancelado) un préstamo sin saldo contractual, o lo reactiva si vuelve a tener saldo. */
// Saldo contractual calculado directamente sobre las tablas (rápido; misma fórmula que la vista v_loan).
const BALANCE_SQL = `SELECT l.id, l.status, l.client_id, l.number,
    l.total_contract
    + COALESCE((SELECT SUM(i.other_amount) FROM invoices i WHERE i.loan_id = l.id AND i.status <> 'anulada'), 0)
    + COALESCE((SELECT SUM(a.amount) FROM adjustments a JOIN invoices i ON i.id = a.invoice_id WHERE a.loan_id = l.id AND i.status <> 'anulada'), 0)
    - COALESCE((SELECT SUM(al.amount) FROM allocations al JOIN invoices i ON i.id = al.invoice_id WHERE i.loan_id = l.id AND al.active = 1), 0)
    AS contract_balance
  FROM loans l`;

function applyStatus(l, userId) {
  if (!l || l.status === 'anulado') return false;
  if (l.status === 'activo' && l.contract_balance <= 0) {
    db.prepare("UPDATE loans SET status = 'pagado', closed_at = ? WHERE id = ?").run(now(), l.id);
    audit(userId, { clientId: l.client_id, entity: 'prestamo', entityId: l.id, action: 'cancelar', summary: `Préstamo ${l.number} cancelado: saldo contractual en cero` });
    return true;
  }
  if (l.status === 'pagado' && l.contract_balance > 0) {
    db.prepare("UPDATE loans SET status = 'activo', closed_at = NULL WHERE id = ?").run(l.id);
    audit(userId, { clientId: l.client_id, entity: 'prestamo', entityId: l.id, action: 'reactivar', summary: `Préstamo ${l.number} reactivado: volvió a tener saldo pendiente` });
  }
  return false;
}

/** Marca como pagado (cancelado) un préstamo sin saldo contractual, o lo reactiva si vuelve a tener saldo. */
function refreshLoanStatus(loanId, userId = null) {
  return applyStatus(db.prepare(`${BALANCE_SQL} WHERE l.id = ?`).get(loanId), userId);
}

/** Revisa todos los préstamos activos en una sola consulta y cierra los que ya no tienen saldo. */
function closePaidLoans(userId = null) {
  let closed = 0;
  for (const l of db.prepare(`SELECT * FROM (${BALANCE_SQL} WHERE l.status = 'activo') WHERE contract_balance <= 0`).all()) {
    if (applyStatus(l, userId)) closed++;
  }
  return closed;
}

/** Instalaciones (cuotas) cuya factura corresponde emitir a la fecha indicada. */
function dueToInvoice(asOf, loanId = null) {
  const lead = Number(setting('invoice_lead_days')) || 0;
  const limit = addDays(asOf, lead);
  return db.prepare(`SELECT s.* FROM installments s JOIN loans l ON l.id = s.loan_id
      WHERE s.active = 1 AND l.status = 'activo' AND s.due_date <= ? ${loanId ? 'AND l.id = ?' : ''}
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.installment_id = s.id AND i.status <> 'anulada')
      ORDER BY s.loan_id, s.due_date`).all(...(loanId ? [limit, loanId] : [limit]));
}

let running = false;
/** Proceso programado: emite las facturas que correspondan. Idempotente. */
function runBillingJob(trigger = 'programado', userId = null) {
  if (running) return { skipped: true };
  syncToday();
  running = true;
  const started = now();
  const run = db.prepare('INSERT INTO job_runs(started_at, trigger) VALUES (?, ?)').run(started, trigger);
  let created = 0, docs = 0, closed = 0;
  try {
    const tx = db.transaction(() => {
      for (const inst of dueToInvoice(today())) {
        const r = issueInvoiceForInstallment(inst, { generatedBy: 'automatico', userId });
        if (r) { created++; if (r.doc) docs++; }
      }
      closed = closePaidLoans(userId);
    });
    tx();
    db.prepare('UPDATE job_runs SET finished_at = ?, invoices_created = ?, docs_created = ?, loans_closed = ?, message = ? WHERE id = ?')
      .run(now(), created, docs, closed, 'OK', run.lastInsertRowid);
    // Mantenimiento: copia automática cada 3 días y limpieza de la papelera (fuera de la transacción de facturación).
    try {
      require('./backup').maybeAutoBackup();
      require('./purge').purgeExpiredTrash();
    } catch (e) { console.error('[mantenimiento]', e.message); }
    return { invoices_created: created, docs_created: docs, loans_closed: closed };
  } catch (e) {
    db.prepare('UPDATE job_runs SET finished_at = ?, message = ? WHERE id = ?').run(now(), 'Error: ' + e.message, run.lastInsertRowid);
    throw e;
  } finally {
    running = false;
  }
}

/** Inicia el programador: ejecuta al arrancar y luego cada hora (detecta cambio de día). */
function startScheduler(afterRun = null) {
  const tick = (trigger) => {
    try {
      const r = runBillingJob(trigger);
      if (afterRun) afterRun();
      if (r.invoices_created) console.log(`[facturación] ${r.invoices_created} factura(s) emitida(s), ${r.docs_created} documento(s) acumulado(s).`);
    } catch (e) { console.error('[facturación] Error:', e); }
  };
  tick('inicio');
  const interval = Number(process.env.JOB_INTERVAL_MS) || 60 * 60 * 1000;
  return setInterval(() => tick('programado'), interval);
}

module.exports = { issueInvoiceForInstallment, createAccumulatedDoc, refreshLoanStatus, runBillingJob, startScheduler, dueToInvoice };
