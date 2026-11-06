'use strict';
// Exportación a Excel (.xlsx) con formato COP y fechas DD/MM/AAAA.

const excelLib = require('exceljs');
const { addCharts } = require('./xlsxcharts');
// En el servidor la librería ya está cargada; en la página publicada se descarga solo al exportar.
const loadExcel = async () => (typeof excelLib.load === 'function' ? excelLib.load() : excelLib);

const STATUS = {
  pendiente: 'Pendiente', proxima: 'Próxima a vencer', parcial: 'Abono parcial', pagada: 'Pagada', vencida: 'Vencida', anulada: 'Anulada',
  programada: 'Programada', sin_factura_vencida: 'Vencida (sin factura)', activo: 'Activo', pagado: 'Cancelado (pagado)', anulado: 'Anulado',
  reversado: 'Reversado', inactivo: 'Inactivo',
};

function toDate(v) {
  if (!v) return null;
  const [y, m, d] = String(v).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// ---------- Paleta (la misma de la aplicación) ----------
const C = {
  ink: 'FF0C2627', ink2: 'FF133536', primary: 'FF0D7A6A', primarySoft: 'FFE6F4F1', gold: 'FFD6A23E', goldSoft: 'FFFBF3E1',
  zebra: 'FFF5F9F8', line: 'FFDCE5E2', text: 'FF0F2426', muted: 'FF6A7D7E', white: 'FFFFFFFF', red: 'FFB91C1C',
};
/** Colores de cada estado: [texto, fondo]. */
const STATUS_COLOR = {
  pendiente: ['FF1D4ED8', 'FFE0EAFF'], proxima: ['FF946200', 'FFFDF0C4'], parcial: ['FFC2410C', 'FFFFE9D9'], pagada: ['FF15803D', 'FFDCF5E4'],
  vencida: ['FFB91C1C', 'FFFDE3E3'], anulada: ['FF4B5B5C', 'FFE6ECEB'], programada: ['FF4B5B5C', 'FFF1F5F4'], sin_factura_vencida: ['FFB91C1C', 'FFFDE3E3'],
  activo: ['FF0F766E', 'FFD5F2EE'], pagado: ['FF15803D', 'FFDCF5E4'], anulado: ['FF4B5B5C', 'FFE6ECEB'], reversado: ['FF4B5B5C', 'FFE6ECEB'],
  inactivo: ['FF4B5B5C', 'FFE6ECEB'],
};
const MONEY_FMT = '"$" #,##0;[Red]-"$" #,##0';
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = (argb = C.line) => ({ style: 'thin', color: { argb } });
const box = (argb = C.line) => ({ top: thin(argb), left: thin(argb), bottom: thin(argb), right: thin(argb) });
const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const fmtMoneyText = (v) => '$ ' + Math.round(Number(v) || 0).toLocaleString('es-CO');

function cellValue(row, [, key, type]) {
  const raw = typeof key === 'function' ? key(row) : row[key];
  if (type === 'money') return raw == null || raw === '' ? null : Number(raw);
  if (type === 'date') return toDate(raw);
  if (type === 'datetime') return raw ? `${String(raw).slice(8, 10)}/${String(raw).slice(5, 7)}/${String(raw).slice(0, 4)} ${String(raw).slice(11, 16)}` : '';
  if (type === 'status') return raw ? STATUS[raw] || raw : '';
  if (type === 'percent') return raw == null || raw === '' ? null : Number(raw);
  return raw ?? '';
}
function textLen(v, type) {
  if (v == null || v === '') return 0;
  if (type === 'money') return fmtMoneyText(v).length + 1;
  if (type === 'date') return 10;
  if (type === 'percent') return 7;
  return String(v).split('\n').reduce((a, l) => Math.max(a, l.length), 0);
}

/** Banda de título que ocupa `ncols` columnas. Devuelve la fila siguiente. */
function titleBand(ws, row, ncols, title, subtitles = []) {
  ncols = Math.max(ncols, 4);
  ws.mergeCells(row, 1, row, ncols);
  const t = ws.getCell(row, 1);
  t.value = title;
  t.font = { name: 'Calibri', size: 16, bold: true, color: { argb: C.white } };
  t.fill = fill(C.ink);
  t.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(row).height = 32;
  row++;
  for (const line of subtitles) {
    ws.mergeCells(row, 1, row, ncols);
    const c = ws.getCell(row, 1);
    c.value = line;
    c.font = { size: 10.5, color: { argb: C.gold } };
    c.fill = fill(C.ink2);
    c.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(row).height = 18;
    row++;
  }
  for (let k = 1; k <= ncols; k++) ws.getCell(row, k).border = { top: { style: 'medium', color: { argb: C.gold } } };
  return row + 1;
}

/** Título de sección dentro de una hoja. */
function sectionTitle(ws, row, col, ncols, text, note = '') {
  ws.mergeCells(row, col, row, col + ncols - 1);
  const c = ws.getCell(row, col);
  c.value = text;
  c.font = { size: 12.5, bold: true, color: { argb: C.ink } };
  c.border = { bottom: { style: 'medium', color: { argb: C.primary } } };
  ws.getRow(row).height = 22;
  if (note) {
    ws.mergeCells(row + 1, col, row + 1, col + ncols - 1);
    const n = ws.getCell(row + 1, col);
    n.value = note;
    n.font = { size: 9.5, italic: true, color: { argb: C.muted } };
    return row + 2;
  }
  return row + 1;
}

/**
 * Tabla con encabezado, filas cebra, estados de color y fila de totales.
 * spec: { columns: [[titulo, clave, tipo?]], rows, totals?, empty? } · tipos: money|date|datetime|status|percent|bar
 * Devuelve { next, header, first, last, widths }.
 */
function table(ws, row, col, spec) {
  const cols = spec.columns;
  const header = row;
  const widths = cols.map(([h]) => h.length + 2);
  cols.forEach(([h, , type], i) => {
    const c = ws.getCell(row, col + i);
    c.value = h;
    c.font = { bold: true, size: 10.5, color: { argb: C.white } };
    c.fill = fill(C.primary);
    c.alignment = { vertical: 'middle', horizontal: type === 'money' || type === 'percent' ? 'right' : 'center', wrapText: true };
    c.border = { top: thin(C.primary), left: thin(C.primary), right: thin(C.primary), bottom: { style: 'medium', color: { argb: C.gold } } };
  });
  ws.getRow(row).height = 30;
  row++;
  const first = row;
  const maxBar = spec.columns.some((c) => c[2] === 'bar') ? Math.max(1, ...spec.rows.map((r) => Number(r[spec.columns.find((c) => c[2] === 'bar')[1]]) || 0)) : 1;
  if (!spec.rows.length) {
    ws.mergeCells(row, col, row, col + cols.length - 1);
    const c = ws.getCell(row, col);
    c.value = spec.empty || 'Sin registros';
    c.font = { italic: true, color: { argb: C.muted } };
    c.alignment = { horizontal: 'center' };
    c.border = box();
    row++;
  }
  spec.rows.forEach((r, ri) => {
    const zebra = ri % 2 === 1;
    cols.forEach((def, i) => {
      const [, key, type] = def;
      const c = ws.getCell(row, col + i);
      if (type === 'bar') {
        const v = Number(typeof key === 'function' ? key(r) : r[key]) || 0;
        const n = Math.round((v / maxBar) * (spec.barLen || 24));
        c.value = n ? '█'.repeat(n) : '';
        c.font = { color: { argb: def[3] || C.primary }, size: 9 };
        widths[i] = Math.max(widths[i], (spec.barLen || 24) + 2);
      } else {
        const v = cellValue(r, def);
        c.value = v;
        widths[i] = Math.max(widths[i], textLen(v, type));
        c.font = { size: 10.5, color: { argb: C.text } };
        if (type === 'money') { c.numFmt = MONEY_FMT; c.alignment = { horizontal: 'right' }; }
        else if (type === 'date') { c.numFmt = 'dd/mm/yyyy'; c.alignment = { horizontal: 'center' }; }
        else if (type === 'datetime') c.alignment = { horizontal: 'center' };
        else if (type === 'percent') { c.numFmt = '0.0%'; c.alignment = { horizontal: 'right' }; }
        else if (typeof v === 'number') c.alignment = { horizontal: 'center' };
        else c.alignment = { wrapText: String(v).length > 60, vertical: 'top' };
        if (type === 'status') {
          const raw = typeof key === 'function' ? key(r) : r[key];
          const [fg, bg] = STATUS_COLOR[raw] || [C.text, null];
          c.font = { size: 10, bold: true, color: { argb: fg } };
          if (bg) c.fill = fill(bg);
          c.alignment = { horizontal: 'center' };
          return void (c.border = box());
        }
        if (def[3] === 'strong') c.font = { size: 10.5, bold: true, color: { argb: C.text } };
        if (def[3] === 'danger' && Number(v) > 0) c.font = { size: 10.5, bold: true, color: { argb: C.red } };
      }
      if (zebra) c.fill = fill(C.zebra);
      c.border = box();
    });
    row++;
  });
  const last = row - 1;
  const moneyCols = cols.map((c, i) => (c[2] === 'money' && c[3] !== 'nosum' ? i : -1)).filter((i) => i >= 0);
  if ((spec.totals ?? moneyCols.length > 0) && spec.rows.length > 1 && moneyCols.length) {
    cols.forEach((def, i) => {
      const c = ws.getCell(row, col + i);
      c.fill = fill(C.primarySoft);
      c.font = { bold: true, size: 10.5, color: { argb: C.ink } };
      c.border = { top: { style: 'medium', color: { argb: C.primary } }, bottom: thin(C.primary) };
      if (i === 0) c.value = `TOTAL (${spec.rows.length})`;
      if (def[2] === 'money' && def[3] !== 'nosum') {
        const L = colLetter(col + i);
        const result = spec.rows.reduce((a, r) => a + (Number(cellValue(r, def)) || 0), 0);
        c.value = { formula: `SUBTOTAL(9,${L}${first}:${L}${last})`, result };
        c.numFmt = MONEY_FMT;
        c.alignment = { horizontal: 'right' };
        widths[i] = Math.max(widths[i], textLen(result, 'money'));
      }
    });
    ws.getRow(row).height = 20;
    row++;
  }
  return { next: row + 1, header, first, last, widths };
}

function setWidths(ws, widths, col = 1) {
  widths.forEach((w, i) => { ws.getColumn(col + i).width = Math.max(9, Math.min(55, Math.ceil(w * 1.1) + 2)); });
}

function pageSetup(ws, headerRow, footer) {
  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 } };
  if (headerRow) ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
  ws.headerFooter = { oddFooter: `&L&8${footer}&R&8Página &P de &N` };
}

