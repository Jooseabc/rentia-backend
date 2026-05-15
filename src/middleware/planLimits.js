import { query } from '../lib/db.js';

const PLAN_LIMITS = {
  starter:  { properties: 3 },
  pro:      { properties: 15 },
  business: { properties: Infinity },
};

// Verifica si el usuario puede crear una propiedad adicional según su plan.
// Usar después de requireAuth en la ruta POST /api/properties.
export async function checkPropertyLimit(req, res, next) {
  try {
    const userRes = await query(
      'SELECT plan, trial_ends_at, plan_expires_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (userRes.rowCount === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
    const { plan, trial_ends_at, plan_expires_at } = userRes.rows[0];

    // Plan inactivo (trial vencido y sin plan_expires_at vigente): bloquear
    const trialActive = trial_ends_at && new Date(trial_ends_at) > new Date();
    const planActive = plan_expires_at && new Date(plan_expires_at) > new Date();
    if (!trialActive && !planActive && plan === 'starter') {
      return res.status(402).json({
        error: 'Tu periodo de prueba ha vencido. Actualiza tu plan para continuar.',
        code: 'TRIAL_EXPIRED',
      });
    }

    const limit = (PLAN_LIMITS[plan] ?? PLAN_LIMITS.starter).properties;
    if (limit === Infinity) return next();

    const countRes = await query(
      'SELECT COUNT(*)::int AS c FROM properties WHERE owner_id = $1',
      [req.user.id]
    );
    if (countRes.rows[0].c >= limit) {
      return res.status(402).json({
        error: `Tu plan ${plan} permite hasta ${limit} propiedad(es). Actualiza tu plan para agregar más.`,
        code: 'PLAN_LIMIT_REACHED',
        limit,
        current: countRes.rows[0].c,
      });
    }

    next();
  } catch (err) {
    console.error('[planLimits]', err);
    res.status(500).json({ error: 'Error al verificar límites del plan' });
  }
}
