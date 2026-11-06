'use strict';
// Memoria de resultados pesados. Se descarta sola cuando cambia cualquier dato:
// SQLite cuenta todas las escrituras de la conexión (total_changes), y esa cifra es la "versión" de los datos.

const { db } = require('./db');

let version = -1;
const store = new Map();

function cached(key, fn) {
  const v = db.prepare('SELECT total_changes() AS v').get().v;
  if (v !== version) { version = v; store.clear(); }
  if (!store.has(key)) store.set(key, fn());
  return store.get(key);
}

module.exports = { cached };
