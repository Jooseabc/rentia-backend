import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { hashPassword, verifyPassword, signToken } from '../lib/auth.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { recordAudit } from '../lib/audit.js';

const router = Router();

const registerSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(6, 'Mínimo 6 caracteres'),
  name: z.string().min(1).trim(),
  // Opcional: requerido sólo si ya existen usuarios. El primer admin se crea sin código.
  invitation_code: z.string().trim().min(8).max(64).optional(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1),
});

// POST /api/auth/register
// - Si NO hay usuarios → crea admin (bootstrap), no requiere código
// - Si ya hay usuarios → requiere invitation_code válido y vigente
router.post('/register', validate(registerSchema), async (req, res) => {
  const { email, password, name, invitation_code } = req.body;
  try {
    const exists = await query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (exists.rowCount > 0)
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const countRes = await query('SELECT COUNT(*)::int AS c FROM users');
    const isFirstUser = countRes.rows[0].c === 0;

    let role = 'user';
    let invitation = null;

    if (isFirstUser) {
      // Bootstrap: el primer usuario es admin, sin código
      role = 'admin';
    } else {
      if (!invitation_code) {
        return res.status(403).json({ error: 'Necesitas un código de invitación para registrarte' });
      }
      const inv = await query(
        `SELECT id, email, role, expires_at, used_at
           FROM invitations
          WHERE code = $1
          LIMIT 1`,
        [invitation_code]
      );
      if (inv.rowCount === 0) {
        return res.status(403).json({ error: 'Código de invitación inválido' });
      }
      invitation = inv.rows[0];
      if (invitation.used_at) {
        return res.status(403).json({ error: 'Este código ya fue utilizado' });
      }
      if (new Date(invitation.expires_at) < new Date()) {
        return res.status(403).json({ error: 'Este código de invitación ha expirado' });
      }
      // Si la invitación es para un email específico, debe coincidir
      if (invitation.email && invitation.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(403).json({ error: 'Este código no es para este correo' });
      }
      role = invitation.role || 'user';
    }

    const passwordHash = await hashPassword(password);
    const r = await query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, created_at`,
      [email, passwordHash, name, role]
    );
    const user = r.rows[0];

    // Marca la invitación como usada
    if (invitation) {
      await query(
        `UPDATE invitations SET used_at = now(), used_by = $1 WHERE id = $2`,
        [user.id, invitation.id]
      );
    }

    await recordAudit({
      req, action: 'register', entity: 'user', entityId: user.id,
      details: { email, role, via_invitation: !!invitation, bootstrap: isFirstUser },
    });

    const token = signToken({ id: user.id, email: user.email, name: user.name, role: user.role });
    res.json({ user, token });
  } catch (err) {
    console.error('[auth/register]', err);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
});

// POST /api/auth/login
router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await query(
      'SELECT id, email, password_hash, name, role FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (r.rowCount === 0)
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    const user = r.rows[0];
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    const token = signToken({ id: user.id, email: user.email, name: user.name, role: user.role });
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      token,
    });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /api/auth/registration-status
// Endpoint público: dice si todavía falta el bootstrap (primer usuario).
// El frontend lo usa para mostrar "Crear primer admin" sin pedir código.
router.get('/registration-status', async (_req, res) => {
  const r = await query('SELECT COUNT(*)::int AS c FROM users');
  res.json({ needs_bootstrap: r.rows[0].c === 0 });
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const r = await query('SELECT id, email, name, role FROM users WHERE id = $1', [req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: r.rows[0] });
});

// GET /api/auth/users (admin)
router.get('/users', requireAuth, requireAdmin, async (_req, res) => {
  const r = await query('SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC');
  res.json({ users: r.rows });
});

// DELETE /api/auth/users/:id (admin)
router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
  const r = await query('DELETE FROM users WHERE id = $1 RETURNING email', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  await recordAudit({ req, action: 'delete', entity: 'user', entityId: req.params.id, details: { email: r.rows[0].email } });
  res.json({ ok: true });
});

// POST /api/auth/change-password
const changePwdSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});
router.post('/change-password', requireAuth, validate(changePwdSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const r = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  const ok = await verifyPassword(currentPassword, r.rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  const newHash = await hashPassword(newPassword);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);
  res.json({ ok: true });
});

// GET /api/auth/audit-log (admin)
router.get('/audit-log', requireAuth, requireAdmin, async (req, res) => {
  const entity = req.query.entity ? String(req.query.entity).slice(0, 40) : null;
  const sql = entity
    ? `SELECT id, actor_email, action, entity, entity_id, details, ip, created_at
         FROM audit_log WHERE entity = $1 ORDER BY created_at DESC LIMIT 200`
    : `SELECT id, actor_email, action, entity, entity_id, details, ip, created_at
         FROM audit_log ORDER BY created_at DESC LIMIT 200`;
  const params = entity ? [entity] : [];
  const r = await query(sql, params);
  res.json({ events: r.rows });
});

// ========================================================================
// INVITACIONES (admin)
// ========================================================================
const invitationSchema = z.object({
  email: z.string().email().toLowerCase().trim().optional().or(z.literal('')),
  role: z.enum(['admin', 'user']).optional().default('user'),
  expires_in_days: z.coerce.number().int().min(1).max(60).optional().default(7),
  notes: z.string().max(200).optional().nullable(),
});

// GET /api/auth/invitations (admin) — lista las últimas 100
router.get('/invitations', requireAuth, requireAdmin, async (_req, res) => {
  const r = await query(
    `SELECT i.id, i.code, i.email, i.role, i.created_at, i.expires_at,
            i.used_at, i.notes,
            cu.email AS created_by_email,
            uu.email AS used_by_email
       FROM invitations i
  LEFT JOIN users cu ON cu.id = i.created_by
  LEFT JOIN users uu ON uu.id = i.used_by
      ORDER BY i.created_at DESC
      LIMIT 100`
  );
  res.json({ invitations: r.rows });
});

// POST /api/auth/invitations (admin) — genera un nuevo código
router.post('/invitations', requireAuth, requireAdmin, validate(invitationSchema), async (req, res) => {
  const { email, role, expires_in_days, notes } = req.body;
  // Código aleatorio URL-safe, 32 caracteres hex (16 bytes de entropía)
  const code = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000);

  const r = await query(
    `INSERT INTO invitations (code, email, role, created_by, expires_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, code, email, role, created_at, expires_at, notes`,
    [code, email || null, role, req.user.id, expiresAt, notes || null]
  );
  await recordAudit({
    req, action: 'create', entity: 'invitation', entityId: r.rows[0].id,
    details: { email: email || null, role, expires_in_days },
  });
  res.json({ invitation: r.rows[0] });
});

// DELETE /api/auth/invitations/:id (admin) — revoca una invitación no usada
router.delete('/invitations/:id', requireAuth, requireAdmin, async (req, res) => {
  const r = await query(
    `DELETE FROM invitations WHERE id = $1 AND used_at IS NULL RETURNING id`,
    [req.params.id]
  );
  if (r.rowCount === 0)
    return res.status(404).json({ error: 'Invitación no encontrada o ya utilizada' });
  await recordAudit({ req, action: 'delete', entity: 'invitation', entityId: req.params.id });
  res.json({ ok: true });
});

export default router;
