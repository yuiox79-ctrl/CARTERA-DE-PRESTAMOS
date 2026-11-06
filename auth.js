'use strict';
// Autenticación por sesión (cookie httpOnly) y control de permisos por rol.

const crypto = require('crypto');
const { db, verifyPassword, audit } = require('./db');
const { HttpError } = require('./util');

const SESSION_HOURS = 12;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row || !row.active || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, username: row.username, name: row.name, role: row.role, token };
}

function login(req, res) {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!u || !u.active || !verifyPassword(String(password || ''), u.password_hash)) {
    throw new HttpError(401, 'Usuario o contraseña incorrectos.');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)').run(token, u.id, expires);
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  audit(u.id, { entity: 'usuario', entityId: u.id, action: 'login', summary: `Inicio de sesión de ${u.username}` });
  res.json({ id: u.id, username: u.username, name: u.name, role: u.role });
}

function logout(req, res) {
  const u = sessionUser(req);
  if (u) db.prepare('DELETE FROM sessions WHERE token = ?').run(u.token);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
}

/** Exige sesión. Las peticiones que modifican datos deben ser JSON (protección CSRF adicional). */
function requireAuth(req, res, next) {
  const u = sessionUser(req);
  if (!u) return next(new HttpError(401, 'Su sesión expiró. Inicie sesión nuevamente.'));
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
  if (!['GET', 'HEAD'].includes(req.method) && hasBody && !req.is('application/json')) {
    return next(new HttpError(415, 'Formato de solicitud no permitido.'));
  }
  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return next(new HttpError(403, 'Esta operación solo puede realizarla un administrador.'));
  next();
}

module.exports = { login, logout, requireAuth, requireAdmin, sessionUser };
