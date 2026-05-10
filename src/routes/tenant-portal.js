// Portal del Inquilino - rutas publicas con auth propio (sin JWT de admin)
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../lib/db.js';
import { getCycles, daysUntil } from '../lib/cycles.js';
import { generateReceiptPDF } from '../lib/pdf.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta nuevamente en unos minutos.' },
});

// ============================================================
// LOGIN - DNI como usuario y contrasena
// ============================================================
router.post('/login', loginLimiter, async (req, res) => {
  const { dni, password } = req.body;
  if (!dni || !password) {
    return res.status(400).json({ error: 'DNI y contrasena son obligatorios' });
  }

  // Mensaje genérico para no permitir enumeración de DNIs
  const GENERIC_AUTH_ERROR = { error: 'DNI o contrasena incorrectos' };

  try {
    // Buscar inquilino por DNI
    const r = await query(
      `SELECT id, full_name, dni, phone, email, portal_password
       FROM tenants
       WHERE dni = $1 AND status = 'active'
       LIMIT 1`,
      [String(dni).trim()]
    );

    if (r.rowCount === 0) {
      return res.status(401).json(GENERIC_AUTH_ERROR);
    }

    const tenant = r.rows[0];

    // Si nunca ha iniciado sesion (portal_password vacio), la contrasena por defecto es su DNI
    let valid = false;
    if (!tenant.portal_password) {
      valid = (password === tenant.dni);
    } else {
      valid = await bcrypt.compare(password, tenant.portal_password);
    }

    if (!valid) {
      return res.status(401).json(GENERIC_AUTH_ERROR);
    }

    // Generar token con tipo 'tenant' (diferente de los admin)
    const token = jwt.sign(
      { tenant_id: tenant.id, type: 'tenant' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      tenant: {
        id: tenant.id,
        full_name: tenant.full_name,
        dni: tenant.dni,
        first_login: !tenant.portal_password,
      },
    });
  } catch (err) {
    console.error('[tenant-portal] Login error:', err.message);
    res.status(500).json({ error: 'Error al iniciar sesion' });
  }
});

// ============================================================
// MIDDLEWARE - validar token de inquilino
// ============================================================
function requireTenant(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    if (decoded.type !== 'tenant') {
      return res.status(403).json({ error: 'Token invalido' });
    }
    req.tenantId = decoded.tenant_id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token expirado o invalido' });
  }
}

// ============================================================
// ACTUALIZAR PERFIL (datos de contacto)
// ============================================================
router.put('/profile', requireTenant, async (req, res) => {
  const { phone, email, emergency_contact, emergency_phone } = req.body || {};

  // Validaciones suaves
  const cleanEmail = (email || '').trim();
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Correo inválido' });
  }
  const fields = [
    { k: 'phone',             v: phone },
    { k: 'email',             v: cleanEmail || null },
    { k: 'emergency_contact', v: emergency_contact },
    { k: 'emergency_phone',   v: emergency_phone },
  ];
  for (const f of fields) {
    if (typeof f.v === 'string' && f.v.length > 200) {
      return res.status(400).json({ error: `El campo ${f.k} es demasiado largo` });
    }
  }

  try {
    const r = await query(
      `UPDATE tenants
         SET phone = $1, email = $2, emergency_contact = $3, emergency_phone = $4
       WHERE id = $5
       RETURNING id, phone, email, emergency_contact, emergency_phone`,
      [
        (phone || '').trim() || null,
        cleanEmail || null,
        (emergency_contact || '').trim() || null,
        (emergency_phone || '').trim() || null,
        req.tenantId,
      ]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });
    res.json({ ok: true, tenant: r.rows[0] });
  } catch (err) {
    console.error('[tenant-portal] Profile update error:', err.message);
    res.status(500).json({ error: 'Error al actualizar' });
  }
});

