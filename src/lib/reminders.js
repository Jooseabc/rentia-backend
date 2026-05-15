// Cron interno (sin libs externas) para enviar recordatorios diarios
import { query } from './db.js';
import { mailEnabled, sendMail } from './mail.js';
import { getCycles, daysUntil, fmtDate, fmtMoney } from './cycles.js';

const REMINDER_DAYS_BEFORE = Number(process.env.REMINDER_DAYS_BEFORE || 3);

function toISODate(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function buildEmail({ tenant, cycle, kind, days }) {
  const subject =
    kind === 'reminder'
      ? `Recordatorio: tu alquiler vence el ${fmtDate(cycle.end)}`
      : `Pago vencido — ${Math.abs(days)} días de atraso`;

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f4efe3">
      <div style="background:#fff;border-radius:16px;padding:32px">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;background:#064e3b;color:#fde68a;border-radius:10px;font-weight:700;letter-spacing:.5px">R</div>
        <h1 style="font-family:Georgia,serif;color:#1c1917;margin:24px 0 8px;font-size:24px">
          ${kind === 'reminder' ? 'Recordatorio de pago' : 'Tu alquiler está vencido'}
        </h1>
        <p style="color:#57534e;line-height:1.6;margin:0 0 24px">
          Hola ${tenant.full_name.split(' ')[0]}, te escribimos para recordarte sobre el pago de tu alquiler${
            tenant.unit_name ? ` correspondiente a ${tenant.unit_name}` : ''
          }.
        </p>
        <div style="background:#fafaf9;border-radius:12px;padding:20px;margin-bottom:24px">
          <table style="width:100%;color:#1c1917;font-size:14px">
            <tr><td style="padding:6px 0;color:#78716c">Período</td><td style="text-align:right;font-weight:600">${fmtDate(cycle.start)} → ${fmtDate(cycle.end)}</td></tr>
            <tr><td style="padding:6px 0;color:#78716c">Vencimiento</td><td style="text-align:right;font-weight:600">${fmtDate(cycle.end)}</td></tr>
            <tr><td style="padding:6px 0;color:#78716c">Monto</td><td style="text-align:right;font-weight:700;font-size:18px">${fmtMoney(tenant.monthly_rent)}</td></tr>
          </table>
        </div>
        ${
          kind === 'overdue'
            ? `<div style="background:#fef2f2;border-left:3px solid #dc2626;padding:12px 16px;border-radius:6px;color:#991b1b;font-size:14px">⚠ Tu pago lleva ${Math.abs(days)} días de atraso. Por favor regulariza lo antes posible.</div>`
            : `<p style="color:#57534e;font-size:14px;margin:0">Vence en <strong>${days} día${days === 1 ? '' : 's'}</strong>.</p>`
        }
        <p style="color:#a8a29e;font-size:12px;margin-top:32px;text-align:center">
          Rentia · este es un mensaje automático
        </p>
      </div>
    </div>`;

  return { subject, html };
}

// Procesa un único inquilino y envía si corresponde. Devuelve { ok, kind, reason }.
// Usado por el cron y por el botón manual del admin (force=true ignora anti-dup).
export async function sendTenantReminder(tenantId, { force = false } = {}) {
  if (!mailEnabled()) return { ok: false, reason: 'SMTP no configurado en el servidor' };

  const r = await query(
    `SELECT t.*, u.name AS unit_name, p.name AS property_name
       FROM tenants t
  LEFT JOIN units u      ON u.id = t.unit_id
  LEFT JOIN properties p ON p.id = u.property_id
      WHERE t.id = $1`,
    [tenantId]
  );
  if (r.rowCount === 0) return { ok: false, reason: 'Inquilino no encontrado' };
  const tenant = r.rows[0];
  if (tenant.status !== 'active') return { ok: false, reason: 'Inquilino inactivo' };
  if (!tenant.email) return { ok: false, reason: 'El inquilino no tiene correo registrado' };

  const cycles = getCycles(tenant.entry_date);
  if (!cycles.length) return { ok: false, reason: 'Sin ciclos generados aún' };
  const cur = cycles[cycles.length - 1];

  const paid = (await query(
    `SELECT 1 FROM payments WHERE tenant_id = $1 AND voided_at IS NULL AND period_start = $2 LIMIT 1`,
    [tenant.id, cur.start]
  )).rowCount > 0;
  if (paid) return { ok: false, reason: 'El ciclo actual ya está pagado' };

  const days = daysUntil(cur.end);
  const kind = days < 0 ? 'overdue' : 'reminder';
  const reference = kind === 'overdue'
    ? `${cur.start}_overdue_${Math.abs(days)}_manual`
    : `${cur.start}_reminder_manual`;

  if (!force) {
    const exists = await query(
      'SELECT 1 FROM notifications_log WHERE tenant_id = $1 AND kind = $2 AND reference = $3',
      [tenant.id, kind, reference]
    );
    if (exists.rowCount > 0) return { ok: false, reason: 'Ya se envió un recordatorio reciente' };
  }

  const { subject, html } = buildEmail({ tenant, cycle: cur, kind, days });
  await sendMail({ to: tenant.email, subject, html });
  await query(
    'INSERT INTO notifications_log (tenant_id, kind, reference) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [tenant.id, kind, reference]
  );
  return { ok: true, kind };
}

async function processReminders() {
  if (!mailEnabled()) return;
  console.log('[reminders] Procesando recordatorios…');

  try {
    const tenants = (await query(
      `SELECT t.*, u.name AS unit_name, p.name AS property_name
       FROM tenants t
       LEFT JOIN units u      ON u.id = t.unit_id
       LEFT JOIN properties p ON p.id = u.property_id
       WHERE t.status = 'active' AND t.email IS NOT NULL AND t.email <> ''`
    )).rows;

    const payments = (await query('SELECT * FROM payments WHERE voided_at IS NULL')).rows;
    let sent = 0;

    for (const t of tenants) {
      const cycles = getCycles(t.entry_date);
      if (!cycles.length) continue;
      const cur = cycles[cycles.length - 1];
      const tp = payments.filter((p) => p.tenant_id === t.id);
      const paid = tp.some((p) => toISODate(p.period_start) === cur.start);
      if (paid) continue;

      const days = daysUntil(cur.end);
      let kind = null;
      // Recordatorio: dentro de la ventana previa al vencimiento
      if (days >= 0 && days <= REMINDER_DAYS_BEFORE) kind = 'reminder';
      // Vencido: cada 3 días de atraso
      else if (days < 0 && Math.abs(days) % 3 === 0) kind = 'overdue';
      if (!kind) continue;

      const reference = kind === 'overdue'
        ? `${cur.start}_overdue_${Math.abs(days)}`
        : `${cur.start}_reminder`;
      const exists = await query(
        'SELECT 1 FROM notifications_log WHERE tenant_id = $1 AND kind = $2 AND reference = $3',
        [t.id, kind, reference]
      );
      if (exists.rowCount > 0) continue;

      const { subject, html } = buildEmail({ tenant: t, cycle: cur, kind, days });

      try {
        await sendMail({ to: t.email, subject, html });
        await query(
          'INSERT INTO notifications_log (tenant_id, kind, reference) VALUES ($1, $2, $3)',
          [t.id, kind, reference]
        );
        sent++;
      } catch (err) {
        console.error('[reminders] Error enviando a', t.email, err.message);
      }
    }
    console.log(`[reminders] ✔ ${sent} correo(s) enviado(s)`);
  } catch (err) {
    console.error('[reminders] Error:', err);
  }
}

export function startReminderJob() {
  processReminders();
  setInterval(processReminders, 12 * 60 * 60 * 1000);
}

export { processReminders };