const KIT = { titleBand, sectionTitle, table, setWidths, fill, box, thin, C, STATUS_COLOR, MONEY_FMT, colLetter };

/**
 * sheets: [{ name, title?: string|string[], columns, rows, totals?, tabColor?, build?(ws, kit) }]
 * Con `build` la hoja se dibuja a medida; si no, título + tabla con filtros, totales y encabezado fijo.
 */
async function sendXlsx(res, filename, sheets) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema de cartera';
  wb.created = new Date();
  const stamp = new Date().toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
  const charts = [];
  sheets.forEach((sh, i) => { sh._index = i + 1; });
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31), { properties: { tabColor: { argb: s.tabColor || C.primary } }, views: [{ showGridLines: false }] });
    if (s.build) {
      const ref = `'${s.name.slice(0, 31).replace(/'/g, "''")}'`;
      s.build(ws, { ...KIT, ref, chart: (spec) => charts.push({ ...spec, sheet: s._index }) });
      pageSetup(ws, 0, `Cartera · ${s.name} · ${stamp}`);
      continue;
    }
    const lines = [].concat(s.title || []);
    const head = lines.length ? lines : [s.name];
    let row = titleBand(ws, 1, s.columns.length, head[0], head.slice(1).concat(lines.length ? [] : [`Generado el ${stamp}`]));
    const t = table(ws, row, 1, s);
    setWidths(ws, t.widths);
    if (s.rows.length) ws.autoFilter = { from: { row: t.header, column: 1 }, to: { row: t.last, column: s.columns.length } };
    ws.views = [{ state: 'frozen', ySplit: t.header, xSplit: s.freezeFirst ? 1 : 0, showGridLines: false }];
    pageSetup(ws, t.header, `Cartera · ${s.name} · ${stamp}`);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const buf = await wb.xlsx.writeBuffer();
  res.end(charts.length ? await addCharts(buf, charts, typeof window !== 'undefined') : buf);
}

