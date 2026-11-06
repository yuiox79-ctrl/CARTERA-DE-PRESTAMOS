'use strict';
// Base de datos SQLite: esquema, vistas de cálculo y numeración consecutiva.
// Todos los valores monetarios se guardan como enteros en pesos colombianos (COP).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { today, now } = require('./util');

// Con DATABASE_URL (Supabase/PostgreSQL) los datos viven en PostgreSQL y SQLite trabaja en memoria.
const DB_PATH = process.env.DB_PATH || (process.env.DATABASE_URL ? ':memory:' : path.join(__dirname, '..', 'data', 'cartera.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Fecha de hoy para las vistas (vencida, próxima a vencer, mora). Se guarda en una tabla de una fila y las vistas
// la leen con una subconsulta que SQLite evalúa una sola vez por consulta (antes era una función llamada por cada fila).
db.function('hoy', { deterministic: false }, () => today()); // compatibilidad
db.exec("CREATE TABLE IF NOT EXISTS _today (id INTEGER PRIMARY KEY CHECK (id = 1), d TEXT NOT NULL); INSERT OR IGNORE INTO _today(id, d) VALUES (1, '1970-01-01');");
let todayCached = null;
/** Actualiza la fecha de las vistas si cambió (se llama al inicio de cada solicitud y de cada proceso). */
function syncToday() {
  const t = today();
  if (t !== todayCached) { db.prepare('UPDATE _today SET d = ? WHERE id = 1').run(t); todayCached = t; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operador')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  id_type TEXT NOT NULL DEFAULT 'CC',
  id_number TEXT NOT NULL UNIQUE,
  phone TEXT,
  address TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','inactivo')),
  observations TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  disbursed_at TEXT NOT NULL,
  principal INTEGER NOT NULL CHECK (principal > 0),
  interest_mode TEXT NOT NULL CHECK (interest_mode IN ('sin_interes','simple_total','simple_mensual','cuota_fija','manual')),
  interest_rate REAL,
  total_contract INTEGER NOT NULL,
  installments_count INTEGER NOT NULL CHECK (installments_count > 0),
  installment_amount INTEGER NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('diaria','semanal','quincenal','mensual','personalizada')),
  custom_days INTEGER,
  start_date TEXT NOT NULL,
  first_due_date TEXT NOT NULL,
  payment_day INTEGER,
  day_rule TEXT NOT NULL DEFAULT 'ultimo_dia',
  end_date TEXT NOT NULL,
  billing_mode TEXT NOT NULL DEFAULT 'normal' CHECK (billing_mode IN ('normal','acumulada')),
  allow_prepayment INTEGER NOT NULL DEFAULT 1,
  implied_ea REAL,
  status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','pagado','anulado')),
  observations TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  annul_reason TEXT,
  annulled_at TEXT,
  annulled_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS ix_loans_client ON loans(client_id);

CREATE TABLE IF NOT EXISTS installments (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_inst_loan ON installments(loan_id, active, due_date);

CREATE TABLE IF NOT EXISTS schedule_versions (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  version INTEGER NOT NULL,
  reason TEXT,
  snapshot TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_mode_changes (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  from_mode TEXT NOT NULL,
  to_mode TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Documento interno de cobro. Cada cuota del calendario tiene como máximo una factura vigente.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  installment_id INTEGER NOT NULL REFERENCES installments(id),
  period_month TEXT NOT NULL,
  period_label TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  concept TEXT NOT NULL,
  installment_amount INTEGER NOT NULL,
  other_amount INTEGER NOT NULL DEFAULT 0,
  other_concept TEXT,
  total INTEGER NOT NULL,
  billing_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'emitida' CHECK (status IN ('emitida','anulada')),
  generated_by TEXT NOT NULL,
  annul_reason TEXT,
  annulled_at TEXT,
  annulled_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
-- Protección contra duplicados: una sola factura vigente por cuota (préstamo + periodo).
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoice_installment ON invoices(installment_id) WHERE status <> 'anulada';
CREATE INDEX IF NOT EXISTS ix_inv_loan ON invoices(loan_id);
CREATE INDEX IF NOT EXISTS ix_inv_client ON invoices(client_id);
CREATE INDEX IF NOT EXISTS ix_inv_issue ON invoices(issue_date);

-- Documento acumulado: solo de consulta, NO crea deuda nueva.
CREATE TABLE IF NOT EXISTS accumulated_docs (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  period_month TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  prev_doc_total INTEGER NOT NULL DEFAULT 0,
  payments_since INTEGER NOT NULL DEFAULT 0,
  prev_balance INTEGER NOT NULL,
  new_installment INTEGER NOT NULL,
  total_due INTEGER NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_acc_invoice ON accumulated_docs(invoice_id);

-- Ajustes autorizados sobre una factura (descuentos, correcciones). Negativo reduce el cobro.
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- Cada dinero recibido se registra UNA sola vez aquí.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  paid_at TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  reference TEXT,
  received_by TEXT NOT NULL,
  distribution_mode TEXT NOT NULL,
  observations TEXT,
  balance_before INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','reversado')),
  reversal_reason TEXT,
  reversed_at TEXT,
  reversed_by INTEGER REFERENCES users(id),
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pay_client ON payments(client_id);
CREATE INDEX IF NOT EXISTS ix_pay_loan ON payments(loan_id);
CREATE INDEX IF NOT EXISTS ix_pay_date ON payments(paid_at);

-- Distribución de cada pago entre facturas (almacenada por separado).
CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  source TEXT NOT NULL DEFAULT 'pago' CHECK (source IN ('pago','saldo_favor')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  reversed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_alloc_inv ON allocations(invoice_id, active);
CREATE INDEX IF NOT EXISTS ix_alloc_pay ON allocations(payment_id);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL DEFAULT 'nota' CHECK (kind IN ('nota','recordatorio','gestion')),
  text TEXT NOT NULL,
  remind_date TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  client_id INTEGER,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_client ON audit_log(client_id);

-- Copias de seguridad internas (automáticas cada 3 días, manuales y previas a una restauración).
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_id INTEGER,
  clients INTEGER NOT NULL DEFAULT 0,
  loans INTEGER NOT NULL DEFAULT 0,
  payments INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0
);

-- Papelera: préstamos y clientes eliminados, recuperables durante 30 días.
CREATE TABLE IF NOT EXISTS trash (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('prestamo','cliente')),
  label TEXT NOT NULL,
  client_name TEXT,
  summary TEXT,
  reason TEXT,
  deleted_at TEXT NOT NULL,
  deleted_by INTEGER,
  expires_at TEXT NOT NULL
);

-- Contenido grande (copias y papelera) partido en trozos para que cada fila sea pequeña.
CREATE TABLE IF NOT EXISTS blob_chunks (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_blob_owner ON blob_chunks(owner, seq);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL,
  invoices_created INTEGER NOT NULL DEFAULT 0,
  docs_created INTEGER NOT NULL DEFAULT 0,
  loans_closed INTEGER NOT NULL DEFAULT 0,
  message TEXT
);

-- Índices adicionales para consultas frecuentes
CREATE INDEX IF NOT EXISTS ix_adj_invoice ON adjustments(invoice_id);
CREATE INDEX IF NOT EXISTS ix_adj_loan ON adjustments(loan_id);
CREATE INDEX IF NOT EXISTS ix_acc_loan ON accumulated_docs(loan_id);
CREATE INDEX IF NOT EXISTS ix_notes_client ON notes(client_id);
CREATE INDEX IF NOT EXISTS ix_sv_loan ON schedule_versions(loan_id);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS ix_inv_due ON invoices(due_date);
CREATE INDEX IF NOT EXISTS ix_inv_inst ON invoices(installment_id);
CREATE INDEX IF NOT EXISTS ix_pay_status ON payments(status, paid_at);

-- ===== Vistas de cálculo (siempre desde los registros reales) =====
DROP VIEW IF EXISTS v_client;
DROP VIEW IF EXISTS v_client_bulk;
DROP VIEW IF EXISTS v_loan_bulk;
DROP VIEW IF EXISTS v_inv_flat;
DROP VIEW IF EXISTS v_loan;
DROP VIEW IF EXISTS v_loan_base;
DROP VIEW IF EXISTS v_installment;
DROP VIEW IF EXISTS v_invoice;
DROP VIEW IF EXISTS v_invoice_base;
DROP VIEW IF EXISTS v_payment;

CREATE VIEW v_invoice_base AS
SELECT i.*,
  COALESCE((SELECT SUM(a.amount) FROM adjustments a WHERE a.invoice_id = i.id), 0) AS adj_total,
  COALESCE((SELECT SUM(al.amount) FROM allocations al WHERE al.invoice_id = i.id AND al.active = 1), 0) AS paid
FROM invoices i;

CREATE VIEW v_invoice AS
SELECT b.*,
  (b.total + b.adj_total) AS amount_due,
  CASE WHEN b.status = 'anulada' THEN 0 ELSE MAX(b.total + b.adj_total - b.paid, 0) END AS balance,
  CASE
    WHEN b.status = 'anulada' THEN 'anulada'
    WHEN b.paid >= b.total + b.adj_total THEN 'pagada'
    WHEN b.due_date < (SELECT d FROM _today) THEN 'vencida'
    WHEN b.paid > 0 THEN 'parcial'
    WHEN julianday(b.due_date) - julianday((SELECT d FROM _today)) <= CAST((SELECT value FROM settings WHERE key = 'due_soon_days') AS INTEGER) THEN 'proxima'
    ELSE 'pendiente'
  END AS computed_status,
  CASE WHEN b.status <> 'anulada' AND b.paid < b.total + b.adj_total AND b.due_date < (SELECT d FROM _today)
       THEN CAST(julianday((SELECT d FROM _today)) - julianday(b.due_date) AS INTEGER) ELSE 0 END AS days_late
FROM v_invoice_base b;

CREATE VIEW v_installment AS
SELECT s.*,
  vi.id AS invoice_id, vi.number AS invoice_number, vi.amount_due AS invoice_amount,
  COALESCE(vi.paid, 0) AS paid,
  CASE WHEN vi.id IS NULL THEN s.amount ELSE vi.balance END AS balance,
  CASE WHEN vi.id IS NULL THEN
         CASE WHEN s.due_date < (SELECT d FROM _today) THEN 'sin_factura_vencida' ELSE 'programada' END
       ELSE vi.computed_status END AS computed_status,
  CASE WHEN vi.id IS NULL THEN
         CASE WHEN s.due_date < (SELECT d FROM _today) THEN CAST(julianday((SELECT d FROM _today)) - julianday(s.due_date) AS INTEGER) ELSE 0 END
       ELSE vi.days_late END AS days_late
FROM installments s
LEFT JOIN v_invoice vi ON vi.installment_id = s.id AND vi.status <> 'anulada';

-- Totales por préstamo con subconsultas correlacionadas: consultar un préstamo o un cliente solo recorre sus
-- propias facturas (con índices), en lugar de recalcular la cartera completa.
CREATE VIEW v_loan_base AS
SELECT l.*,
  c.full_name AS client_name, c.code AS client_code,
  COALESCE((SELECT SUM(i.other_amount) FROM invoices i WHERE i.loan_id = l.id AND i.status <> 'anulada'), 0) AS other_total,
  COALESCE((SELECT SUM(a.amount) FROM adjustments a JOIN invoices i ON i.id = a.invoice_id WHERE a.loan_id = l.id AND i.status <> 'anulada'), 0) AS adj_total,
  COALESCE((SELECT SUM(al.amount) FROM allocations al JOIN invoices i ON i.id = al.invoice_id WHERE i.loan_id = l.id AND al.active = 1), 0) AS paid_total
FROM loans l
JOIN clients c ON c.id = l.client_id;

CREATE VIEW v_loan AS
SELECT b.*,
  (b.total_contract + b.other_total + b.adj_total) AS contract_due,
  CASE WHEN b.status = 'anulado' THEN 0 ELSE MAX(b.total_contract + b.other_total + b.adj_total - b.paid_total, 0) END AS contract_balance,
  CASE WHEN b.status = 'anulado' THEN 0 ELSE
    COALESCE((SELECT SUM(v.balance) FROM v_invoice v WHERE v.loan_id = b.id), 0) END AS invoice_balance,
  CASE WHEN b.status = 'anulado' THEN 0 ELSE
    COALESCE((SELECT SUM(v.balance) FROM v_invoice v WHERE v.loan_id = b.id AND v.computed_status = 'vencida'), 0) END AS overdue_balance,
  (SELECT COUNT(*) FROM v_invoice v WHERE v.loan_id = b.id AND v.computed_status IN ('pendiente','proxima','parcial','vencida')) AS invoices_pending,
  (SELECT COUNT(*) FROM v_invoice v WHERE v.loan_id = b.id AND v.computed_status = 'vencida') AS invoices_overdue,
  COALESCE((SELECT MAX(v.days_late) FROM v_invoice v WHERE v.loan_id = b.id), 0) AS max_days_late,
  COALESCE((SELECT SUM(v.amount_due) FROM v_invoice v WHERE v.loan_id = b.id AND v.status <> 'anulada'), 0) AS invoiced_total,
  (SELECT MIN(vs.due_date) FROM v_installment vs WHERE vs.loan_id = b.id AND vs.active = 1 AND vs.balance > 0 AND vs.due_date >= (SELECT d FROM _today)) AS next_due_date,
  (SELECT MAX(p.paid_at) FROM payments p WHERE p.loan_id = b.id AND p.status = 'activo') AS last_payment_at,
  COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.loan_id = b.id AND p.status = 'activo'), 0) AS received_total
FROM v_loan_base b;

-- ===== Versiones "en bloque" para listados completos (directorio, lista de préstamos, exportaciones) =====
-- Calculan todo en una sola pasada agrupada, más rápido cuando se necesitan todos los registros a la vez.
CREATE VIEW v_inv_flat AS
SELECT i.id, i.number, i.loan_id, i.client_id, i.status, i.due_date, i.issue_date, i.period_month, i.other_amount,
  CASE
    WHEN i.status = 'anulada' THEN 'anulada'
    WHEN COALESCE(pa.s, 0) >= i.total + COALESCE(ad.s, 0) THEN 'pagada'
    WHEN i.due_date < (SELECT d FROM _today) THEN 'vencida'
    WHEN COALESCE(pa.s, 0) > 0 THEN 'parcial'
    WHEN julianday(i.due_date) - julianday((SELECT d FROM _today)) <= CAST((SELECT value FROM settings WHERE key = 'due_soon_days') AS INTEGER) THEN 'proxima'
    ELSE 'pendiente'
  END AS computed_status,
  CASE WHEN i.status <> 'anulada' AND COALESCE(pa.s, 0) < i.total + COALESCE(ad.s, 0) AND i.due_date < (SELECT d FROM _today)
       THEN CAST(julianday((SELECT d FROM _today)) - julianday(i.due_date) AS INTEGER) ELSE 0 END AS days_late,
  i.total + COALESCE(ad.s, 0) AS amount_due, COALESCE(ad.s, 0) AS adj, COALESCE(pa.s, 0) AS paid,
  CASE WHEN i.status = 'anulada' THEN 0 ELSE MAX(i.total + COALESCE(ad.s, 0) - COALESCE(pa.s, 0), 0) END AS balance,
  CASE WHEN i.status <> 'anulada' AND COALESCE(pa.s, 0) < i.total + COALESCE(ad.s, 0) THEN 1 ELSE 0 END AS is_open,
  CASE WHEN i.status <> 'anulada' AND COALESCE(pa.s, 0) < i.total + COALESCE(ad.s, 0) AND i.due_date < (SELECT d FROM _today) THEN 1 ELSE 0 END AS is_late
FROM invoices i
LEFT JOIN (SELECT invoice_id, SUM(amount) s FROM adjustments GROUP BY invoice_id) ad ON ad.invoice_id = i.id
LEFT JOIN (SELECT invoice_id, SUM(amount) s FROM allocations WHERE active = 1 GROUP BY invoice_id) pa ON pa.invoice_id = i.id;

CREATE VIEW v_loan_bulk AS
SELECT b.*,
  (b.total_contract + b.other_total + b.adj_total) AS contract_due,
  CASE WHEN b.status = 'anulado' THEN 0 ELSE MAX(b.total_contract + b.other_total + b.adj_total - b.paid_total, 0) END AS contract_balance,
  CASE WHEN b.status = 'anulado' THEN 0 ELSE b.inv_balance END AS invoice_balance,
  CASE WHEN b.status = 'anulado' THEN 0 ELSE b.inv_overdue END AS overdue_balance
FROM (
  SELECT l.*, c.full_name AS client_name, c.code AS client_code,
    COALESCE(ag.other_total, 0) AS other_total, COALESCE(ag.adj_total, 0) AS adj_total, COALESCE(ag.paid, 0) AS paid_total,
    COALESCE(ag.balance, 0) AS inv_balance, COALESCE(ag.overdue, 0) AS inv_overdue,
    COALESCE(ag.n_open, 0) AS invoices_pending, COALESCE(ag.n_late, 0) AS invoices_overdue,
    COALESCE(ag.max_days_late, 0) AS max_days_late, COALESCE(ag.invoiced, 0) AS invoiced_total,
    NULLIF(MIN(COALESCE(ag.next_inv, '9999-12-31'), COALESCE(nu.d, '9999-12-31')), '9999-12-31') AS next_due_date,
    pp.last_payment_at, COALESCE(pp.received, 0) AS received_total
  FROM loans l
  JOIN clients c ON c.id = l.client_id
  LEFT JOIN (
    SELECT loan_id,
      SUM(CASE WHEN status <> 'anulada' THEN other_amount ELSE 0 END) AS other_total,
      SUM(CASE WHEN status <> 'anulada' THEN adj ELSE 0 END) AS adj_total,
      SUM(paid) AS paid, SUM(balance) AS balance,
      SUM(CASE WHEN is_late = 1 THEN balance ELSE 0 END) AS overdue,
      SUM(is_open) AS n_open, SUM(is_late) AS n_late,
      MAX(CASE WHEN is_late = 1 THEN CAST(julianday((SELECT d FROM _today)) - julianday(due_date) AS INTEGER) ELSE 0 END) AS max_days_late,
      SUM(CASE WHEN status <> 'anulada' THEN amount_due ELSE 0 END) AS invoiced,
      MIN(CASE WHEN is_open = 1 AND due_date >= (SELECT d FROM _today) THEN due_date END) AS next_inv
    FROM v_inv_flat GROUP BY loan_id
  ) ag ON ag.loan_id = l.id
  LEFT JOIN (
    SELECT s.loan_id, MIN(s.due_date) AS d FROM installments s
    WHERE s.active = 1 AND s.due_date >= (SELECT d FROM _today) AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.installment_id = s.id AND i.status <> 'anulada')
    GROUP BY s.loan_id
  ) nu ON nu.loan_id = l.id
  LEFT JOIN (SELECT loan_id, MAX(paid_at) AS last_payment_at, SUM(amount) AS received FROM payments WHERE status = 'activo' GROUP BY loan_id) pp ON pp.loan_id = l.id
) b;

CREATE VIEW v_payment AS
SELECT p.*,
  COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.payment_id = p.id AND a.active = 1), 0) AS applied,
  CASE WHEN p.status = 'activo'
       THEN p.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.payment_id = p.id AND a.active = 1), 0)
       ELSE 0 END AS unapplied
