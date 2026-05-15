import { Router } from 'express';
import { z } from 'zod';
import { pool, query } from '../lib/db.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getCycles, rentAtDate, addMonthsISO, daysUntil, fmtDate, fmtMoney } from '../lib/cycles.js';
import { generateReceiptPDF, generateMonthlySummaryPDF, generateTenantStatementPDF } from '../lib/pdf.js';
import { recordAudit } from '../lib/audit.js';
import { sendTenantReminder } from '../lib/reminders.js';

const router = Router();

// Helper: normaliza una fecha (Date o string) a "YYYY-MM-DD"
function toISODate(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

// Hoy en formato YYYY-MM-DD (zona local del servidor)
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Cierra la asignación activa actual de un inquilino (si tiene)
async function closeActiveAssignment(client, tenantId, endDate, reason) {
  await client.query(
    `UPDATE unit_assignments
        SET end_date = $1, reason = COALESCE(reason, $2)
      WHERE tenant_id = $3 AND end_date IS NULL`,
    [endDate, reason || null, tenantId]
  );
}

// Si la unidad ya tiene un inquilino activo distinto, lo cierra.
async function freeUnitIfBusy(client, unitId, endDate, reason) {
  if (!unitId) return;
  await client.query(
    `UPDATE unit_assignments
        SET end_date = $1, reason = COALESCE(reason, $2)
      WHERE unit_id = $3 AND end_date IS NULL`,
    [endDate, reason || null, unitId]
  );
}

// form-intake eliminado: incompatible con multi-tenancy (owner_id NOT NULL).

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

router.get('/', async (req, res) => {
  const r = await query(`
    SELECT t.*,
      u.name  AS unit_name,
      p.name  AS property_name,
      p.id    AS property_id
    FROM tenants t
    LEFT JOIN units u      ON u.id = t.unit_id
    LEFT JOIN properties p ON p.id = u.property_id
    WHERE t.owner_id = $1
    ORDER BY t.full_name
  `, [req.user.id]);
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
    WHERE t.id = $1 AND t.owner_id = $2
  `, [req.params.id, req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });

  const tenant = r.rows[0];
  const cycles = getCycles(tenant.entry_date);
  const payments = await query(
    `SELECT * FROM payments WHERE tenant_id = $1 AND voided_at IS NULL ORDER BY period_start DESC`,
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO tenants (full_name, dni, phone, email, emergency_contact, emergency_phone,
        unit_id, entry_date, monthly_rent, deposit, status, notes, created_by, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       RETURNING *`,
      [t.full_name, t.dni || null, t.phone || null, t.email || null,
       t.emergency_contact || null, t.emergency_phone || null,
       t.unit_id || null, t.entry_date, t.monthly_rent, t.deposit,
       t.status, t.notes || null, req.user.id]
    );
    const tenant = r.rows[0];
    // Si el inquilino entra activo y con unidad, abre asignación
    if (tenant.unit_id && tenant.status === 'active') {
      // Por seguridad libera la unidad si por error tenía otra activa
      await freeUnitIfBusy(client, tenant.unit_id, t.entry_date, 'Reasignación automática');
      await client.query(
        `INSERT INTO unit_assignments (unit_id, tenant_id, start_date)
         VALUES ($1, $2, $3)`,
        [tenant.unit_id, tenant.id, t.entry_date]
      );
    }
    await client.query('COMMIT');
    await recordAudit({ req, action: 'create', entity: 'tenant', entityId: tenant.id, details: { full_name: t.full_name } });
    res.json({ tenant });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.put('/:id', validate(tenantSchema), async (req, res) => {
  const t = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Estado anterior para detectar cambio de unidad/status
    const prev = await client.query(
      'SELECT unit_id, status, entry_date FROM tenants WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (prev.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Inquilino no encontrado' });
    }
    const before = prev.rows[0];

    const r = await client.query(
      `UPDATE tenants SET full_name=$1, dni=$2, phone=$3, email=$4,
         emergency_contact=$5, emergency_phone=$6, unit_id=$7, entry_date=$8,
         monthly_rent=$9, deposit=$10, status=$11, notes=$12
       WHERE id=$13 RETURNING *`,
      [t.full_name, t.dni || null, t.phone || null, t.email || null,
       t.emergency_contact || null, t.emergency_phone || null,
       t.unit_id || null, t.entry_date, t.monthly_rent, t.deposit,
       t.status, t.notes || null, req.params.id]
    );
    const tenant = r.rows[0];

    const beforeUnit  = before.unit_id;
    const afterUnit   = tenant.unit_id;
    const wentInactive = before.status === 'active' && tenant.status === 'inactive';
    const becameActive = before.status !== 'active' && tenant.status === 'active';
    const changedUnit  = beforeUnit !== afterUnit;
    const today        = todayISO();

    if (wentInactive) {
      // Cerrar la asignación activa, sea cual sea
      await closeActiveAssignment(client, tenant.id, today, 'Inquilino marcado inactivo');
    } else if (changedUnit) {
      // Cierra la actual del inquilino
      await closeActiveAssignment(client, tenant.id, today, 'Cambio de unidad');
      if (afterUnit && tenant.status === 'active') {
        await freeUnitIfBusy(client, afterUnit, today, 'Reasignación automática');
        await client.query(
          `INSERT INTO unit_assignments (unit_id, tenant_id, start_date)
           VALUES ($1, $2, $3)`,
          [afterUnit, tenant.id, today]
        );
      }
    } else if (becameActive && afterUnit) {
      // Reactivado en la misma unidad: abrir nueva asignación si no hay
      const open = await client.query(
        `SELECT 1 FROM unit_assignments WHERE tenant_id = $1 AND end_date IS NULL`,
        [tenant.id]
      );
      if (open.rowCount === 0) {
        await freeUnitIfBusy(client, afterUnit, today, 'Reasignación automática');
        await client.query(
          `INSERT INTO unit_assignments (unit_id, tenant_id, start_date)
           VALUES ($1, $2, $3)`,
          [afterUnit, tenant.id, today]
        );
      }
    }

    await client.query('COMMIT');
    await recordAudit({ req, action: 'update', entity: 'tenant', entityId: req.params.id });
    res.json({ tenant });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res) => {
  const before = await query('SELECT full_name FROM tenants WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
  const r = await query('DELETE FROM tenants WHERE id = $1 AND owner_id = $2', [req.params.id, req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });
  await recordAudit({ req, action: 'delete', entity: 'tenant', entityId: req.params.id, details: before.rows[0] || null });
  res.json({ ok: true });
});

// POST /api/tenants/:id/reset-portal-password
// Vacía portal_password del inquilino para que vuelva a entrar al portal con su DNI
router.post('/:id/reset-portal-password', async (req, res) => {
  const r = await query(
    `UPDATE tenants SET portal_password = NULL
     WHERE id = $1
     RETURNING id, full_name, dni`,
    [req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });
  if (!r.rows[0].dni) {
    return res.status(400).json({
      error: 'El inquilino no tiene DNI registrado, no podrá acceder al portal',
    });
  }
  await recordAudit({ req, action: 'reset_portal_password', entity: 'tenant', entityId: req.params.id });
  res.json({ ok: true, tenant: r.rows[0] });
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
}).refine((p) => p.period_end > p.period_start, {
  message: 'period_end debe ser posterior a period_start',
  path: ['period_end'],
}).refine((p) => p.paid_date >= p.period_start, {
  message: 'paid_date no puede ser anterior al inicio del período',
  path: ['paid_date'],
});

router.post('/payments', validate(paymentSchema), async (req, res) => {
  const p = req.body;
  try {
    // Verify tenant belongs to this owner
    const tCheck = await query('SELECT id FROM tenants WHERE id = $1 AND owner_id = $2', [p.tenant_id, req.user.id]);
    if (tCheck.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });

    const r = await query(
      `INSERT INTO payments (tenant_id, period_start, period_end, paid_date, amount, method, notes, created_by, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [p.tenant_id, p.period_start, p.period_end, p.paid_date, p.amount, p.method, p.notes || null, req.user.id]
    );
    await recordAudit({
      req, action: 'create', entity: 'payment', entityId: r.rows[0].id,
      details: { tenant_id: p.tenant_id, amount: p.amount, period_start: p.period_start },
    });
    res.json({ payment: r.rows[0] });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'Ya existe un pago registrado para ese período' });
    throw err;
  }
});

// Soft-delete: anula el pago en lugar de borrarlo. Conserva el recibo y la
// trazabilidad fiscal. Sólo admin para evitar que un usuario común esconda movimientos.
router.delete('/payments/:id', requireAdmin, async (req, res) => {
  const reason = (req.body?.reason || '').trim().slice(0, 500) || null;
  const r = await query(
    `UPDATE payments
       SET voided_at = now(), voided_by = $1, void_reason = $2
     WHERE id = $3 AND voided_at IS NULL
     RETURNING id, tenant_id, period_start, amount`,
    [req.user.id, reason, req.params.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Pago no encontrado o ya anulado' });
  await recordAudit({
    req, action: 'void', entity: 'payment', entityId: req.params.id,
    details: { reason, ...r.rows[0] },
  });
  res.json({ ok: true });
});

// Listar pagos anulados (admin) — para revisión
router.get('/payments/voided', requireAdmin, async (req, res) => {
  const r = await query(
    `SELECT pay.id, pay.tenant_id, pay.period_start, pay.period_end, pay.amount,
            pay.voided_at, pay.void_reason,
            u.email AS voided_by_email,
            t.full_name AS tenant_name
       FROM payments pay
       JOIN tenants t ON t.id = pay.tenant_id
  LEFT JOIN users u   ON u.id = pay.voided_by
      WHERE pay.voided_at IS NOT NULL AND t.owner_id = $1
      ORDER BY pay.voided_at DESC
      LIMIT 200`, [req.user.id]
  );
  res.json({ payments: r.rows });
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
     WHERE pay.id = $1 AND pay.voided_at IS NULL`,
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
  const tCheck = await query('SELECT id FROM tenants WHERE id = $1 AND owner_id = $2', [i.tenant_id, req.user.id]);
  if (tCheck.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });

  const r = await query(
    `INSERT INTO incidents (tenant_id, date, type, description, created_by, owner_id)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
    [i.tenant_id, i.date, i.type, i.description, req.user.id]
  );
  await recordAudit({ req, action: 'create', entity: 'incident', entityId: r.rows[0].id, details: { tenant_id: i.tenant_id, type: i.type } });
  res.json({ incident: r.rows[0] });
});

router.delete('/incidents/:id', async (req, res) => {
  const r = await query('DELETE FROM incidents WHERE id = $1', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Incidencia no encontrada' });
  await recordAudit({ req, action: 'delete', entity: 'incident', entityId: req.params.id });
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
  const tCheck = await query('SELECT id FROM tenants WHERE id = $1 AND owner_id = $2', [c.tenant_id, req.user.id]);
  if (tCheck.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });

  const r = await query(
    `INSERT INTO rent_changes (tenant_id, effective_date, new_rent, reason, created_by, owner_id)
     VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
    [c.tenant_id, c.effective_date, c.new_rent, c.reason || null, req.user.id]
  );
  if (new Date(c.effective_date) <= new Date()) {
    await query('UPDATE tenants SET monthly_rent = $1 WHERE id = $2', [c.new_rent, c.tenant_id]);
  }
  await recordAudit({ req, action: 'create', entity: 'rent_change', entityId: r.rows[0].id, details: { tenant_id: c.tenant_id, new_rent: c.new_rent, effective_date: c.effective_date } });
  res.json({ rent_change: r.rows[0] });
});

router.delete('/rent-changes/:id', async (req, res) => {
  const r = await query('DELETE FROM rent_changes WHERE id = $1', [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Aumento no encontrado' });
  await recordAudit({ req, action: 'delete', entity: 'rent_change', entityId: req.params.id });
  res.json({ ok: true });
});

// ============== RESUMEN / DASHBOARD ==============
router.get('/dashboard/summary', async (req, res) => {
  const tenants = (await query('SELECT * FROM tenants WHERE status = $1 AND owner_id = $2', ['active', req.user.id])).rows;
  const payments = (await query(
    `SELECT p.* FROM payments p
     JOIN tenants t ON t.id = p.tenant_id
     WHERE p.voided_at IS NULL AND t.owner_id = $1`, [req.user.id]
  )).rows;
  const totalUnits = (await query(
    'SELECT COUNT(*)::int AS c FROM units WHERE owner_id = $1', [req.user.id]
  )).rows[0].c;
  const occupied = new Set(tenants.filter((t) => t.unit_id).map((t) => t.unit_id)).size;
  const monthlyIncome = tenants.reduce((s, t) => s + Number(t.monthly_rent || 0), 0);

  // Cobrado del mes en curso (por paid_date, no por ciclo)
  const today = new Date();
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const collectedThisMonth = payments
    .filter((p) => toISODate(p.paid_date) >= monthStart)
    .reduce((s, p) => s + Number(p.amount || 0), 0);

  let pendingCount = 0, overdueCount = 0, pendingAmount = 0, overdueAmount = 0;
  const upcoming = [];
  const topOverdue = [];

  for (const t of tenants) {
    const cycles = getCycles(t.entry_date);
    if (!cycles.length) continue;
    const tp = payments.filter((p) => p.tenant_id === t.id);
    const cur = cycles[cycles.length - 1];

    let unpaidPast = 0;
    for (let i = 0; i < cycles.length - 1; i++) {
      if (!tp.some((p) => toISODate(p.period_start) === cycles[i].start)) unpaidPast++;
    }
    const paidCurrent = tp.some((p) => toISODate(p.period_start) === cur.start);

    if (unpaidPast > 0) {
      overdueCount++;
      const amount = Number(t.monthly_rent || 0) * unpaidPast;
      overdueAmount += amount;
      topOverdue.push({
        tenant_id: t.id,
        tenant_name: t.full_name,
        cycles_unpaid: unpaidPast,
        amount,
      });
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
  topOverdue.sort((a, b) => b.amount - a.amount);

  res.json({
    stats: {
      active_tenants: tenants.length,
      total_units: totalUnits,
      occupied_units: occupied,
      vacancy: totalUnits - occupied,
      occupancy_rate: totalUnits > 0 ? Math.round((occupied / totalUnits) * 100) : 0,
      monthly_income: monthlyIncome,
      collected_this_month: collectedThisMonth,
      collection_rate: monthlyIncome > 0 ? Math.round((collectedThisMonth / monthlyIncome) * 100) : 0,
      pending_count: pendingCount,
      overdue_count: overdueCount,
      pending_amount: pendingAmount,
      overdue_amount: overdueAmount,
    },
    upcoming: upcoming.slice(0, 10),
    top_overdue: topOverdue.slice(0, 5),
  });
});

// GET /api/tenants/:id/statement.pdf — estado de cuenta del inquilino
router.get('/:id/statement.pdf', async (req, res) => {
  const r = await query(
    `SELECT t.*, u.id AS u_id, u.name AS u_name,
            p.id AS p_id, p.name AS p_name, p.address AS p_address
       FROM tenants t
  LEFT JOIN units u      ON u.id = t.unit_id
  LEFT JOIN properties p ON p.id = u.property_id
      WHERE t.id = $1 AND t.owner_id = $2`,
    [req.params.id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });
  const tenant = r.rows[0];

  const cycles = getCycles(tenant.entry_date);
  const payments = (await query(
    `SELECT id, period_start, period_end, paid_date, amount, method
       FROM payments WHERE tenant_id = $1 AND voided_at IS NULL`,
    [tenant.id]
  )).rows;

  const items = await Promise.all(cycles.map(async (c, i) => {
    const expected = await rentAtDate(tenant.id, c.start, tenant.monthly_rent);
    const pay = payments.find((p) => toISODate(p.period_start) === c.start);
    let kind;
    if (pay) kind = 'paid';
    else if (i === cycles.length - 1) kind = 'pending';
    else kind = 'overdue';
    return {
      cycle: c,
      payment: pay || null,
      amount: pay ? Number(pay.amount) : Number(expected),
      kind,
    };
  }));

  const totals = {
    paid:           items.filter((x) => x.kind === 'paid').reduce((s, x) => s + x.amount, 0),
    pending:        items.filter((x) => x.kind !== 'paid').reduce((s, x) => s + x.amount, 0),
    paid_count:     items.filter((x) => x.kind === 'paid').length,
    overdue_count:  items.filter((x) => x.kind === 'overdue').length,
    pending_count:  items.filter((x) => x.kind === 'pending').length,
  };

  const pdf = await generateTenantStatementPDF({
    tenant,
    unit: tenant.u_id ? { name: tenant.u_name } : null,
    property: tenant.p_id ? { name: tenant.p_name, address: tenant.p_address } : null,
    items,
    totals,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="estado-${tenant.full_name.replace(/\s+/g, '_')}.pdf"`);
  res.send(pdf);
});

// POST /api/tenants/:id/send-reminder — recordatorio manual del ciclo actual
router.post('/:id/send-reminder', async (req, res) => {
  try {
    const result = await sendTenantReminder(req.params.id);
    if (!result.ok) return res.status(400).json({ error: result.reason });
    await recordAudit({ req, action: 'send_reminder', entity: 'tenant', entityId: req.params.id, details: { kind: result.kind } });
    res.json({ ok: true, kind: result.kind });
  } catch (err) {
    console.error('[send-reminder]', err);
    res.status(500).json({ error: err.message || 'Error al enviar recordatorio' });
  }
});

// ====== EXPORTS ======

// Escapa un valor para CSV (RFC 4180): si contiene coma, comilla o salto de línea,
// va entre comillas y las comillas internas se duplican.
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toISODateOnly(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

// GET /api/tenants/payments/export.csv?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/payments/export.csv', async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to   || '') ? req.query.to   : null;

  const params = [req.user.id];
  const where = ['pay.voided_at IS NULL', 't.owner_id = $1'];
  if (from) { params.push(from); where.push(`pay.paid_date >= $${params.length}`); }
  if (to)   { params.push(to);   where.push(`pay.paid_date <= $${params.length}`); }

  const r = await query(
    `SELECT pay.receipt_no, pay.paid_date, pay.period_start, pay.period_end,
            pay.amount, pay.method, pay.notes,
            t.full_name AS tenant_name, t.dni,
            u.name AS unit_name, p.name AS property_name
       FROM payments pay
       JOIN tenants t       ON t.id = pay.tenant_id
  LEFT JOIN units u         ON u.id = t.unit_id
  LEFT JOIN properties p    ON p.id = u.property_id
      WHERE ${where.join(' AND ')}
      ORDER BY pay.paid_date DESC, pay.receipt_no DESC`,
    params
  );

  const headers = [
    'recibo', 'fecha_pago', 'periodo_inicio', 'periodo_fin',
    'monto', 'metodo', 'inquilino', 'dni', 'unidad', 'propiedad', 'notas',
  ];
  const lines = [headers.join(',')];
  for (const row of r.rows) {
    lines.push([
      String(row.receipt_no).padStart(6, '0'),
      toISODateOnly(row.paid_date),
      toISODateOnly(row.period_start),
      toISODateOnly(row.period_end),
      Number(row.amount).toFixed(2),
      row.method || '',
      row.tenant_name || '',
      row.dni || '',
      row.unit_name || '',
      row.property_name || '',
      row.notes || '',
    ].map(csvEscape).join(','));
  }
  // BOM UTF-8 para que Excel reconozca acentos correctamente.
  const csv = '﻿' + lines.join('\r\n');

  const fname = `pagos${from || to ? `_${from || ''}_${to || ''}` : ''}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
});

// GET /api/tenants/payments/monthly-summary.pdf?month=YYYY-MM
router.get('/payments/monthly-summary.pdf', async (req, res) => {  // owner-scoped
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  if (!month) return res.status(400).json({ error: 'month=YYYY-MM es obligatorio' });
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  // Último día del mes
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${month}-${String(lastDay).padStart(2, '0')}`;

  const collected = (await query(
    `SELECT pay.amount, pay.paid_date, pay.method,
            t.full_name AS tenant_name, u.name AS unit_name, p.name AS property_name
       FROM payments pay
       JOIN tenants t ON t.id = pay.tenant_id
  LEFT JOIN units u   ON u.id = t.unit_id
  LEFT JOIN properties p ON p.id = u.property_id
      WHERE pay.voided_at IS NULL AND pay.paid_date BETWEEN $1 AND $2 AND t.owner_id = $3
      ORDER BY pay.paid_date ASC`,
    [from, to, req.user.id]
  )).rows;

  // Pendientes: por cada inquilino activo, mira sus ciclos cuyo period_start
  // cae en este mes y aún no tiene pago vigente.
  const tenants = (await query(
    `SELECT t.id, t.full_name, t.entry_date, t.monthly_rent,
            u.name AS unit_name, p.name AS property_name
       FROM tenants t
  LEFT JOIN units u      ON u.id = t.unit_id
  LEFT JOIN properties p ON p.id = u.property_id
      WHERE t.status = 'active' AND t.owner_id = $1`, [req.user.id]
  )).rows;
  const allPayments = (await query(
    `SELECT p.tenant_id, p.period_start FROM payments p
     JOIN tenants t ON t.id = p.tenant_id
     WHERE p.voided_at IS NULL AND t.owner_id = $1`, [req.user.id]
  )).rows;

  const pending = [];
  for (const t of tenants) {
    const cycles = getCycles(t.entry_date);
    for (const c of cycles) {
      if (c.start < from || c.start > to) continue;
      const paid = allPayments.some(
        (p) => p.tenant_id === t.id && toISODate(p.period_start) === c.start
      );
      if (!paid) {
        pending.push({
          tenant_name: t.full_name,
          unit_name: t.unit_name,
          property_name: t.property_name,
          amount: Number(t.monthly_rent || 0),
          cycle_start: c.start,
        });
      }
    }
  }

  const pdf = await generateMonthlySummaryPDF({ month, from, to, collected, pending });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="resumen-${month}.pdf"`);
  res.send(pdf);
});

// GET /api/tenants/payments/all - vista global de pagos
router.get('/payments/all', async (req, res) => {  // pagos anulados ya excluidos

  const tenants = (await query(
    `SELECT t.*, u.name AS unit_name, p.name AS property_name
     FROM tenants t
     LEFT JOIN units u      ON u.id = t.unit_id
     LEFT JOIN properties p ON p.id = u.property_id
     WHERE t.status = 'active' AND t.owner_id = $1`, [req.user.id]
  )).rows;
  const payments = (await query(
    `SELECT p.* FROM payments p
     JOIN tenants t ON t.id = p.tenant_id
     WHERE p.voided_at IS NULL AND t.owner_id = $1`, [req.user.id]
  )).rows;
  const items = [];
  for (const t of tenants) {
    const cycles = getCycles(t.entry_date);
    const tp = payments.filter((p) => p.tenant_id === t.id);
    cycles.forEach((c, i) => {
      // FIX: comparar siempre con strings, no objetos Date
      const pay = tp.find((p) => toISODate(p.period_start) === c.start);
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
