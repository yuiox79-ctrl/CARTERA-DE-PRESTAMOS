'use strict';
// Exportación completa a Excel: un informe con resumen tipo tablero y una hoja por cada tipo de información.

const { db, getSettings } = require('./db');
const { today, now, addDays } = require('./util');
const { exportRows } = require('./history');
const { STATUS: STATUS_LABEL } = require('./excel');

const FREQ = { diaria: 'Diaria', semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual', personalizada: 'Personalizada' };
const INTEREST = { sin_interes: 'Sin interés', simple_total: 'Simple sobre el total', simple_mensual: 'Simple mensual', cuota_fija: 'Cuota fija', manual: 'Total pactado manualmente' };
const METHOD = { efectivo: 'Efectivo', transferencia: 'Transferencia', consignacion: 'Consignación', nequi: 'Nequi', daviplata: 'Daviplata', otro: 'Otro' };
const MODE = { normal: 'Normal', acumulada: 'Acumulada' };
const NOTE = { nota: 'Observación', recordatorio: 'Recordatorio', gestion: 'Gestión de cobro' };
const DIST = { automatica: 'Automática', especifica: 'Factura específica', manual: 'Manual' };
const ENTITY = { cliente: 'Cliente', prestamo: 'Préstamo', factura: 'Factura', pago: 'Pago', nota: 'Observación', usuario: 'Usuario', configuracion: 'Configuración', respaldo: 'Respaldo', papelera: 'Papelera', sistema: 'Sistema' };
const ACTION = { crear: 'Creación', editar: 'Edición', registrar: 'Registro', anular: 'Anulación', eliminar: 'Eliminación', restaurar: 'Restauración', reversar: 'Reversión', emitir: 'Emisión', ajustar: 'Ajuste', aplicar_saldo: 'Saldo a favor aplicado', cancelar: 'Cancelación', clave: 'Cambio de contraseña', copia: 'Copia de seguridad', exportar: 'Exportación', login: 'Inicio de sesión', modalidad: 'Cambio de modalidad', reactivar: 'Reactivación', reprogramar: 'Reprogramación', vaciar: 'Vaciado', facturar: 'Facturación automática' };
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const label = (map) => (k) => (row) => map[row[k]] || row[k] || '';
const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

const TAB = { resumen: 'FFD6A23E', cobranza: 'FFB91C1C', clientes: 'FF0F766E', prestamos: 'FF0D7A6A', cuotas: 'FF1D4ED8', facturas: 'FF1D4ED8', pagos: 'FF15803D', dist: 'FF15803D', notas: 'FF946200', proximos: 'FFC2410C', historial: 'FF4B5B5C' };

function lastMonths(t, n) {
  const out = [];
  let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  for (let k = 0; k < n; k++) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); m--; if (!m) { m = 12; y--; } }
  return out;
}

/** Tarjetas de indicadores: 4 por fila, cada una de 2 columnas y 3 filas. */
function kpiCards(ws, row, cards, kit) {
  const { fill, C } = kit;
  cards.forEach((card, i) => {
    const col = 1 + i * 2;
    const tone = card.tone || C.ink;
    ws.mergeCells(row, col, row, col + 1);
    ws.mergeCells(row + 1, col, row + 1, col + 1);
    ws.mergeCells(row + 2, col, row + 2, col + 1);
    const l = ws.getCell(row, col);
    l.value = card.label.toUpperCase();
    l.font = { size: 9, bold: true, color: { argb: C.muted } };
    const v = ws.getCell(row + 1, col);
    v.value = card.value;
    v.font = { size: 18, bold: true, color: { argb: tone } };
    if (card.fmt) v.numFmt = card.fmt;
    v.alignment = { horizontal: 'left', vertical: 'middle' };
    const sub = ws.getCell(row + 2, col);
    sub.value = card.sub || '';
    sub.font = { size: 9, italic: true, color: { argb: C.muted } };
    for (let r = row; r <= row + 2; r++) {
      for (let c = col; c <= col + 1; c++) {
        const cell = ws.getCell(r, c);
        cell.fill = fill(card.soft || 'FFF7FAF9');
        cell.border = {
          top: r === row ? { style: 'medium', color: { argb: tone } } : undefined,
          bottom: r === row + 2 ? { style: 'thin', color: { argb: C.line } } : undefined,
          left: c === col ? { style: 'thin', color: { argb: C.line } } : undefined,
          right: c === col + 1 ? { style: 'thin', color: { argb: C.line } } : undefined,
        };
      }
    }
  });
  ws.getRow(row).height = 16;
  ws.getRow(row + 1).height = 30;
  ws.getRow(row + 2).height = 16;
  return row + 4;
}