FROM payments p;

CREATE VIEW v_client AS
SELECT c.*,
  COUNT(l.id) AS loans_count,
  COALESCE(SUM(CASE WHEN l.status = 'activo' THEN 1 ELSE 0 END), 0) AS loans_active,
  COALESCE(SUM(CASE WHEN l.status = 'pagado' THEN 1 ELSE 0 END), 0) AS loans_paid,
  COALESCE(SUM(CASE WHEN l.status <> 'anulado' THEN l.principal ELSE 0 END), 0) AS principal_total,
  COALESCE(SUM(CASE WHEN l.status <> 'anulado' THEN l.contract_due ELSE 0 END), 0) AS contract_total,
  COALESCE(SUM(l.paid_total), 0) AS paid_total,
  COALESCE(SUM(l.contract_balance), 0) AS contract_balance,
  COALESCE(SUM(l.invoice_balance), 0) AS invoice_balance,
  COALESCE(SUM(l.overdue_balance), 0) AS overdue_balance,
  COALESCE(SUM(l.invoices_pending), 0) AS invoices_pending,
  COALESCE(SUM(l.invoices_overdue), 0) AS invoices_overdue,
  MAX(l.max_days_late) AS max_days_late,
  MIN(CASE WHEN l.status = 'activo' THEN l.next_due_date END) AS next_due_date,
  (SELECT MAX(p.paid_at) FROM payments p WHERE p.client_id = c.id AND p.status = 'activo') AS last_payment_at,
  COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.client_id = c.id AND p.status = 'activo'), 0) AS received_total,
  COALESCE((SELECT SUM(vp.unapplied) FROM v_payment vp WHERE vp.client_id = c.id), 0) AS credit_balance
