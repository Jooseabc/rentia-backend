// Lógica de ciclos de pago, compartida entre PDF, notificaciones y resúmenes
import { query } from './db.js';

export function addMonthsISO(isoDate, months) {
  const d = new Date(isoDate + 'T00:00:00');
  const day = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}

export function currentCycleIndex(entryISO, refDate = new Date()) {
  const [eYear, eMonth, eDay] = entryISO.split('-').map(Number);
  const today = new Date(refDate);
  const tYear = today.getUTCFullYear();
  const tMonth = today.getUTCMonth() + 1;
  const tDay = today.getUTCDate();

  let months = (tYear - eYear) * 12 + (tMonth - eMonth);
  if (tDay < eDay) months--;

  return Math.max(0, months);
}

export function getCycles(entryISO, refDate = new Date()) {
  const cur = currentCycleIndex(entryISO, refDate);
  return Array.from({ length: cur + 1 }, (_, i) => ({
    index: i,
    start: addMonthsISO(entryISO, i),
    end: addMonthsISO(entryISO, i + 1),
  }));
}

// Devuelve la renta efectiva en una fecha dada considerando aumentos
export async function rentAtDate(tenantId, dateISO, defaultRent) {
  const r = await query(
    `SELECT new_rent FROM rent_changes
     WHERE tenant_id = $1 AND effective_date <= $2
     ORDER BY effective_date DESC LIMIT 1`,
    [tenantId, dateISO]
  );
  return r.rows[0] ? Number(r.rows[0].new_rent) : Number(defaultRent || 0);
}

// Días hasta una fecha dada (negativo si pasó)
export function daysUntil(isoDate, refDate = new Date()) {
  const d = new Date(isoDate + 'T00:00:00');
  const t = new Date(refDate);
  t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / (1000 * 60 * 60 * 24));
}

export function fmtMoney(n, currency = 'S/') {
  return `${currency} ${Number(n || 0).toLocaleString('es-PE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso + 'T00:00:00') : new Date(iso);
  return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' });
}
