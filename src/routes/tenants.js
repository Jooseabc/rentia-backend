import { Router } from 'express';
import { z } from 'zod';
import { query } from '../lib/db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { getCycles, rentAtDate, addMonthsISO, daysUntil } from '../lib/cycles.js';
import { generateReceiptPDF } from '../lib/pdf.js';

const router = Router();

// ============================================================
// RUTAS PUBLICAS (sin autenticacion) - DEBEN IR PRIMERO
// ============================================================

// POST /api/tenants/form-intake — recibe datos desde Google Forms
router.post('/form-intake', async (req, res) => {
  const secret = req.headers['x-form-secret'];
  console.log('[form-intake] Secret recibido:', JSON.stringify(secret));
  console.log('[form-intake] Secret esperado: "saa2024"');

  if (secret !== 'saa2024') {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const {
      full_name, dni, phone, email,
      emergency_contact, emergency_phone,
      entry_date, monthly_rent, deposit, notes,
    } = req.body;

    if (!full_name || !entry_date) {
      return res.status(400).json({ error: 'Faltan campos obligatorios: full_name, entry_date' });
    }

    const r = await query(
      `INSERT INTO tenants
        (full_name, dni, phone, email, emergency_contact, emergency_phone,
         entry_date, monthly_rent, deposit, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10)
       RETURNING id, full_name`,
      [
        full_name.trim(),
        dni || null,
        phone || null,
        email || null,
        emergency_contact || null,
        emergency_phone || null,
        entry_date,
        Number(monthly_rent || 0),
        Number(deposit || 0),
        notes || null,
      ]
    );
    console.log(`[form-intake] Nuevo inquilino: ${r.rows[0].full_name}`);
    res.json({ ok: true, tenant: r.rows[0] });
  } catch (err) {
    console.error('[form-intake] Error:', err.message);
    res.status(500).json({ error: 'Error al registrar inquilino' });
  }
});

// ============================================================
// A PARTIR DE AQUI TODAS LAS RUTAS REQUIEREN AUTENTICACION
// ============================================================
router.use(requireAuth);

// ============== INQUILINOS ==============
const tenantSchema = z.object({
  full_name: z.string().min(1),
  dni: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')).nullable(),
  emergency_contact: z.string().optional().nullable(),
  emergency_phone: z.string().optional().nullable(),
  unit_id: z.string().uuid().optional().nullable(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monthly_rent: z.coerce.number().min(0),
  deposit: z.coerce.number().min(0).optional().default(0),
  status: z.enum(['active', 'inactive']).optional().default('active'),
  notes: z.string().optional().nullable(),
});

router.get('/', async (_req, res) => {
  const r = await query(`
    SELECT t.*,
      u.name  AS unit_name,
      p.name  AS property_name,
      p.id    AS property_id
    FROM tenants t
    LEFT JOIN units u      ON u.id = t.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    ORDER BY t.full_name
  `);
  res.json({ tenants: r.rows });
});

router.get('/:id', async (req, res) => {
  const r = await query(`
    SELECT t.*,
      u.name AS unit_name,
      p.name AS property_name,
      p.address AS property_address
    FROM tenants t
    LEFT JOIN units u      ON u.id = t.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE t.id = $1
  `, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });

  const tenant = r.rows[0];
  const cycles = getCycles(tenant.entry_date);
  const payments = await query(
    `SELECT * FROM payments WHERE tenant_id = $1 ORDER BY period_start DESC`,
    [tenant.id]
  );
  const incidents = await query(
    `SELECT * FROM incidents WHERE tenant_id = $1 ORDER BY date DESC`,
    [tenant.id]
  );
  const rentChanges = await query(
    `SELECT * FROM rent_changes WHERE tenant_id = $1 ORDER BY effective_date DESC`,
    [tenant.id]
  );

  const cyclesWithRent = await Promise.all(
    cycles.map(async (c) => ({
      ...c,
      expected_amount: await rentAtDate(tenant.id, c.start, tenant.monthly_rent),
    }))
  );

  res.json({
    tenant,
    cycles: cyclesWithRent,
    payments: payments.rows,
    incidents: incidents.rows,
    rent_changes: rentChanges.rows,
  });
});

