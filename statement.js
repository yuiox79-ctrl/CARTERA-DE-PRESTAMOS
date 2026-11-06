'use strict';
// Estado de cuenta del cliente: obligaciones, facturas originales, documentos acumulados (solo consulta),
// pagos, abonos por factura, ajustes, reversiones y movimientos cronológicos con saldo corrido.

const { db, getSettings } = require('./db');
const { today } = require('./util');

function buildStatement(clientId, { loanId = null, from = null, to = null, status = null } = {}) {
  const client = db.prepare('SELECT * FROM v_client WHERE id = ?').get(clientId);
  const lf = loanId ? ' AND loan_id = ' + Number(loanId) : '';

  const loans = db.prepare(`SELECT * FROM v_loan WHERE client_id = ? ${loanId ? 'AND id = ?' : ''} ORDER BY disbursed_at, id`)
    .all(...(loanId ? [clientId, loanId] : [clientId]));
  for (const l of loans) {
    l.installments = db.prepare('SELECT * FROM v_installment WHERE loan_id = ? AND active = 1 ORDER BY number').all(l.id);
  }

  let invoices = db.prepare(`SELECT v.*, l.number AS loan_number FROM v_invoice v JOIN loans l ON l.id = v.loan_id
      WHERE v.client_id = ? ${lf.replace('loan_id', 'v.loan_id')} ORDER BY v.due_date, v.id`).all(clientId);
  if (status) invoices = invoices.filter((i) => i.computed_status === status);
  if (from) invoices = invoices.filter((i) => i.due_date >= from || i.issue_date >= from);
  if (to) invoices = invoices.filter((i) => i.issue_date <= to);

  const accumulated = db.prepare(`SELECT d.*, l.number AS loan_number FROM accumulated_docs d JOIN loans l ON l.id = d.loan_id
      WHERE d.client_id = ? ${lf.replace('loan_id', 'd.loan_id')} ORDER BY d.id`).all(clientId);

  const payments = db.prepare(`SELECT p.*, l.number AS loan_number FROM v_payment p JOIN loans l ON l.id = p.loan_id
      WHERE p.client_id = ? ${lf.replace('loan_id', 'p.loan_id')} ORDER BY p.paid_at, p.id`).all(clientId);
  const allocs = db.prepare(`SELECT a.*, i.number AS invoice_number, i.loan_id FROM allocations a JOIN invoices i ON i.id = a.invoice_id
      WHERE i.client_id = ? ${lf.replace('loan_id', 'i.loan_id')} ORDER BY a.created_at, a.id`).all(clientId);
  for (const p of payments) p.allocations = allocs.filter((a) => a.payment_id === p.id);

  const adjustments = db.prepare(`SELECT a.*, i.number AS invoice_number FROM adjustments a JOIN invoices i ON i.id = a.invoice_id
      WHERE a.client_id = ? ${lf.replace('loan_id', 'a.loan_id')} ORDER BY a.created_at`).all(clientId);

  // ---- Movimientos cronológicos (saldo de facturas) ----
  const allInv = db.prepare(`SELECT * FROM invoices WHERE client_id = ? ${lf} ORDER BY issue_date, id`).all(clientId);
  const ev = [];
  for (const i of allInv) {
    ev.push({ date: i.issue_date, order: 1, type: 'Factura', doc: i.number, description: `${i.concept} · ${i.period_label}`, debit: i.total, credit: 0 });
    if (i.status === 'anulada') {
      const adj = adjustments.filter((a) => a.invoice_id === i.id).reduce((s, a) => s + a.amount, 0);
      ev.push({ date: (i.annulled_at || '').slice(0, 10), order: 4, type: 'Anulación', doc: i.number, description: `Factura anulada: ${i.annul_reason || ''}`, debit: 0, credit: i.total + adj });
    }
  }
  for (const a of adjustments) {
    ev.push({ date: a.created_at.slice(0, 10), order: 2, type: 'Ajuste autorizado', doc: a.invoice_number, description: a.reason, debit: a.amount > 0 ? a.amount : 0, credit: a.amount < 0 ? -a.amount : 0 });
  }
  for (const p of payments) {
    const fromPay = p.allocations.filter((a) => a.source === 'pago');
    const applied = fromPay.reduce((s, a) => s + a.amount, 0);
    const excess = p.amount - applied;
    ev.push({
      date: p.paid_at.slice(0, 10), order: 3, type: 'Pago', doc: p.receipt_number,
      description: `Pago ${p.method}${fromPay.length ? ' aplicado a ' + fromPay.map((a) => a.invoice_number).join(', ') : ''}${excess > 0 ? ` · excedente ${excess} como saldo a favor` : ''}${p.status === 'reversado' ? ' (REVERSADO)' : ''}`,
      debit: 0, credit: applied, received: p.amount,
    });
    for (const a of p.allocations.filter((x) => x.source === 'saldo_favor')) {
      ev.push({ date: a.created_at.slice(0, 10), order: 3, type: 'Aplicación saldo a favor', doc: p.receipt_number, description: `Aplicado a ${a.invoice_number}`, debit: 0, credit: a.amount });
    }
    if (p.status === 'reversado') {
      const rev = p.allocations.reduce((s, a) => s + a.amount, 0);
      ev.push({ date: (p.reversed_at || '').slice(0, 10), order: 5, type: 'Reversión de pago', doc: p.receipt_number, description: p.reversal_reason || '', debit: rev, credit: 0 });
    }
  }
  ev.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  let running = 0, opening = 0;
  const movements = [];
  for (const e of ev) {
    running += e.debit - e.credit;
    e.balance = running;
    if (from && e.date < from) { opening = running; continue; }
    if (to && e.date > to) continue;
    movements.push(e);
  }

  const totals = {
    principal: loans.filter((l) => l.status !== 'anulado').reduce((s, l) => s + l.principal, 0),
    contract: loans.filter((l) => l.status !== 'anulado').reduce((s, l) => s + l.contract_due, 0),
    paid: loans.reduce((s, l) => s + l.paid_total, 0),
    contract_balance: loans.reduce((s, l) => s + l.contract_balance, 0),
    invoice_balance: loans.reduce((s, l) => s + l.invoice_balance, 0),
    overdue: loans.reduce((s, l) => s + l.overdue_balance, 0),
    received: payments.filter((p) => p.status === 'activo').reduce((s, p) => s + p.amount, 0),
    credit_balance: payments.reduce((s, p) => s + p.unapplied, 0),
    overdue_installments: loans.reduce((s, l) => s + l.installments.filter((i) => ['vencida', 'sin_factura_vencida'].includes(i.computed_status)).length, 0),
    max_days_late: Math.max(0, ...loans.map((l) => l.max_days_late || 0)),
    last_payment_at: payments.filter((p) => p.status === 'activo').map((p) => p.paid_at).sort().pop() || null,
    next_due_date: loans.filter((l) => l.status === 'activo').map((l) => l.next_due_date).filter(Boolean).sort()[0] || null,
  };

  return { generated_at: today(), business: getSettings(), filters: { loanId, from, to, status }, client, loans, invoices, accumulated, payments, adjustments, movements, opening, totals };
}

module.exports = { buildStatement };
