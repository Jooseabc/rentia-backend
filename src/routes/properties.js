import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ============== PROPIEDADES ==============
const propSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional().nullable(),
  type: z.string().optional().default('Edificio'),
  notes: z.string().optional().nullable(),
});

router.get('/', async (_req, res) => {
  const r = await query(`
    SELECT p.*,
      COALESCE((SELECT COUNT(*) FROM units u WHERE u.property_id = p.id), 0)::int AS units_count,
      COALESCE((
        SELECT COUNT(*) FROM units u
        JOIN tenants t ON t.unit_id = u.id AND t.status='active'
        WHERE u.property_id = p.id
      ), 0)::int AS occupied_count
    FROM properties p
    ORDER BY p.name
  `);
  res.json({ properties: r.rows });
});

router.post('/', validate(propSchema), async (req, res) => {
  const { name, address, type, notes } = req.body;
  const r = await query(
    `INSERT INTO properties (name, address, type, notes, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, address || null, type, notes || null, req.user.id]
  );
  res.json({ property: r.rows[0] });
});

router.put('/:id', validate(propSchema), async (req, res) => {
  const { name, address, type, notes } = req.body;
  const r = await query(
    `UPDATE properties SET name=$1, address=$2, type=$3, notes=$4 WHERE id=$5 RETURNING *`,
    [name, address || null, type, notes || null, req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Propiedad no encontrada' });
  res.json({ property: r.rows[0] });
});

router.delete('/:id', async (req, res) => {
  // Comprobar que no hay inquilinos activos en sus unidades
  const check = await query(
    `SELECT COUNT(*)::int AS c FROM tenants t
     JOIN units u ON u.id = t.unit_id
     WHERE u.property_id = $1 AND t.status = 'active'`,
    [req.params.id]
  );
  if (check.rows[0].c > 0)
    return res.status(409).json({ error: 'No puedes eliminar una propiedad con inquilinos activos' });
  await query('DELETE FROM properties WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ============== UNIDADES ==============
const unitSchema = z.object({
  property_id: z.string().uuid(),
  name: z.string().min(1),
  default_rent: z.coerce.number().min(0).optional().default(0),
  notes: z.string().optional().nullable(),
});

router.get('/units/all', async (_req, res) => {
  const r = await query(`
    SELECT u.*, p.name AS property_name,
      (SELECT row_to_json(t) FROM (
        SELECT id, full_name FROM tenants
        WHERE unit_id = u.id AND status='active' LIMIT 1
      ) t) AS active_tenant
    FROM units u
    JOIN properties p ON p.id = u.property_id
    ORDER BY p.name, u.name
  `);
  res.json({ units: r.rows });
});

router.post('/units', validate(unitSchema), async (req, res) => {
  const { property_id, name, default_rent, notes } = req.body;
  const r = await query(
    `INSERT INTO units (property_id, name, default_rent, notes)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [property_id, name, default_rent || 0, notes || null]
  );
  res.json({ unit: r.rows[0] });
});

router.put('/units/:id', validate(unitSchema.omit({ property_id: true })), async (req, res) => {
  const { name, default_rent, notes } = req.body;
  const r = await query(
    `UPDATE units SET name=$1, default_rent=$2, notes=$3 WHERE id=$4 RETURNING *`,
    [name, default_rent || 0, notes || null, req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Unidad no encontrada' });
  res.json({ unit: r.rows[0] });
});

router.delete('/units/:id', async (req, res) => {
  const check = await query(
    `SELECT COUNT(*)::int AS c FROM tenants WHERE unit_id = $1 AND status = 'active'`,
    [req.params.id]
  );
  if (check.rows[0].c > 0)
    return res.status(409).json({ error: 'No puedes eliminar una unidad con inquilino activo' });
  await query('DELETE FROM units WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

export default router;
