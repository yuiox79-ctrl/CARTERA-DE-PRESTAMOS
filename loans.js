'use strict';
// Cálculo de préstamos: total contractual, valor de cuotas, calendario y tasa efectiva implícita.
// El sistema NO asume tasas: si no se pacta interés, el total contractual es igual al capital.

const { addDays, addMonthsWithDay, parseISO, HttpError, toInt, reqDate, diffDays } = require('./util');

const FREQ_DAYS = { diaria: 1, semanal: 7, quincenal: 15, mensual: 30 };

function periodDays(frequency, customDays) {
  if (frequency === 'personalizada') return customDays;
  return FREQ_DAYS[frequency];
}

/** Fechas de vencimiento de las cuotas. */
function buildDueDates({ frequency, first_due_date, installments_count, payment_day, custom_days, day_rule }) {
  const dates = [];
  for (let k = 0; k < installments_count; k++) {
    let d;
    switch (frequency) {
      case 'diaria': d = addDays(first_due_date, k); break;
      case 'semanal': d = addDays(first_due_date, 7 * k); break;
      case 'quincenal': d = addDays(first_due_date, 15 * k); break;
      case 'mensual': d = addMonthsWithDay(first_due_date, k, payment_day, day_rule); break;
      case 'personalizada': d = addDays(first_due_date, custom_days * k); break;
      default: throw new HttpError(400, 'Frecuencia de pago no válida.');
    }
    dates.push(d);
  }
  return dates;
}

/** Reparte un total en n cuotas enteras; la última cuota absorbe el redondeo. */
function splitAmounts(total, n, fixed) {
  const base = fixed || Math.round(total / n);
  const out = Array(n).fill(base);
  out[n - 1] = total - base * (n - 1);
  if (out[n - 1] <= 0) throw new HttpError(400, 'El valor de cuota indicado no es coherente con el total contractual.');
  return out;
}

/** Tasa efectiva anual implícita (TIR) del flujo: desembolso vs. cuotas. */
function impliedEA(principal, disbursedAt, schedule) {
  const flows = schedule.map((s) => ({ t: diffDays(s.due_date, disbursedAt) / 365, v: s.amount }));
  const total = flows.reduce((a, f) => a + f.v, 0);
  if (total <= principal) return 0;
  const npv = (r) => flows.reduce((a, f) => a + f.v / Math.pow(1 + r, Math.max(f.t, 1 / 365)), 0) - principal;
  let lo = 0, hi = 1;
  while (npv(hi) > 0 && hi < 1e9) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) lo = mid; else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 100 * 100) / 100; // % con 2 decimales
}

/**
 * Valida la entrada del formulario y calcula condiciones + calendario.
 * interest_rate siempre es % MENSUAL pactado (cuando aplica), salvo simple_total (% sobre el total del plazo).
 */