FROM clients c
LEFT JOIN v_loan l ON l.client_id = c.id
GROUP BY c.id;

CREATE VIEW v_client_bulk AS
SELECT c.*,
  COUNT(l.id) AS loans_count,
  COALESCE(SUM(CASE WHEN l.status = 'activo' THEN 1 ELSE 0 END), 0) AS loans_active,
  COALESCE(SUM(CASE WHEN l.status = 'pagado' THEN 1 ELSE 0 END), 0) AS loans_paid,
  COALESCE(SUM(CASE WHEN l.status <> 'anulado' THEN l.principal ELSE 0 END), 0) AS principal_total,
  COALESCE(SUM(CASE WHEN l.status <> 'anulado' THEN l.contract_due ELSE 0 END), 0) AS contract_total,
  COALESCE(SUM(l.paid_total), 0) AS paid_total,
  COALESCE(SUM(l.contract_balance), 0) AS contract_balance,
  COALESCE(SUM(l.invoice_balance), 0) AS invoice_balance,
  COALESCE(SUM(l.overdue_balance), 0) AS overdue_balance,
  COALESCE(SUM(l.invoices_pending), 0) AS invoices_pending,
  COALESCE(SUM(l.invoices_overdue), 0) AS invoices_overdue,
  MAX(l.max_days_late) AS max_days_late,
  MIN(CASE WHEN l.status = 'activo' THEN l.next_due_date END) AS next_due_date,
  MAX(l.last_payment_at) AS last_payment_at,
  COALESCE(SUM(l.received_total), 0) AS received_total,
  COALESCE(MAX(cr.s), 0) AS credit_balance
