import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { hashPassword, verifyPassword, signToken } from '../lib/auth.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

const registerSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(6, 'Mínimo 6 caracteres'),
  name: z.string().min(1).trim(),
});

const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1),
});

// POST /api/auth/register
router.post('/register', validate(registerSchema), async (req, res) => {
  const { email, password, name } = req.body;
  try {
    const exists = await query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (exists.rowCount > 0)
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const countRes = await query('SELECT COUNT(*)::int AS c FROM users');
    const role = countRes.rows[0].c === 0 ? 'admin' : 'user';
    const passwordHash = await hashPassword(password);
    const r = await query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, created_at`,
      [email, passwordHash, name, role]
    );
    const user = r.rows[0];
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

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const r = await query('SELECT id, email, name, role FROM users WHERE id = $1', [req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: r.rows[0] });
});

// GET /api/auth/users (admin)
router.get('/users', requireAuth, async (_req, res) => {
  const r = await query('SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC');
  res.json({ users: r.rows });
});

// DELETE /api/auth/users/:id (admin)
router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
  await query('DELETE FROM users WHERE id = $1', [req.params.id]);
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

export default router;
