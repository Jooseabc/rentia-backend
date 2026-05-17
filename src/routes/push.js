import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { pushEnabled, getPublicKey, sendToUser } from '../lib/push.js';

const router = Router();

// GET /api/push/vapid-public-key — el cliente la usa para suscribirse.
router.get('/vapid-public-key', (_req, res) => {
  if (!pushEnabled()) return res.status(503).json({ error: 'Web Push no configurado en el servidor' });
  res.json({ publicKey: getPublicKey() });
});

const subSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth:   z.string().min(1),
  }),
  userAgent: z.string().max(300).optional(),
});

// POST /api/push/subscribe — guarda (o reemplaza) una suscripción del dispositivo.
router.post('/subscribe', requireAuth, validate(subSchema), async (req, res) => {
  if (!pushEnabled()) return res.status(503).json({ error: 'Web Push no configurado' });
  const { endpoint, keys, userAgent } = req.body;
  try {
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [req.user.id, endpoint, keys.p256dh, keys.auth, userAgent || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/subscribe]', err);
    res.status(500).json({ error: 'No se pudo guardar la suscripción' });
  }
});

// POST /api/push/unsubscribe — quita una suscripción específica del dispositivo.
router.post('/unsubscribe', requireAuth, async (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  await query(
    'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [req.user.id, endpoint]
  );
  res.json({ ok: true });
});

// POST /api/push/test — envía una notificación de prueba a todas las subs del usuario.
router.post('/test', requireAuth, async (req, res) => {
  if (!pushEnabled()) return res.status(503).json({ error: 'Web Push no configurado' });
  const sent = await sendToUser(req.user.id, {
    title: 'Rentia',
    body:  'Notificaciones activas. Te avisaremos cuando un pago venza o quede atrasado.',
    tag:   'rentia-test',
    url:   '/',
  });
  res.json({ ok: true, sent });
});

export default router;