FROM clients c
LEFT JOIN v_loan_bulk l ON l.client_id = c.id
LEFT JOIN (SELECT p.client_id, SUM(p.amount - COALESCE(ap.s, 0)) s FROM payments p
     LEFT JOIN (SELECT payment_id, SUM(amount) s FROM allocations WHERE active = 1 GROUP BY payment_id) ap ON ap.payment_id = p.id
     WHERE p.status = 'activo' GROUP BY p.client_id) cr ON cr.client_id = c.id
GROUP BY c.id;
`);

// ===== Migraciones: columnas agregadas después de la primera versión =====
// request_id identifica cada envío del formulario para que un doble clic no registre dos veces.
for (const [table, col] of [['loans', 'request_id'], ['payments', 'request_id']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
}

// ===== Configuración por defecto =====
const DEFAULT_SETTINGS = {
  business_name: 'Mi negocio de préstamos',
  business_id: '',
  business_phone: '',
  business_address: '',
  invoice_lead_days: '5',       // días antes del vencimiento en que se emite la factura
  due_soon_days: '3',           // días para marcar "próxima a vencer"
  day_rule: 'ultimo_dia',       // regla cuando el día de pago no existe en el mes
  usury_rate_ea: '',            // tasa de usura vigente (% E.A.) que el administrador registra; vacío = sin validar
  overpayment_policy: 'saldo_favor', // saldo_favor | sin_aplicar
  invoice_prefix: 'FC',
  receipt_prefix: 'RC',
  acc_prefix: 'DA',
  last_download_at: '',        // última vez que se descargó un respaldo a un archivo
  loan_prefix: 'PR',
  client_prefix: 'CL',
  setup_done: '',              // '1' cuando el administrador completó el asistente de primer uso
  message_templates: "[{\"name\": \"Recordatorio de pago de la factura del mes\", \"text\": \"Buen día, {nombre}.\\n\\nReciba un cordial saludo. Le recordamos que su factura {factura}, correspondiente a la cuota mensual de {mes_factura}, por valor de {valor_factura}, tiene fecha de pago el {fecha_factura}.\\n\\nLe agradecemos realizar el pago a tiempo para mantener su crédito al día.\\n\\nSi ya realizó el pago, por favor envíenos el comprobante por este medio para registrarlo, y haga caso omiso de este mensaje.\\n\\nSi tiene alguna inquietud, con gusto le atenderemos.\\n\\nCordialmente,\\n{empresa}\\n{telefono_empresa}\"}]", // plantillas de mensajes para clientes (JSON)
};
{
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
}

function getSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : DEFAULT_SETTINGS[key];
}

/** Siguiente número consecutivo (debe llamarse dentro de una transacción). */
function nextNumber(counter, prefixKey, width = 6) {
  db.prepare('INSERT OR IGNORE INTO counters(name, value) VALUES (?, 0)').run(counter);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(counter);
  const { value } = db.prepare('SELECT value FROM counters WHERE name = ?').get(counter);
  return `${setting(prefixKey)}-${String(value).padStart(width, '0')}`;
}

// ===== Contraseñas =====
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(h, ref);
}

// Usuario administrador inicial
if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO users(username, name, password_hash, role, created_at) VALUES (?,?,?,?,?)')
    .run('admin', 'Administrador', hashPassword(pw), 'admin', now());
  if (!process.env.ADMIN_PASSWORD) {
    console.log('[cartera] Usuario inicial creado: admin / admin123  (cámbielo en Configuración > Usuarios)');
  }
}

/** Registro de auditoría / historial de acontecimientos. */
function audit(userId, { clientId = null, entity, entityId = null, action, summary, detail = null }) {
  db.prepare(`INSERT INTO audit_log(at, user_id, client_id, entity, entity_id, action, summary, detail)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(now(), userId || null, clientId, entity, entityId, action, summary, detail ? JSON.stringify(detail) : null);
}

syncToday();

module.exports = { db, syncToday, getSettings, setting, nextNumber, hashPassword, verifyPassword, audit, DEFAULT_SETTINGS, DB_PATH };
