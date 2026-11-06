'use strict';
// Guarda textos grandes (copias de seguridad, elementos de la papelera) en trozos de tamaño fijo.
// Así ninguna fila supera los límites del almacenamiento de la página publicada ni de la sincronización.

const { db } = require('./db');

const CHUNK = 90000; // caracteres por trozo

function putBlob(owner, text) {
  db.prepare('DELETE FROM blob_chunks WHERE owner = ?').run(owner);
  const ins = db.prepare('INSERT INTO blob_chunks(owner, seq, data) VALUES (?,?,?)');
  for (let i = 0, seq = 0; i < text.length || seq === 0; i += CHUNK, seq++) ins.run(owner, seq, text.slice(i, i + CHUNK));
  return text.length;
}

function getBlob(owner) {
  const rows = db.prepare('SELECT data FROM blob_chunks WHERE owner = ? ORDER BY seq').all(owner);
  return rows.length ? rows.map((r) => r.data).join('') : null;
}

function deleteBlob(owner) { db.prepare('DELETE FROM blob_chunks WHERE owner = ?').run(owner); }

module.exports = { putBlob, getBlob, deleteBlob };
