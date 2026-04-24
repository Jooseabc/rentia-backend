// Cron interno (sin libs externas) para enviar recordatorios diarios
import { query } from './db.js';
import { mailEnabled, sendMail } from './mail.js';
import { getCycles, daysUntil, fmtDate, fmtMoney } from './cycles.js';

const REMINDER_DAYS_BEFORE = Number(process.env.REMINDER_DAYS_BEFORE || 3);

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

    const payments = (await query('SELECT * FROM payments')).rows;
    let sent = 0;

    for (const t of tenants) {
      const cycles = getCycles(t.entry_date);
      if (!cycles.length) continue;
      const cur = cycles[cycles.length - 1];
      const tp = payments.filter((p) => p.tenant_id === t.id);
      const paid = tp.some((p) => p.period_start === cur.start);
      if (paid) continue;

      const days = daysUntil(cur.end);
      let kind = null;
      if (days === REMINDER_DAYS_BEFORE) kind = 'reminder';
      else if (days < 0 && days % 3 === 0) kind = 'overdue';
      if (!kind) continue;

      // Anti-duplicados
      const reference = `${cur.start}_${kind}_${days}`;
      const exists = await query(
        'SELECT 1 FROM notifications_log WHERE tenant_id = $1 AND kind = $2 AND reference = $3',
        [t.id, kind, reference]
      );
      if (exists.rowCount > 0) continue;

      const subject =
        kind === 'reminder'
          ? `Recordatorio: tu alquiler vence el ${fmtDate(cur.end)}`
          : `Pago vencido — ${Math.abs(days)} días de atraso`;

      const html = `
        <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f4efe3">
          <div style="background:#fff;border-radius:16px;padding:32px">
            <div style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;background:#064e3b;color:#fde68a;border-radius:10px;font-weight:700;letter-spacing:.5px">SAA</div>
            <h1 style="font-family:Georgia,serif;color:#1c1917;margin:24px 0 8px;font-size:24px">
              ${kind === 'reminder' ? 'Recordatorio de pago' : 'Tu alquiler está vencido'}
            </h1>
            <p style="color:#57534e;line-height:1.6;margin:0 0 24px">
              Hola ${t.full_name.split(' ')[0]}, te escribimos para recordarte sobre el pago de tu alquiler${
                t.unit_name ? ` correspondiente a ${t.unit_name}` : ''
              }.
            </p>
            <div style="background:#fafaf9;border-radius:12px;padding:20px;margin-bottom:24px">
              <table style="width:100%;color:#1c1917;font-size:14px">
                <tr><td style="padding:6px 0;color:#78716c">Período</td><td style="text-align:right;font-weight:600">${fmtDate(cur.start)} → ${fmtDate(cur.end)}</td></tr>
                <tr><td style="padding:6px 0;color:#78716c">Vencimiento</td><td style="text-align:right;font-weight:600">${fmtDate(cur.end)}</td></tr>
                <tr><td style="padding:6px 0;color:#78716c">Monto</td><td style="text-align:right;font-weight:700;font-size:18px">${fmtMoney(t.monthly_rent)}</td></tr>
              </table>
            </div>
            ${
              kind === 'overdue'
                ? `<div style="background:#fef2f2;border-left:3px solid #dc2626;padding:12px 16px;border-radius:6px;color:#991b1b;font-size:14px">⚠ Tu pago lleva ${Math.abs(days)} días de atraso. Por favor regulariza lo antes posible.</div>`
                : `<p style="color:#57534e;font-size:14px;margin:0">Vence en <strong>${days} día${days === 1 ? '' : 's'}</strong>.</p>`
            }
            <p style="color:#a8a29e;font-size:12px;margin-top:32px;text-align:center">
              Sistema Automatizado de Alquileres · este es un mensaje automático
            </p>
          </div>
        </div>`;

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
  // Ejecutar inmediatamente y luego cada 12 horas
  processReminders();
  setInterval(processReminders, 12 * 60 * 60 * 1000);
}

export { processReminders };