function statementSheets(st) {
  const c = st.client;
  const title = [`Estado de cuenta — ${c.full_name} (${c.code})`, `Identificación: ${c.id_type} ${c.id_number} · Teléfono: ${c.phone || ''}`,
    `Generado: ${st.generated_at.split('-').reverse().join('/')} · ${st.business.business_name}`];
  const t = st.totals;
  return [
    {
      name: 'Resumen', title, totals: false,
      columns: [['Concepto', 'k', '', 'strong'], ['Valor', 'v', 'money']],
      rows: [
        { k: 'Capital total prestado', v: t.principal }, { k: 'Total contractual acordado', v: t.contract },
        { k: 'Total abonado a obligaciones', v: t.paid }, { k: 'Total recibido (pagos)', v: t.received },
        { k: 'Saldo contractual pendiente', v: t.contract_balance }, { k: 'Saldo de facturas pendientes', v: t.invoice_balance },
        { k: 'Valor de cuotas vencidas', v: t.overdue }, { k: 'Saldo a favor sin aplicar', v: t.credit_balance },
      ],
    },
    {
      name: 'Préstamos', title,
      columns: [['Préstamo', 'number'], ['Entrega', 'disbursed_at', 'date'], ['Capital', 'principal', 'money'], ['Interés', 'interest_mode'],
        ['Tasa %', 'interest_rate'], ['Total contractual', 'contract_due', 'money'], ['Cuotas', 'installments_count'], ['Valor cuota', 'installment_amount', 'money', 'nosum'],
        ['Frecuencia', 'frequency'], ['Fin previsto', 'end_date', 'date'], ['Abonado', 'paid_total', 'money'], ['Saldo contractual', 'contract_balance', 'money'],
        ['Vencido', 'overdue_balance', 'money'], ['Próximo pago', 'next_due_date', 'date'], ['Facturación', 'billing_mode'], ['Estado', 'status', 'status']],
      rows: st.loans,
    },
    {
      name: 'Cuotas',
      columns: [['Préstamo', 'loan_number'], ['Cuota', 'number'], ['Vence', 'due_date', 'date'], ['Programado', 'amount', 'money'], ['Abonado', 'paid', 'money'],
        ['Saldo', 'balance', 'money'], ['Factura', 'invoice_number'], ['Estado', 'computed_status', 'status'], ['Días mora', 'days_late']],
      rows: st.loans.flatMap((l) => l.installments.map((i) => ({ ...i, loan_number: l.number }))),
    },
    {
      name: 'Facturas',
      columns: [['Factura', 'number'], ['Préstamo', 'loan_number'], ['Periodo', 'period_label'], ['Emisión', 'issue_date', 'date'], ['Vence', 'due_date', 'date'],
        ['Importe', 'amount_due', 'money'], ['Abonos', 'paid', 'money'], ['Saldo', 'balance', 'money'], ['Estado', 'computed_status', 'status'], ['Días mora', 'days_late']],
      rows: st.invoices,
    },
    {
      name: 'Acumulados (consulta)',
      columns: [['Documento', 'number'], ['Préstamo', 'loan_number'], ['Emisión', 'issue_date', 'date'], ['Saldo anterior', 'prev_balance', 'money'],
        ['Nueva cuota', 'new_installment', 'money'], ['Total a la fecha', 'total_due', 'money'], ['Nota', () => 'Resumen informativo: no suma deuda nueva']],
      rows: st.accumulated,
    },
    {
      name: 'Pagos',
      columns: [['Recibo', 'receipt_number'], ['Fecha', 'paid_at', 'datetime'], ['Préstamo', 'loan_number'], ['Valor recibido', 'amount', 'money'],
        ['Aplicado', 'applied', 'money'], ['Saldo a favor', 'unapplied', 'money'], ['Método', 'method'], ['Referencia', 'reference'],
        ['Facturas', (p) => p.allocations.filter((a) => a.active).map((a) => `${a.invoice_number}: ${a.amount}`).join('; ')],
        ['Recibió', 'received_by'], ['Saldo después', 'balance_after', 'money', 'nosum'], ['Estado', 'status', 'status']],
      rows: st.payments,
    },
    {
      name: 'Movimientos',
      columns: [['Fecha', 'date', 'date'], ['Tipo', 'type'], ['Documento', 'doc'], ['Descripción', 'description'], ['Cargo', 'debit', 'money'],
        ['Abono', 'credit', 'money'], ['Saldo', 'balance', 'money', 'nosum']],
      rows: st.movements,
    },
  ];
}

module.exports = { sendXlsx, statementSheets, STATUS, KIT };
