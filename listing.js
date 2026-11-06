'use strict';
// Filtrado, búsqueda, orden y paginación en memoria sobre listados ya calculados (y guardados en caché).
// Así escribir en el buscador, cambiar de filtro o de página responde al instante.

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
const fold = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Busca q (sin importar mayúsculas ni tildes) en los campos indicados. */
function search(rows, q, fields) {
  const needle = fold(String(q || '').trim());
  if (!needle) return rows;
  return rows.filter((r) => fields.some((f) => fold(r[f]).includes(needle)));
}

/** Ordena por una función que devuelve el valor de cada fila; desempata por id. */
function sortRows(rows, getter, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = getter(a), y = getter(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x ?? ''), String(y ?? ''));
    return c ? c * sign : (a.id - b.id) * sign;
  });
}

function paginate(rows, query, defSize = 20) {
  const size = Math.min(Math.max(Number(query.size) || defSize, 5), 200);
  const page = Math.max(Number(query.page) || 1, 1);
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length, page, size };
}

module.exports = { search, sortRows, paginate, fold };
