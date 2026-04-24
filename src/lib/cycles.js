import { query } from './db.js';

export function addMonthsISO(isoDate, months) {
  const str = typeof isoDate === 'string' ? isoDate.slice(0, 10) : new Date(isoDate).toISOString().slice(0, 10);
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(d, lastDay));
  return date.toISOString().slice(0, 10);
}

export function currentCycleIndex(entryISO, refDate = new Date()) {
  const str = typeof entryISO === 'string' ? entryISO.slice(0, 10) : new Date(entryISO).toISOString().slice(0, 10);
  const [eYear, eMonth, eDay] = str.split('-').map(Number);
  const today = new Date(refDate);
  const tYear = today.getFullYear();
  const tMonth = today.getMonth() + 1;
  const tDay = today.getDate();
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

export async function rentAtDate(tenantId, dateISO, defaultRent) {
  const r = await query(
    `SELECT new_rent FROM rent_changes
     WHERE tenant_id = $1 AND effective_date <= $2
     ORDER BY effective_date DESC LIMIT 1`,
    [tenantId, dateISO]
  );
  return r.rows[0] ? Number(r.rows[0].new_rent) : Number(defaultRent || 0);
}

export function daysUntil(isoDate, refDate = new Date()) {
  const d = new Date(isoDate.slice(0, 10) + 'T00:00:00');
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
  const str = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-PE', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}