// ============================================================
// CAMBIAR CONTRASENA
// ============================================================
router.post('/change-password', requireTenant, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'La nueva contrasena debe tener al menos 6 caracteres' });
  }
  if (new_password.length > 100) {
    return res.status(400).json({ error: 'La nueva contrasena es demasiado larga' });
  }

  try {
    const r = await query(
      `SELECT dni, portal_password FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Inquilino no encontrado' });

    const tenant = r.rows[0];

    // Bloquear que la nueva contrasena sea el mismo DNI (= contrasena por defecto)
    if (new_password === tenant.dni) {
      return res.status(400).json({ error: 'La nueva contrasena no puede ser tu DNI' });
    }

    // Validar contrasena actual
    let valid = false;
    if (!tenant.portal_password) {
      valid = (current_password === tenant.dni);
    } else {
      valid = await bcrypt.compare(current_password, tenant.portal_password);
    }

    if (!valid) {
      return res.status(401).json({ error: 'La contrasena actual es incorrecta' });
    }

    const hashed = await bcrypt.hash(new_password, 10);
    await query(
      `UPDATE tenants SET portal_password = $1 WHERE id = $2`,
      [hashed, req.tenantId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[tenant-portal] Change password error:', err.message);
    res.status(500).json({ error: 'Error al cambiar contrasena' });
  }
});

// ============================================================
// MI INFORMACION + CICLOS Y PAGOS
// ============================================================
router.get('/me', requireTenant, async (req, res) => {
  try {
    const r = await query(
      `SELECT t.id, t.full_name, t.dni, t.phone, t.email,
              t.emergency_contact, t.emergency_phone,
              t.entry_date, t.monthly_rent, t.deposit,
              t.portal_password IS NULL AS first_login,
              u.name AS unit_name, p.name AS property_name, p.address AS property_address
       FROM tenants t
       LEFT JOIN units u      ON u.id = t.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE t.id = $1`,
      [req.tenantId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'No encontrado' });

    const tenant = r.rows[0];
    const cycles = getCycles(tenant.entry_date);
    const payments = (await query(
      `SELECT id, period_start, period_end, paid_date, amount, method, receipt_no
       FROM payments WHERE tenant_id = $1 AND voided_at IS NULL
       ORDER BY period_start DESC`,
      [tenant.id]
    )).rows;

    // Construir lista de ciclos con su estado
    const items = cycles.map((c, i) => {
      const pay = payments.find((p) => {
        const ps = typeof p.period_start === 'string'
          ? p.period_start.slice(0, 10)
          : new Date(p.period_start).toISOString().slice(0, 10);
        return ps === c.start;
      });
      let kind;
      if (pay) kind = 'paid';
      else if (i === cycles.length - 1) kind = 'pending';
      else kind = 'overdue';
      return {
        cycle: c,
        payment: pay || null,
        amount: pay ? Number(pay.amount) : Number(tenant.monthly_rent),
        kind,
        days_left: daysUntil(c.end),
      };
    }).reverse(); // mas reciente arriba

    // Resumen
    const totalPaid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const overdueCount = items.filter((i) => i.kind === 'overdue').length;
    const overdueAmount = items
      .filter((i) => i.kind === 'overdue')
      .reduce((s, i) => s + i.amount, 0);

    res.json({
      tenant: {
        id: tenant.id,
        full_name: tenant.full_name,
        dni: tenant.dni,
        phone: tenant.phone,
        email: tenant.email,
        emergency_contact: tenant.emergency_contact,
        emergency_phone: tenant.emergency_phone,
        entry_date: tenant.entry_date,
        monthly_rent: tenant.monthly_rent,
        deposit: tenant.deposit,
        unit_name: tenant.unit_name,
        property_name: tenant.property_name,
        property_address: tenant.property_address,
        first_login: tenant.first_login,
      },
      items,
      summary: {
        total_paid: totalPaid,
        overdue_count: overdueCount,
        overdue_amount: overdueAmount,
        cycles_count: cycles.length,
      },
    });
  } catch (err) {
    console.error('[tenant-portal] /me error:', err.message);
    res.status(500).json({ error: 'Error al cargar datos' });
  }
});

// ============================================================
// DESCARGAR RECIBO PDF
// ============================================================
router.get('/payments/:id/receipt', requireTenant, async (req, res) => {
  try {
    // Verificar que el pago pertenece al inquilino
    const r = await query(
      `SELECT pay.*,
         t.id AS t_id, t.full_name, t.dni,
         u.id AS u_id, u.name AS u_name,
         p.id AS p_id, p.name AS p_name, p.address AS p_address
       FROM payments pay
       JOIN tenants t ON t.id = pay.tenant_id
       LEFT JOIN units u ON u.id = t.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE pay.id = $1 AND pay.tenant_id = $2 AND pay.voided_at IS NULL`,
      [req.params.id, req.tenantId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Recibo no encontrado' });

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
  } catch (err) {
    console.error('[tenant-portal] Receipt error:', err.message);
    res.status(500).json({ error: 'Error al generar recibo' });
  }
});

// ============================================================
// REPORTAR INCIDENCIA
// ============================================================
router.post('/incidents', requireTenant, async (req, res) => {
  const { type, description } = req.body;
  const desc = (description || '').trim();
  if (desc.length < 5) {
    return res.status(400).json({ error: 'La descripcion es muy corta' });
  }
  if (desc.length > 2000) {
    return res.status(400).json({ error: 'La descripcion es demasiado larga (máx. 2000 caracteres)' });
  }
  const safeType = String(type || 'Reporte').slice(0, 60);

  try {
    const today = new Date().toISOString().slice(0, 10);
    await query(
      `INSERT INTO incidents (tenant_id, date, type, description)
       VALUES ($1, $2, $3, $4)`,
      [req.tenantId, today, safeType, desc]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[tenant-portal] Incident error:', err.message);
    res.status(500).json({ error: 'Error al reportar' });
  }
});

// ============================================================
// LISTAR MIS INCIDENCIAS
// ============================================================
router.get('/incidents', requireTenant, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, date, type, description, created_at
       FROM incidents
       WHERE tenant_id = $1
       ORDER BY date DESC, created_at DESC`,
      [req.tenantId]
    );
    res.json({ incidents: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar incidencias' });
  }
});

export default router;
