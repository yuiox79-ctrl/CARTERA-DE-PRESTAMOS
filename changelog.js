'use strict';
// Registro de cambios: disparadores (triggers) que anotan qué filas se insertaron, modificaron o borraron.
// Lo usan los almacenes externos (Supabase y la página publicada) para enviar solo lo que cambió.

const { db } = require('./db');

/** tables: { tabla: claveprimaria } */
function installChangeLog(tables) {
  db.exec('CREATE TABLE IF NOT EXISTS _changes (tbl TEXT NOT NULL, pk ANY NOT NULL, PRIMARY KEY (tbl, pk)) WITHOUT ROWID');
  for (const [t, pk] of Object.entries(tables)) {
    for (const [ev, ref] of [['INSERT', 'NEW'], ['UPDATE', 'NEW'], ['DELETE', 'OLD']]) {
      // Sin "OR IGNORE": un INSERT ... ON CONFLICT externo anularía esa cláusula; se evita el duplicado con NOT EXISTS.
      db.exec(`CREATE TRIGGER IF NOT EXISTS _sync_${t}_${ev.toLowerCase()} AFTER ${ev} ON ${t}
        BEGIN INSERT INTO _changes(tbl, pk) SELECT '${t}', ${ref}.${pk}
          WHERE NOT EXISTS (SELECT 1 FROM _changes WHERE tbl = '${t}' AND pk = ${ref}.${pk}); END`);
    }
    // Si cambia la clave primaria, también hay que borrar la anterior.
    db.exec(`CREATE TRIGGER IF NOT EXISTS _sync_${t}_pk AFTER UPDATE OF ${pk} ON ${t}
      BEGIN INSERT INTO _changes(tbl, pk) SELECT '${t}', OLD.${pk}
        WHERE NOT EXISTS (SELECT 1 FROM _changes WHERE tbl = '${t}' AND pk = OLD.${pk}); END`);
  }
}

/** Cambios pendientes agrupados: [{ table, pk, row | null }] (row null = borrado). */
function pendingChanges(tables) {
  const list = db.prepare('SELECT tbl, pk FROM _changes').all();
  const stmts = {};
  return list.map(({ tbl, pk }) => {
    stmts[tbl] = stmts[tbl] || db.prepare(`SELECT * FROM ${tbl} WHERE ${tables[tbl]} = ?`);
    return { table: tbl, pk, row: stmts[tbl].get(pk) || null };
  });
}

function clearChanges(list) {
  const del = db.prepare('DELETE FROM _changes WHERE tbl = ? AND pk = ?');
  db.transaction(() => { for (const c of list) del.run(c.table, c.pk); })();
}

/** Toma los cambios pendientes y los quita de la lista. Si el envío falla, devuélvalos con restoreChanges.
 *  Así, si una fila vuelve a cambiar mientras se envía, queda anotada de nuevo y no se pierde. */
function takeChanges(tables) {
  return db.transaction(() => { const list = pendingChanges(tables); clearChanges(list); return list; })();
}
function restoreChanges(list) {
  const ins = db.prepare('INSERT OR IGNORE INTO _changes(tbl, pk) VALUES (?, ?)');
  db.transaction(() => { for (const c of list) ins.run(c.table, c.pk); })();
}

function markChanged(table, pk) { db.prepare('INSERT OR IGNORE INTO _changes(tbl, pk) VALUES (?, ?)').run(table, pk); }

function pendingCount() {
  try { return db.prepare('SELECT COUNT(*) n FROM _changes').get().n; } catch { return 0; }
}

module.exports = { installChangeLog, pendingChanges, clearChanges, takeChanges, restoreChanges, markChanged, pendingCount };