function computeLoan(input, settings) {
  const principal = toInt(input.principal, 'Capital prestado', { min: 1 });
  const installments_count = toInt(input.installments_count, 'Número de cuotas', { min: 1 });
  if (installments_count > 1000) throw new HttpError(400, 'El número de cuotas es demasiado alto (máximo 1000).');
  const frequency = input.frequency;
  if (!['diaria', 'semanal', 'quincenal', 'mensual', 'personalizada'].includes(frequency)) throw new HttpError(400, 'Frecuencia de pago no válida.');
  const custom_days = frequency === 'personalizada' ? toInt(input.custom_days, 'Días entre cuotas', { min: 1 }) : null;
  const disbursed_at = reqDate(input.disbursed_at, 'Fecha de entrega del dinero');
  const start_date = reqDate(input.start_date || disbursed_at, 'Fecha de inicio');
  const first_due_date = reqDate(input.first_due_date, 'Fecha de la primera cuota');
  if (first_due_date < disbursed_at) throw new HttpError(400, 'La primera cuota no puede ser anterior a la entrega del dinero.');
  const day_rule = ['ultimo_dia', 'primer_dia_siguiente'].includes(input.day_rule) ? input.day_rule : (settings.day_rule || 'ultimo_dia');
  let payment_day = null;
  if (frequency === 'mensual') {
    payment_day = input.payment_day ? toInt(input.payment_day, 'Día de pago', { min: 1 }) : parseISO(first_due_date).d;
    if (payment_day > 31) throw new HttpError(400, 'El día de pago debe estar entre 1 y 31.');
  }

  const interest_mode = input.interest_mode || 'sin_interes';
  let rate = input.interest_rate === '' || input.interest_rate == null ? null : Number(input.interest_rate);
  if (rate != null && (!Number.isFinite(rate) || rate < 0)) throw new HttpError(400, 'La tasa de interés debe ser un número positivo.');
  const pdays = periodDays(frequency, custom_days);
  const months = (installments_count * pdays) / 30;

  let total_contract;
  let fixedInstallment = null;
  switch (interest_mode) {
    case 'sin_interes':
      rate = null;
      total_contract = principal;
      break;
    case 'simple_total':
      if (rate == null) throw new HttpError(400, 'Indique la tasa pactada sobre el total del préstamo.');
      total_contract = Math.round(principal * (1 + rate / 100));
      break;
    case 'simple_mensual':
      if (rate == null) throw new HttpError(400, 'Indique la tasa mensual pactada.');
      total_contract = Math.round(principal * (1 + (rate / 100) * months));
      break;
    case 'cuota_fija': {
      if (rate == null) throw new HttpError(400, 'Indique la tasa mensual pactada.');
      const i = Math.pow(1 + rate / 100, pdays / 30) - 1; // tasa equivalente por periodo
      const n = installments_count;
      fixedInstallment = i === 0 ? Math.round(principal / n) : Math.round((principal * i) / (1 - Math.pow(1 + i, -n)));
      total_contract = fixedInstallment * n;
      break;
    }
    case 'manual':
      total_contract = toInt(input.total_contract, 'Total contractual acordado', { min: 1 });
      if (total_contract < principal) throw new HttpError(400, 'El total contractual no puede ser menor que el capital prestado.');
      break;
    default:
      throw new HttpError(400, 'Modalidad de interés no válida.');
  }

  // Valor de cuota opcional indicado por el usuario (solo en modo manual)
  if (interest_mode === 'manual' && input.installment_amount) {
    fixedInstallment = toInt(input.installment_amount, 'Valor de cada cuota', { min: 1 });
  }

  const dates = buildDueDates({ frequency, first_due_date, installments_count, payment_day, custom_days, day_rule });
  const amounts = splitAmounts(total_contract, installments_count, fixedInstallment);
  const schedule = dates.map((due_date, k) => ({ number: k + 1, due_date, amount: amounts[k] }));
  const implied_ea = impliedEA(principal, disbursed_at, schedule);

  const warnings = [];
  const usury = Number(settings.usury_rate_ea);
  if (settings.usury_rate_ea && Number.isFinite(usury) && usury > 0 && implied_ea > usury) {
    throw new HttpError(400, `La tasa efectiva anual implícita (${implied_ea.toFixed(2)} % E.A.) supera la tasa de usura registrada en Configuración (${usury} % E.A.). Revise las condiciones pactadas.`);
  }
  if (!settings.usury_rate_ea && implied_ea > 0) {
    warnings.push('No hay tasa de usura registrada en Configuración; el sistema no puede verificar el límite legal de la tasa.');
  }

  return {
    principal, interest_mode, interest_rate: rate, total_contract, installments_count,
    installment_amount: amounts[0], frequency, custom_days, start_date, disbursed_at, first_due_date,
    payment_day, day_rule, end_date: dates[dates.length - 1], implied_ea, schedule, warnings,
    interest_total: total_contract - principal,
  };
}

/** Recalcula las cuotas restantes (reprogramación) para un saldo dado. */
function computeReschedule({ amount, installments_count, frequency, first_due_date, payment_day, custom_days, day_rule }) {
  const n = toInt(installments_count, 'Número de cuotas', { min: 1 });
  if (!['diaria', 'semanal', 'quincenal', 'mensual', 'personalizada'].includes(frequency)) throw new HttpError(400, 'Frecuencia de pago no válida.');
  reqDate(first_due_date, 'Fecha de la primera cuota');
  const cd = frequency === 'personalizada' ? toInt(custom_days, 'Días entre cuotas', { min: 1 }) : null;
  const pd = frequency === 'mensual' ? (payment_day ? toInt(payment_day, 'Día de pago', { min: 1 }) : parseISO(first_due_date).d) : null;
  const dates = buildDueDates({ frequency, first_due_date, installments_count: n, payment_day: pd, custom_days: cd, day_rule });
  const amounts = splitAmounts(amount, n);
  return { schedule: dates.map((d, k) => ({ due_date: d, amount: amounts[k] })), payment_day: pd, custom_days: cd };
}

module.exports = { computeLoan, computeReschedule, buildDueDates, periodDays };
