import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { hashPassword, verifyPassword, signToken } from '../lib/auth.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { recordAudit } from '../lib/audit.js';
import { mailEnabled, sendMail } from '../lib/mail.js';

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

function buildWelcomeEmail(name) {
  const firstName = name.split(' ')[0];
  const subject = '¡Bienvenido a Rentia! Tu prueba gratuita ha comenzado';
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f4efe3">
      <div style="background:#fff;border-radius:16px;padding:32px">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;background:#064e3b;color:#fde68a;border-radius:10px;font-weight:700;letter-spacing:.5px">R</div>
        <h1 style="font-family:Georgia,serif;color:#1c1917;margin:24px 0 8px;font-size:24px">
          ¡Bienvenido a Rentia, ${firstName}!
        </h1>
        <p style="color:#57534e;line-height:1.6;margin:0 0 24px">
          Tu cuenta está lista. Tienes <strong>30 días de prueba gratuita</strong> en el plan Starter para que explores todo lo que Rentia puede hacer por ti.
        </p>
        <div style="background:#fafaf9;border-radius:12px;padding:20px;margin-bottom:24px">
          <table style="width:100%;color:#1c1917;font-size:14px">
            <tr><td style="padding:6px 0;color:#78716c">Plan actual</td><td style="text-align:right;font-weight:600">Starter (prueba gratuita)</td></tr>
            <tr><td style="padding:6px 0;color:#78716c">Propiedades incluidas</td><td style="text-align:right;font-weight:600">Hasta 3</td></tr>
            <tr><td style="padding:6px 0;color:#78716c">Prueba gratis hasta</td><td style="text-align:right;font-weight:600">30 días desde hoy</td></tr>
          </table>
        </div>
        <p style="color:#57534e;font-size:14px;margin:0">
          Cuando quieras ampliar tu plan, escríbenos y te ayudamos.
        </p>
        <p style="color:#a8a29e;font-size:12px;margin-top:32px;text-align:center">
          Rentia · este es un mensaje automático
        </p>
      </div>
    </div>`;
  return { subject, html };
}

// POST /api/auth/register — registro público, cualquier persona puede crear cuenta
router.post('/register', validate(registerSchema), async (req, res) => {
  const { email, password, name } = req.body;
  try {
    const exists = await query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (exists.rowCount > 0)
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });

    const passwordHash = await hashPassword(password);
    const r = await query(
      `INSERT INTO users (email, password_hash, name, role, plan, trial_ends_at)
       VALUES ($1, $2, $3, 'user', 'starter', NOW() + INTERVAL '30 days')
       RETURNING id, email, name, role, plan, trial_ends_at, created_at`,
      [email, passwordHash, name]
    );
    const user = r.rows[0];

    await recordAudit({
      req, action: 'register', entity: 'user', entityId: user.id,
      details: { email, role: 'user', plan: 'starter' },
    });

    if (mailEnabled()) {
      const { subject, html } = buildWelcomeEmail(name);
      sendMail({ to: email, subject, html }).catch((err) =>
        console.error('[auth/register] Error enviando bienvenida:', err.message)
      );
    }

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
      'SELECT id, email, password_hash, name, role, plan, trial_ends_at FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    if (r.rowCount === 0)
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    const user = r.rows[0];
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    const token = signToken({ id: user.id, email: user.email, name: user.name, role: user.role });
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, plan: user.plan, trial_ends_at: user.trial_ends_at },
      token,
    });
  } catch (err) {
    console.error('[auth/login]', err);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const r = await query(
    'SELECT id, email, name, role, plan, trial_ends_at, plan_expires_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user: r.rows[0] });
});

// GET /api/auth/users (admin)
router.get('/users', requireAuth, requireAdmin, async (_req, res) => {
  const r = await query(
    'SELECT id, email, name, role, plan, trial_ends_at, created_at FROM users ORDER BY created_at ASC'
  );
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

export default router;