function fullExportSheets() {
  const s = getSettings();
  const t = today();
  const stamp = `${dmy(t)} a las ${now().slice(11, 16)}`;
  const business = s.business_name || 'Cartera';

  const clients = db.prepare('SELECT * FROM v_client_bulk ORDER BY full_name COLLATE NOCASE, id').all().map((c, i) => ({ ...c, n: i + 1 }));
  const loans = db.prepare('SELECT * FROM v_loan_bulk ORDER BY id').all();
  const flat = db.prepare('SELECT * FROM v_inv_flat').all();
  const installments = db.prepare(`SELECT i.*, l.number AS loan_number, l.status AS loan_status, c.full_name AS client_name, c.code AS client_code, c.phone,
      f.number AS invoice_number, f.computed_status AS invoice_status, f.balance AS invoice_balance, f.paid AS invoice_paid
    FROM installments i JOIN loans l ON l.id = i.loan_id JOIN clients c ON c.id = l.client_id
    LEFT JOIN v_inv_flat f ON f.id = (SELECT id FROM invoices WHERE installment_id = i.id AND status <> 'anulada' ORDER BY id DESC LIMIT 1)
    WHERE i.active = 1 ORDER BY l.id, i.number`).all();
  const invoices = db.prepare(`SELECT v.*, l.number AS loan_number, c.full_name AS client_name, c.code AS client_code
    FROM v_invoice v JOIN loans l ON l.id = v.loan_id JOIN clients c ON c.id = v.client_id ORDER BY v.due_date, v.id`).all();
  const payments = db.prepare(`SELECT p.*, l.number AS loan_number, c.full_name AS client_name, c.code AS client_code
    FROM v_payment p JOIN loans l ON l.id = p.loan_id JOIN clients c ON c.id = p.client_id ORDER BY p.paid_at, p.id`).all();
  const allocations = db.prepare(`SELECT a.*, p.receipt_number, p.paid_at, f.number AS invoice_number, f.due_date, c.full_name AS client_name, l.number AS loan_number
    FROM allocations a JOIN payments p ON p.id = a.payment_id JOIN invoices f ON f.id = a.invoice_id
    JOIN loans l ON l.id = f.loan_id JOIN clients c ON c.id = f.client_id ORDER BY p.paid_at, a.id`).all();
  const notes = db.prepare(`SELECT n.*, c.full_name AS client_name, c.code AS client_code, u.name AS user_name
    FROM notes n JOIN clients c ON c.id = n.client_id LEFT JOIN users u ON u.id = n.user_id ORDER BY n.created_at DESC, n.id DESC`).all();
  const lastNote = new Map();
  for (const n of notes) if (!lastNote.has(n.client_id)) lastNote.set(n.client_id, n);
  const history = exportRows({});

  // ---------- Cálculos del resumen ----------
  const live = loans.filter((l) => l.status !== 'anulado');
  const activePays = payments.filter((p) => p.status === 'activo');
  const tot = {
    principal: sum(live, 'principal'), contract: sum(live, 'contract_due'), received: sum(activePays, 'amount'),
    contractBal: sum(clients, 'contract_balance'), invoiceBal: sum(clients, 'invoice_balance'), overdue: sum(clients, 'overdue_balance'), credit: sum(clients, 'credit_balance'),
  };
  const late = flat.filter((f) => f.is_late && f.balance > 0);
  const BUCKETS = [['1 a 30 días', 1, 30], ['31 a 60 días', 31, 60], ['61 a 90 días', 61, 90], ['Más de 90 días', 91, 1e9]];
  const aging = BUCKETS.map(([name, a, b]) => {
    const r = late.filter((f) => f.days_late >= a && f.days_late <= b);
    return { name, n: r.length, amount: sum(r, 'balance'), share: tot.overdue ? sum(r, 'balance') / tot.overdue : 0 };
  });
  const months = lastMonths(t, 12).map((m) => {
    const billed = flat.filter((f) => f.status !== 'anulada' && String(f.issue_date).slice(0, 7) === m);
    const paid = activePays.filter((p) => String(p.paid_at).slice(0, 7) === m);
    const b = sum(billed, 'amount_due'), c = sum(paid, 'amount');
    return { label: `${MESES[Number(m.slice(5, 7)) - 1].slice(0, 3)} ${m.slice(0, 4)}`, billed: b, collected: c, rate: b ? c / b : null };
  });
  const byStatus = ['pendiente', 'proxima', 'parcial', 'vencida', 'pagada', 'anulada'].map((st) => {
    const r = flat.filter((f) => f.computed_status === st);
    return { status: st, n: r.length, amount: sum(r, 'amount_due'), balance: st === 'anulada' ? 0 : sum(r, 'balance') };
  }).filter((r) => r.n);
  const debtors = clients.filter((c) => c.overdue_balance > 0).sort((a, b) => b.overdue_balance - a.overdue_balance);
  const soon = (days) => installments.filter((i) => i.loan_status === 'activo' && i.due_date >= t && i.due_date <= addDays(t, days) && (i.invoice_balance == null || i.invoice_balance > 0))
    .map((i) => ({ ...i, pending: i.invoice_balance ?? i.amount, st: i.invoice_status || 'programada' }))
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));

  // Mora por cliente con antigüedad.
  const lateByClient = new Map();
  for (const f of late) {
    const e = lateByClient.get(f.client_id) || { d30: 0, d60: 0, d90: 0, d90p: 0, n: 0 };
    e.n++;
    if (f.days_late <= 30) e.d30 += f.balance; else if (f.days_late <= 60) e.d60 += f.balance; else if (f.days_late <= 90) e.d90 += f.balance; else e.d90p += f.balance;
    lateByClient.set(f.client_id, e);
  }
  const collections = debtors.map((c, i) => ({ ...c, rank: i + 1, ...(lateByClient.get(c.id) || {}), gestion: lastNote.get(c.id) ? `${dmy(lastNote.get(c.id).created_at.slice(0, 10))}: ${lastNote.get(c.id).text}` : '' }));

  const resumen = {
    name: 'Resumen', tabColor: TAB.resumen,
    build(ws, kit) {
      const { titleBand, sectionTitle, table, C } = kit;
      [34, 17, 17, 17, 17, 17, 17, 17].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
      let row = titleBand(ws, 1, 8, `${business} — Informe completo de cartera`, [`Generado el ${stamp} · Valores en pesos colombianos (COP)`, 'Hojas: Resumen · Cobranza · Clientes · Préstamos · Cuotas · Facturas · Pagos · Distribución · Próximos vencimientos · Observaciones · Historial']);
      const MONEY = '"$" #,##0';
      row = kpiCards(ws, row, [
        { label: 'Capital total prestado', value: tot.principal, fmt: MONEY, sub: `${live.length} préstamo(s) registrados`, tone: C.ink },
        { label: 'Total contractual acordado', value: tot.contract, fmt: MONEY, sub: 'Capital + intereses pactados', tone: C.primary },
        { label: 'Total recibido', value: tot.received, fmt: MONEY, sub: `${activePays.length} pago(s) vigentes`, tone: 'FF15803D', soft: 'FFF1FAF4' },
        { label: 'Saldo contractual pendiente', value: tot.contractBal, fmt: MONEY, sub: 'Lo que falta por pagar en total', tone: 'FFC2410C', soft: 'FFFFF6EE' },
      ], kit);
      row = kpiCards(ws, row, [
        { label: 'Saldo de facturas pendientes', value: tot.invoiceBal, fmt: MONEY, sub: 'Facturas emitidas sin pagar', tone: 'FF1D4ED8', soft: 'FFF2F6FF' },
        { label: 'Cartera vencida', value: tot.overdue, fmt: MONEY, sub: `${debtors.length} cliente(s) en mora`, tone: C.red, soft: 'FFFEF3F3' },
        { label: '% de lo facturado en mora', value: tot.invoiceBal ? tot.overdue / tot.invoiceBal : 0, fmt: '0.0%', sub: 'Vencido ÷ saldo de facturas', tone: C.red, soft: 'FFFEF3F3' },
        { label: 'Saldo a favor de clientes', value: tot.credit, fmt: MONEY, sub: 'Pagos de más sin aplicar', tone: 'FF946200', soft: C.goldSoft },
      ], kit);
      row = kpiCards(ws, row, [
        { label: 'Clientes', value: clients.length, sub: `${clients.filter((c) => c.status === 'activo').length} activo(s)`, tone: 'FF0F766E' },
        { label: 'Préstamos activos', value: loans.filter((l) => l.status === 'activo').length, sub: `${loans.filter((l) => l.status === 'pagado').length} cancelado(s)`, tone: C.primary },
        { label: 'Facturas emitidas', value: flat.filter((f) => f.status !== 'anulada').length, sub: `${late.length} vencida(s) con saldo`, tone: 'FF1D4ED8' },
        { label: 'Movimientos registrados', value: history.length, sub: 'Ver hoja Historial', tone: 'FF4B5B5C' },
      ], kit);

      // Gráficos (se dibujan después, enlazados a las tablas de abajo).
      ws.getRow(row - 1).addPageBreak(); // al imprimir, los gráficos van en su propia página
      row = sectionTitle(ws, row, 1, 8, 'Gráficos', 'Gráficos de Excel enlazados a las tablas de esta hoja: puede cambiarles el estilo, copiarlos o pegarlos en otro documento.');
      const chartsTop = row - 1;
      const CH = 15;
      row += CH * 2 + 3;
      ws.getRow(row - 2).addPageBreak();

      row = sectionTitle(ws, row, 1, 8, 'Facturado frente a recaudado · últimos 12 meses', 'Facturado: facturas emitidas en el mes. Recaudado: pagos recibidos en el mes.');
      const tM = table(ws, row, 1, { columns: [['Mes', 'label', '', 'strong'], ['Facturado', 'billed', 'money'], ['Recaudado', 'collected', 'money'], ['% recaudo', 'rate', 'percent'], ['Diferencia', (r) => r.collected - r.billed, 'money']], rows: months });
      row = tM.next;

      row = sectionTitle(ws, row, 1, 8, 'Antigüedad de la cartera vencida', 'Cuánto tiempo llevan sin pagarse las facturas vencidas. Entre más antigua, más difícil de cobrar.');
      const tA = table(ws, row, 1, { columns: [['Rango de mora', 'name', '', 'strong'], ['Facturas', 'n'], ['Saldo vencido', 'amount', 'money'], ['% del vencido', 'share', 'percent']], rows: aging });
      row = tA.next;

      row = sectionTitle(ws, row, 1, 8, 'Facturas por estado');
      const tS = table(ws, row, 1, { columns: [['Estado', 'status', 'status'], ['Cantidad', 'n'], ['Importe', 'amount', 'money'], ['Saldo pendiente', 'balance', 'money']], rows: byStatus, empty: 'Aún no hay facturas emitidas' });
      row = tS.next;

      row = sectionTitle(ws, row, 1, 8, 'Clientes con mayor saldo vencido', 'Los 10 primeros. La lista completa está en la hoja Cobranza.');
      const top = debtors.slice(0, 10);
      const tD = table(ws, row, 1, { columns: [['Cliente', 'full_name', '', 'strong'], ['Código', 'code'], ['Teléfono', 'phone'], ['Saldo vencido', 'overdue_balance', 'money', 'danger'], ['Días de mora', 'max_days_late'], ['Último pago', 'last_payment_at', 'date'], ['Saldo total', 'contract_balance', 'money']], rows: top, empty: 'Ningún cliente está en mora. ¡Excelente!' });
      row = tD.next;

      row = sectionTitle(ws, row, 1, 8, 'Próximos vencimientos · 15 días', 'Cuotas que vencen pronto y aún tienen saldo. La lista de 30 días está en la hoja Próximos vencimientos.');
      table(ws, row, 1, { columns: [['Cliente', 'client_name', '', 'strong'], ['Vence', 'due_date', 'date'], ['Préstamo', 'loan_number'], ['Cuota', 'number'], ['Por cobrar', 'pending', 'money'], ['Estado', 'st', 'status'], ['Teléfono', 'phone']], rows: soon(15), empty: 'No hay cuotas por vencer en los próximos 15 días' });

      const R = (col, t) => `${kit.ref}!$${col}$${t.first}:$${col}$${t.last}`;
      const box = (k) => ({ from: { col: k % 2 ? 4 : 0, row: chartsTop + Math.floor(k / 2) * (CH + 1) }, to: { col: k % 2 ? 8 : 4, row: chartsTop + Math.floor(k / 2) * (CH + 1) + CH } });
      const empty = (k, text) => {
        const b0 = box(k);
        ws.mergeCells(b0.from.row + 1, b0.from.col + 1, b0.to.row, b0.to.col);
        const c = ws.getCell(b0.from.row + 1, b0.from.col + 1);
        c.value = text;
        c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        c.font = { italic: true, size: 11, color: { argb: C.muted } };
        c.fill = kit.fill('FFF7FAF9');
        c.border = kit.box();
      };
      kit.chart({ type: 'bar', title: 'Facturado frente a recaudado (12 meses)', ...box(0), catRef: R('A', tM), categories: months.map((m) => m.label),
        series: [{ name: 'Facturado', ref: R('B', tM), values: months.map((m) => m.billed), color: '0D7A6A' }, { name: 'Recaudado', ref: R('C', tM), values: months.map((m) => m.collected), color: 'D6A23E' }] });
      if (tot.overdue > 0) {
        kit.chart({ type: 'doughnut', title: 'Antigüedad de la cartera vencida', ...box(1), catRef: R('A', tA), categories: aging.map((a) => a.name),
          series: [{ name: 'Saldo vencido', ref: R('C', tA), values: aging.map((a) => a.amount), pointColors: ['F2B84B', 'EA7A2A', 'D63B3B', '7F1D1D'] }] });
      } else empty(1, 'Antigüedad de la cartera vencida\n\nNo hay cartera vencida. ¡Excelente!');
      if (byStatus.length) {
        const SC = { pendiente: '3B6FE0', proxima: 'E0A82E', parcial: 'EA7A2A', vencida: 'D63B3B', pagada: '22A06B', anulada: '9AA8A7' };
        kit.chart({ type: 'bar', title: 'Facturas por estado (cantidad)', ...box(2), catRef: R('A', tS), categories: byStatus.map((x) => STATUS_LABEL[x.status] || x.status), labels: true, labelFmt: '0', valFmt: '0', gap: 45,
          series: [{ name: 'Facturas', ref: R('B', tS), values: byStatus.map((x) => x.n), color: '0D7A6A', pointColors: byStatus.map((x) => SC[x.status] || '0D7A6A') }] });
      } else empty(2, 'Facturas por estado\n\nAún no hay facturas emitidas.');
      if (top.length) {
        kit.chart({ type: 'barH', title: 'Clientes con mayor saldo vencido', ...box(3), catRef: R('A', tD), categories: top.map((c) => c.full_name), labels: true, gap: 40,
          series: [{ name: 'Saldo vencido', ref: R('D', tD), values: top.map((c) => c.overdue_balance), color: 'D63B3B' }] });
      } else empty(3, 'Clientes con mayor saldo vencido\n\nNingún cliente está en mora.');
      ws.views = [{ showGridLines: false }];
    },
  };

  return [
    resumen,
    {
      name: 'Cobranza', tabColor: TAB.cobranza, freezeFirst: true,
      title: [`Cobranza — clientes en mora (${collections.length})`, `Ordenados del mayor al menor saldo vencido · ${stamp}`],
      columns: [['N.º', 'rank'], ['Cliente', 'full_name', '', 'strong'], ['Código', 'code'], ['Teléfono', 'phone'], ['Dirección', 'address'],
        ['Facturas vencidas', 'n'], ['1–30 días', 'd30', 'money'], ['31–60 días', 'd60', 'money'], ['61–90 días', 'd90', 'money'], ['Más de 90', 'd90p', 'money'],
        ['Total vencido', 'overdue_balance', 'money', 'danger'], ['Días mora máx.', 'max_days_late'], ['Último pago', 'last_payment_at', 'date'],
        ['Saldo total', 'contract_balance', 'money'], ['Última gestión', 'gestion']],
      rows: collections, empty: 'Ningún cliente está en mora.',
    },
    {
      name: 'Clientes', tabColor: TAB.clientes, freezeFirst: true,
      title: [`Directorio de clientes (${clients.length})`, stamp],
      columns: [['N.º', 'n'], ['Nombre', 'full_name', '', 'strong'], ['Código', 'code'], ['Tipo ID', 'id_type'], ['Identificación', 'id_number'], ['Teléfono', 'phone'],
        ['Dirección', 'address'], ['Correo', 'email'], ['Registro', 'created_at', 'date'], ['Préstamos', 'loans_count'], ['Activos', 'loans_active'],
        ['Capital prestado', 'principal_total', 'money'], ['Total contractual', 'contract_total', 'money'], ['Total abonado', 'paid_total', 'money'],
        ['Saldo contractual', 'contract_balance', 'money'], ['Saldo facturas', 'invoice_balance', 'money'], ['Vencido', 'overdue_balance', 'money', 'danger'],
        ['Días mora máx.', 'max_days_late'], ['Saldo a favor', 'credit_balance', 'money'], ['Último pago', 'last_payment_at', 'date'],
        ['Próximo pago', 'next_due_date', 'date'], ['Estado', 'status', 'status'], ['Observaciones', 'observations']],
      rows: clients,
    },
    {
      name: 'Préstamos', tabColor: TAB.prestamos, freezeFirst: true,
      title: [`Préstamos (${loans.length})`, stamp],
      columns: [['Préstamo', 'number', '', 'strong'], ['Cliente', 'client_name'], ['Código', 'client_code'], ['Entrega', 'disbursed_at', 'date'], ['Capital', 'principal', 'money'],
        ['Interés', label(INTEREST)('interest_mode')], ['Tasa %', 'interest_rate'], ['Total contractual', 'contract_due', 'money'], ['Cuotas', 'installments_count'],
        ['Valor cuota', 'installment_amount', 'money', 'nosum'], ['Frecuencia', label(FREQ)('frequency')], ['Primera cuota', 'first_due_date', 'date'], ['Última cuota', 'end_date', 'date'],
        ['Facturación', label(MODE)('billing_mode')], ['Abonado', 'paid_total', 'money'], ['Saldo contractual', 'contract_balance', 'money'],
        ['Saldo facturas', 'invoice_balance', 'money'], ['Vencido', 'overdue_balance', 'money', 'danger'], ['Días mora máx.', 'max_days_late'],
        ['Próximo pago', 'next_due_date', 'date'], ['Tasa E.A. implícita %', (r) => (r.implied_ea == null ? '' : Math.round(r.implied_ea * 100) / 100)],
        ['Estado', 'status', 'status'], ['Observaciones', 'observations']],
      rows: loans,
    },
    {
      name: 'Cuotas', tabColor: TAB.cuotas,
      title: [`Calendario de cuotas (${installments.length})`, stamp],
      columns: [['Préstamo', 'loan_number', '', 'strong'], ['Cliente', 'client_name'], ['Código', 'client_code'], ['Cuota', 'number'], ['Vence', 'due_date', 'date'],
        ['Valor', 'amount', 'money'], ['Factura', (r) => r.invoice_number || 'Sin facturar aún'], ['Abonado', 'invoice_paid', 'money'],
        ['Saldo', (r) => (r.invoice_balance ?? r.amount), 'money'], ['Estado', (r) => r.invoice_status || 'programada', 'status']],
      rows: installments,
    },
    {
      name: 'Facturas', tabColor: TAB.facturas,
      title: [`Facturas (${invoices.length})`, stamp],
      columns: [['Factura', 'number', '', 'strong'], ['Cliente', 'client_name'], ['Código', 'client_code'], ['Préstamo', 'loan_number'], ['Periodo', 'period_label'],
        ['Emisión', 'issue_date', 'date'], ['Vence', 'due_date', 'date'], ['Concepto', 'concept'], ['Importe', 'amount_due', 'money'], ['Abonos', 'paid', 'money'],
        ['Saldo', 'balance', 'money'], ['Estado', 'computed_status', 'status'], ['Días mora', 'days_late'], ['Modalidad', label(MODE)('billing_mode')]],
      rows: invoices,
    },
    {
      name: 'Pagos', tabColor: TAB.pagos,
      title: [`Pagos recibidos (${payments.length})`, stamp],
      columns: [['Recibo', 'receipt_number', '', 'strong'], ['Fecha', 'paid_at', 'datetime'], ['Cliente', 'client_name'], ['Código', 'client_code'], ['Préstamo', 'loan_number'],
        ['Valor recibido', 'amount', 'money'], ['Aplicado', 'applied', 'money'], ['Saldo a favor', 'unapplied', 'money'], ['Método', label(METHOD)('method')],
        ['Referencia', 'reference'], ['Recibió', 'received_by'], ['Distribución', label(DIST)('distribution_mode')], ['Saldo antes', 'balance_before', 'money', 'nosum'],
        ['Saldo después', 'balance_after', 'money', 'nosum'], ['Estado', 'status', 'status'], ['Motivo reversión', 'reversal_reason'], ['Observaciones', 'observations']],
      rows: payments,
    },
    {
      name: 'Distribución de pagos', tabColor: TAB.dist,
      title: ['Distribución de cada pago entre facturas', stamp],
      columns: [['Recibo', 'receipt_number', '', 'strong'], ['Fecha pago', 'paid_at', 'datetime'], ['Cliente', 'client_name'], ['Préstamo', 'loan_number'],
        ['Factura', 'invoice_number'], ['Vence factura', 'due_date', 'date'], ['Valor aplicado', 'amount', 'money'],
        ['Origen', (r) => (r.source === 'saldo_favor' ? 'Saldo a favor' : 'Pago')], ['Vigente', (r) => (r.active ? 'Sí' : 'No (reversado)')]],
      rows: allocations,
    },
    {
      name: 'Próximos vencimientos', tabColor: TAB.proximos,
      title: ['Próximos vencimientos · 30 días', `Cuotas con saldo que vencen entre el ${dmy(t)} y el ${dmy(addDays(t, 30))}`],
      columns: [['Vence', 'due_date', 'date'], ['Cliente', 'client_name', '', 'strong'], ['Código', 'client_code'], ['Teléfono', 'phone'], ['Préstamo', 'loan_number'],
        ['Cuota', 'number'], ['Factura', (r) => r.invoice_number || 'Por emitir'], ['Por cobrar', 'pending', 'money'], ['Estado', 'st', 'status']],
      rows: soon(30), empty: 'No hay cuotas por vencer en los próximos 30 días',
    },
    {
      name: 'Observaciones', tabColor: TAB.notas,
      title: [`Observaciones y gestiones de cobro (${notes.length})`, stamp],
      columns: [['Fecha', 'created_at', 'datetime'], ['Cliente', 'client_name', '', 'strong'], ['Código', 'client_code'], ['Tipo', label(NOTE)('kind')],
        ['Texto', 'text'], ['Recordar el', 'remind_date', 'date'], ['Usuario', (r) => r.user_name || 'Sistema']],
      rows: notes,
    },
    {
      name: 'Historial', tabColor: TAB.historial,
      title: [`Historial de movimientos (${history.length})`, stamp],
      columns: [['Fecha y hora', 'at', 'datetime'], ['Usuario', (r) => r.user_name || 'Sistema'], ['Cliente', 'client_name'],
        ['Tipo', label(ENTITY)('entity')], ['Acción', (r) => ACTION[r.action] || r.action], ['Descripción', 'summary']],
      rows: history,
    },
  ];
}

module.exports = { fullExportSheets };