router.post('/', validate(tenantSchema), async (req, res) => {
  const t = req.body;
  const r = await query(
    `INSERT INTO tenants (full_name, dni, phone, email, emergency_contact, emergency_phone,
      unit_id, entry_date, monthly_rent, deposit, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [t.full_name, t.dni || null, t.phone || null, t.email || null,
     t.emergency_contact || null, t.emergency_phone || null,
     t.unit_id || null, t.entry_date, t.monthly_rent, t.deposit,
     t.status, t.notes || null, req.user.id]
  );
  res.json({ tenant: r.rows[0] });
});

router.put('/:id', validate(tenantSchema), async (req, res) => {
  const t = req.body;
  const r = await query(
    `UPDATE tenants SET full_name=$1, dni=$2, phone=$3, email=$4,
       emergency_contact=$5, emergency_phone=$6, unit_id=$7, entry_date=$8,
       monthly_rent=$9, deposit=$10, status=$11, notes=$12
     WHERE id=$13 RETURNING *`,
    [t.full_name, t.dni || null, t.phone || null, t.email || null,
     t.emergency_contact || null, t.emergency_phone || null,
     t.unit_id || null, t.entry_date, t.monthly_rent, t.deposit,
     t.status, t.notes || null, req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });
  res.json({ tenant: r.rows[0] });
});

router.delete('/:id', async (req, res) => {
  await query('DELETE FROM tenants WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ============== PAGOS ==============
const paymentSchema = z.object({
  tenant_id: z.string().uuid(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.coerce.number().positive(),
  method: z.string().optional().default('Efectivo'),
  notes: z.string().optional().nullable(),
});

router.post('/payments', validate(paymentSchema), async (req, res) => {
  const p = req.body;
  try {
    const r = await query(
      `INSERT INTO payments (tenant_id, period_start, period_end, paid_date, amount, method, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [p.tenant_id, p.period_start, p.period_end, p.paid_date, p.amount, p.method, p.notes || null, req.user.id]
    );
    res.json({ payment: r.rows[0] });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'Ya existe un pago registrado para ese período' });
    throw err;
  }
});

