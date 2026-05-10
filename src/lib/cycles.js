import { query } from './db.js';

// Normaliza un valor (string ISO o Date) a "YYYY-MM-DD" sin sufrir corrimientos por TZ.
// pg devuelve columnas DATE como objetos Date en la TZ local, por lo que
// `new Date(...).toISOString()` puede retroceder un día en zonas con UTC negativo.
function toLocalISODate(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toISO(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function addMonthsISO(isoDate, months) {
  const str = toLocalISODate(isoDate);
  const [y, m, d] = str.split('-').map(Number);
  // Calcular año/mes destino sin construir Date (evita TZ).
  const totalMonths = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  // Último día del mes destino: el día 0 del mes siguiente.
  const lastDay = new Date(ny, nm, 0).getDate();
  return toISO(ny, nm, Math.min(d, lastDay));
}

export function currentCycleIndex(entryISO, refDate = new Date()) {
  const [eYear, eMonth, eDay] = toLocalISODate(entryISO).split('-').map(Number);
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
  const d = new Date(toLocalISODate(isoDate) + 'T00:00:00');
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
  const str = toLocalISODate(iso);
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-PE', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}