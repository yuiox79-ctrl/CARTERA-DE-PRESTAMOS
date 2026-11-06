'use strict';
// Utilidades de fechas (zona horaria de Colombia), dinero y errores.

const TZ = 'America/Bogota';

/** Fecha actual en Colombia como 'AAAA-MM-DD'. Se puede simular con FECHA_SIMULADA. */
function today() {
  if (process.env.FECHA_SIMULADA) return process.env.FECHA_SIMULADA;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Fecha y hora actual en Colombia como 'AAAA-MM-DD HH:MM:SS'. */
function now() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, p) => ((a[p.type] = p.value), a), {});
  const h = parts.hour === '24' ? '00' : parts.hour;
  const date = process.env.FECHA_SIMULADA || `${parts.year}-${parts.month}-${parts.day}`;
  return `${date} ${h}:${parts.minute}:${parts.second}`;
}

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

function isValidDate(s) { return parseISO(s) !== null; }

function addDays(s, n) {
  const p = parseISO(s);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/**
 * Suma meses respetando el día de pago. Si el día no existe en el mes destino:
 *  - 'ultimo_dia': usa el último día de ese mes (31 -> 28/29 feb).
 *  - 'primer_dia_siguiente': pasa al primer día del mes siguiente.
 */
function addMonthsWithDay(s, months, payDay, rule) {
  const p = parseISO(s);
  let y = p.y, m = p.m + months;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  const dim = daysInMonth(y, m);
  if (payDay <= dim) return isoDate(y, m, payDay);
  if (rule === 'primer_dia_siguiente') return addDays(isoDate(y, m, dim), 1);
  return isoDate(y, m, dim);
}

/** Suma minutos a 'AAAA-MM-DD HH:MM:SS' (hora de Colombia, sin horario de verano). */
function addMinutes(dt, mins) {
  const d = new Date(dt.replace(' ', 'T') + 'Z');
  return new Date(d.getTime() + mins * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

function diffDays(a, b) {
  const pa = parseISO(a), pb = parseISO(b);
  return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86400000);
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MESES[m - 1]} ${y}`;
}

function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function fmtCOP(n) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.round(n || 0));
}

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function toInt(v, name, { min = 0, allowNull = false } = {}) {
  if ((v === null || v === undefined || v === '') && allowNull) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n) throw new HttpError(400, `El campo "${name}" debe ser un número entero.`);
  if (n < min) throw new HttpError(400, `El campo "${name}" debe ser mayor o igual a ${min}.`);
  return n;
}

function reqStr(v, name, max = 300) {
  const s = String(v ?? '').trim();
  if (!s) throw new HttpError(400, `El campo "${name}" es obligatorio.`);
  if (s.length > max) throw new HttpError(400, `El campo "${name}" es demasiado largo.`);
  return s;
}

function optStr(v, max = 2000) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

function reqDate(v, name) {
  if (!isValidDate(v)) throw new HttpError(400, `El campo "${name}" debe ser una fecha válida.`);
  return v;
}

module.exports = {
  today, now, parseISO, isValidDate, addDays, addMinutes, addMonthsWithDay, diffDays, daysInMonth,
  monthLabel, fmtDate, fmtCOP, HttpError, toInt, reqStr, optStr, reqDate, MESES, pad,
};
