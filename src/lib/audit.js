import { query } from './db.js';

// Registra una acción en audit_log. No tira si falla, sólo loguea: nunca debe
// tumbar la operación principal por un error de auditoría.
export async function recordAudit({ req, action, entity, entityId, details = null }) {
  try {
    const actorId = req?.user?.id || null;
    const actorEmail = req?.user?.email || null;
    const ip = req?.ip || req?.headers?.['x-forwarded-for'] || null;
    await query(
      `INSERT INTO audit_log (actor_id, actor_email, action, entity, entity_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        actorId,
        actorEmail,
        action,
        entity,
        entityId != null ? String(entityId) : null,
        details ? JSON.stringify(details) : null,
        ip ? String(ip).slice(0, 64) : null,
      ]
    );
  } catch (err) {
    console.error('[audit] no se pudo registrar', { action, entity, entityId, err: err.message });
  }
}
