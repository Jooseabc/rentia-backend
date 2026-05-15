import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit } from '../lib/audit.js';
import { checkPropertyLimit } from '../middleware/planLimits.js';

const router = Router();
router.use(requireAuth);

// ============== PROPIEDADES ==============
const propSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional().nullable(),
  type: z.string().optional().default('Edificio'),
  notes: z.string().optional().nullable(),
});

router.get('/', async (req, res) => {
  const r = await query(`
    SELECT p.*,
      COALESCE((SELECT COUNT(*) FROM units u WHERE u.property_id = p.id), 0)::int AS units_count,
      COALESCE((
        SELECT COUNT(*) FROM units u
        JOIN tenants t ON t.unit_id = u.id AND t.status='active'
        WHERE u.property_id = p.id
      ), 0)::int AS occupied_count
    FROM properties p
    WHERE p.owner_id = $1
    ORDER BY p.name
  `, [req.user.id]);
  res.json({ properties: r.rows });
});

router.post('/', checkPropertyLimit, validate(propSchema), async (req, res) => {
  const { name, address, type, notes } = req.body;
  const r = await query(
    `INSERT INTO properties (name, address, type, notes, created_by, owner_id)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
    [name, address || null, type, notes || null, req.user.id]
  );
  await recordAudit({ req, action: 'create', entity: 'property', entityId: r.rows[0].id, details: { name } });
  res.json({ property: r.rows[0] });
});

router.put('/:id', validate(propSchema), async (req, res) => {
  const { name, address, type, notes } = req.body;
  const r = await query(
    `UPDATE properties SET name=$1, address=$2, type=$3, notes=$4
     WHERE id=$5 AND owner_id=$6 RETURNING *`,
    [name, address || null, type, notes || null, req.params.id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Propiedad no encontrada' });
  await recordAudit({ req, action: 'update', entity: 'property', entityId: req.params.id });
  res.json({ property: r.rows[0] });
});

router.delete('/:id', async (req, res) => {
  const check = await query(
    `SELECT COUNT(*)::int AS c FROM tenants t
     JOIN units u ON u.id = t.unit_id
     WHERE u.property_id = $1 AND t.status = 'active'`,
    [req.params.id]
  );
  if (check.rows[0].c > 0)
    return res.status(409).json({ error: 'No puedes eliminar una propiedad con inquilinos activos' });
  const r = await query(
    'DELETE FROM properties WHERE id = $1 AND owner_id = $2',
    [req.params.id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Propiedad no encontrada' });
  await recordAudit({ req, action: 'delete', entity: 'property', entityId: req.params.id });
  res.json({ ok: true });
});

// ============== UNIDADES ==============
const unitSchema = z.object({
  property_id: z.string().uuid(),
  name: z.string().min(1),
  default_rent: z.coerce.number().min(0).optional().default(0),
  notes: z.string().optional().nullable(),
});

router.get('/units/all', async (req, res) => {
  const r = await query(`
    SELECT u.*, p.name AS property_name,
      (SELECT row_to_json(t) FROM (
        SELECT id, full_name FROM tenants
        WHERE unit_id = u.id AND status='active' LIMIT 1
      ) t) AS active_tenant
    FROM units u
    JOIN properties p ON p.id = u.property_id
    WHERE p.owner_id = $1
    ORDER BY p.name, u.name
  `, [req.user.id]);
  res.json({ units: r.rows });
});

router.post('/units', validate(unitSchema), async (req, res) => {
  const { property_id, name, default_rent, notes } = req.body;
  // Verify the property belongs to this owner
  const propCheck = await query(
    'SELECT id FROM properties WHERE id = $1 AND owner_id = $2',
    [property_id, req.user.id]
  );
  if (propCheck.rowCount === 0)
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  const r = await query(
    `INSERT INTO units (property_id, name, default_rent, notes, owner_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [property_id, name, default_rent || 0, notes || null, req.user.id]
  );
  await recordAudit({ req, action: 'create', entity: 'unit', entityId: r.rows[0].id, details: { property_id, name } });
  res.json({ unit: r.rows[0] });
});

router.put('/units/:id', validate(unitSchema.omit({ property_id: true })), async (req, res) => {
  const { name, default_rent, notes } = req.body;
  const r = await query(
    `UPDATE units SET name=$1, default_rent=$2, notes=$3
     WHERE id=$4 AND owner_id=$5 RETURNING *`,
    [name, default_rent || 0, notes || null, req.params.id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Unidad no encontrada' });
  await recordAudit({ req, action: 'update', entity: 'unit', entityId: req.params.id });
  res.json({ unit: r.rows[0] });
});

// GET /api/properties/units/:id/history — historial de inquilinos en esta unidad
router.get('/units/:id/history', async (req, res) => {
  const u = await query(
    `SELECT u.id, u.name, p.name AS property_name, p.address AS property_address
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1 AND p.owner_id = $2`,
    [req.params.id, req.user.id]
  );
  if (u.rowCount === 0) return res.status(404).json({ error: 'Unidad no encontrada' });

  const r = await query(
    `SELECT a.id, a.start_date, a.end_date, a.reason,
            t.id   AS tenant_id,
            t.full_name,
            t.dni,
            t.phone,
            t.email,
            t.status AS tenant_status,
            COALESCE(SUM(p.amount) FILTER (WHERE p.voided_at IS NULL), 0)::numeric AS total_paid,
            COUNT(p.id)         FILTER (WHERE p.voided_at IS NULL)::int           AS payments_count
       FROM unit_assignments a
       JOIN tenants t      ON t.id = a.tenant_id
  LEFT JOIN payments p     ON p.tenant_id = t.id
                          AND p.period_start >= a.start_date
                          AND (a.end_date IS NULL OR p.period_start <= a.end_date)
      WHERE a.unit_id = $1
      GROUP BY a.id, t.id
      ORDER BY a.start_date DESC, a.created_at DESC`,
    [req.params.id]
  );

  res.json({
    unit: u.rows[0],
    assignments: r.rows.map((row) => ({
      ...row,
      months: monthsBetween(row.start_date, row.end_date),
    })),
  });
});

function monthsBetween(startVal, endVal) {
  if (!startVal) return 0;
  const s = startVal instanceof Date ? startVal : new Date(startVal);
  const e = endVal ? (endVal instanceof Date ? endVal : new Date(endVal)) : new Date();
  const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  return Math.max(0, months);
}

router.delete('/units/:id', async (req, res) => {
  const check = await query(
    `SELECT COUNT(*)::int AS c FROM tenants WHERE unit_id = $1 AND status = 'active'`,
    [req.params.id]
  );
  if (check.rows[0].c > 0)
    return res.status(409).json({ error: 'No puedes eliminar una unidad con inquilino activo' });
  const r = await query(
    'DELETE FROM units WHERE id = $1 AND owner_id = $2',
    [req.params.id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Unidad no encontrada' });
  await recordAudit({ req, action: 'delete', entity: 'unit', entityId: req.params.id });
  res.json({ ok: true });
});

export default router;