router.delete('/payments/:id', async (req, res) => {
  await query('DELETE FROM payments WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

router.get('/payments/:id/receipt', async (req, res) => {
  const r = await query(
    `SELECT pay.*,
       t.id AS t_id, t.full_name, t.dni, t.email AS t_email,
       u.id AS u_id, u.name AS u_name,
       p.id AS p_id, p.name AS p_name, p.address AS p_address
     FROM payments pay
     JOIN tenants t ON t.id = pay.tenant_id
     LEFT JOIN units u ON u.id = t.unit_id
     LEFT JOIN properties p ON p.id = u.property_id
     WHERE pay.id = $1`,
    [req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Pago no encontrado' });
  const row = r.rows[0];
  const pdf = await generateReceiptPDF({
    payment: {
      receipt_no: row.receipt_no, paid_date: row.paid_date, method: row.method,
      period_start: row.period_start, period_end: row.period_end,
      amount: row.amount, notes: row.notes,
    },
    tenant: { full_name: row.full_name, dni: row.dni },
    unit: row.u_id ? { name: row.u_name } : null,
    property: row.p_id ? { name: row.p_name, address: row.p_address } : null,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="recibo-${String(row.receipt_no).padStart(6, '0')}.pdf"`
  );
  res.send(pdf);
});

// ============== INCIDENCIAS ==============
const incidentSchema = z.object({
  tenant_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.string().min(1),
  description: z.string().min(1),
});

router.post('/incidents', validate(incidentSchema), async (req, res) => {
  const i = req.body;
  const r = await query(
    `INSERT INTO incidents (tenant_id, date, type, description, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [i.tenant_id, i.date, i.type, i.description, req.user.id]
  );
  res.json({ incident: r.rows[0] });
});

router.delete('/incidents/:id', async (req, res) => {
  await query('DELETE FROM incidents WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ============== AUMENTOS DE RENTA ==============
const rentChangeSchema = z.object({
  tenant_id: z.string().uuid(),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  new_rent: z.coerce.number().positive(),
  reason: z.string().optional().nullable(),
});

router.post('/rent-changes', validate(rentChangeSchema), async (req, res) => {
  const c = req.body;
  const r = await query(
    `INSERT INTO rent_changes (tenant_id, effective_date, new_rent, reason, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [c.tenant_id, c.effective_date, c.new_rent, c.reason || null, req.user.id]
  );
  if (new Date(c.effective_date) <= new Date()) {
    await query('UPDATE tenants SET monthly_rent = $1 WHERE id = $2', [c.new_rent, c.tenant_id]);
  }
  res.json({ rent_change: r.rows[0] });
});

router.delete('/rent-changes/:id', async (req, res) => {
  await query('DELETE FROM rent_changes WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ============== RESUMEN / DASHBOARD ==============
router.get('/dashboard/summary', async (_req, res) => {
  const tenants = (await query('SELECT * FROM tenants WHERE status = $1', ['active'])).rows;
  const payments = (await query('SELECT * FROM payments')).rows;
  const totalUnits = (await query('SELECT COUNT(*)::int AS c FROM units')).rows[0].c;
  const occupied = new Set(tenants.filter((t) => t.unit_id).map((t) => t.unit_id)).size;
  const monthlyIncome = tenants.reduce((s, t) => s + Number(t.monthly_rent || 0), 0);

  let pendingCount = 0, overdueCount = 0, pendingAmount = 0, overdueAmount = 0;
  const upcoming = [];

  for (const t of tenants) {
    const cycles = getCycles(t.entry_date);
    if (!cycles.length) continue;
    const tp = payments.filter((p) => p.tenant_id === t.id);
    const cur = cycles[cycles.length - 1];

    let unpaidPast = 0;
    for (let i = 0; i < cycles.length - 1; i++) {
      if (!tp.some((p) => p.period_start === cycles[i].start)) unpaidPast++;
    }
    const paidCurrent = tp.some((p) => p.period_start === cur.start);

    if (unpaidPast > 0) {
      overdueCount++;
      overdueAmount += Number(t.monthly_rent || 0) * unpaidPast;
    }
    if (!paidCurrent) {
      pendingCount++;
      pendingAmount += Number(t.monthly_rent || 0);
      upcoming.push({
        tenant_id: t.id,
        tenant_name: t.full_name,
        due_date: cur.end,
        days_left: daysUntil(cur.end),
        amount: t.monthly_rent,
      });
    }
  }

  upcoming.sort((a, b) => a.days_left - b.days_left);

  res.json({
    stats: {
      active_tenants: tenants.length,
      total_units: totalUnits,
      occupied_units: occupied,
      vacancy: totalUnits - occupied,
      monthly_income: monthlyIncome,
      pending_count: pendingCount,
      overdue_count: overdueCount,
      pending_amount: pendingAmount,
      overdue_amount: overdueAmount,
    },
    upcoming: upcoming.slice(0, 10),
  });
});

// GET /api/tenants/payments/all - vista global de pagos
router.get('/payments/all', async (_req, res) => {
  const tenants = (await query(
    `SELECT t.*, u.name AS unit_name, p.name AS property_name
     FROM tenants t
     LEFT JOIN units u      ON u.id = t.unit_id
     LEFT JOIN properties p ON p.id = u.property_id
     WHERE t.status = 'active'`
  )).rows;
  const payments = (await query('SELECT * FROM payments')).rows;
  const items = [];
  for (const t of tenants) {
    const cycles = getCycles(t.entry_date);
    const tp = payments.filter((p) => p.tenant_id === t.id);
    cycles.forEach((c, i) => {
      const pay = tp.find((p) => p.period_start === c.start);
      let kind;
      if (pay) kind = 'paid';
      else if (i === cycles.length - 1) kind = 'pending';
      else kind = 'overdue';
      items.push({
        tenant_id: t.id,
        tenant_name: t.full_name,
        unit_name: t.unit_name,
        property_name: t.property_name,
        cycle: c,
        payment: pay || null,
        amount: pay ? Number(pay.amount) : Number(t.monthly_rent),
        kind,
      });
    });
  }
  items.sort((a, b) => b.cycle.start.localeCompare(a.cycle.start));
  res.json({ items });
});

export default router;
