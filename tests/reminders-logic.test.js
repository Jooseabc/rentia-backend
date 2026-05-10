import { test } from 'node:test';
import assert from 'node:assert/strict';

// Replica la lógica de matching de pagos por ciclo (la del fix de reminders.js).
// Si esto vuelve a romperse, los recordatorios se enviarían a quien ya pagó.
function toISODate(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function isCyclePaid(cycle, payments) {
  return payments.some((p) => toISODate(p.period_start) === cycle.start);
}

test('isCyclePaid: detecta pago aunque venga como Date (caso pg)', () => {
  const cycle = { start: '2025-04-15' };
  const payments = [{ period_start: new Date('2025-04-15T00:00:00Z') }];
  assert.equal(isCyclePaid(cycle, payments), true);
});

test('isCyclePaid: detecta pago string vs string', () => {
  const cycle = { start: '2025-04-15' };
  const payments = [{ period_start: '2025-04-15' }];
  assert.equal(isCyclePaid(cycle, payments), true);
});

test('isCyclePaid: pago de otro ciclo no cuenta', () => {
  const cycle = { start: '2025-04-15' };
  const payments = [{ period_start: '2025-03-15' }];
  assert.equal(isCyclePaid(cycle, payments), false);
});

test('isCyclePaid: lista vacía → false', () => {
  assert.equal(isCyclePaid({ start: '2025-04-15' }, []), false);
});

// Ventana del recordatorio: días [0..N] antes del vencimiento, no día exacto.
function shouldRemind(daysUntilDue, windowDays) {
  return daysUntilDue >= 0 && daysUntilDue <= windowDays;
}

test('shouldRemind: dispara dentro de la ventana', () => {
  assert.equal(shouldRemind(3, 3), true);
  assert.equal(shouldRemind(0, 3), true);
  assert.equal(shouldRemind(1, 3), true);
});

test('shouldRemind: no dispara fuera de la ventana', () => {
  assert.equal(shouldRemind(4, 3), false);
  assert.equal(shouldRemind(-1, 3), false);
});

// Lógica de overdue cada 3 días.
function isOverdueDay(daysUntilDue) {
  return daysUntilDue < 0 && Math.abs(daysUntilDue) % 3 === 0;
}

test('isOverdueDay: dispara en múltiplos de 3', () => {
  assert.equal(isOverdueDay(-3), true);
  assert.equal(isOverdueDay(-6), true);
  assert.equal(isOverdueDay(-9), true);
});

test('isOverdueDay: no dispara en otros días', () => {
  assert.equal(isOverdueDay(-1), false);
  assert.equal(isOverdueDay(-2), false);
  assert.equal(isOverdueDay(-4), false);
  assert.equal(isOverdueDay(0), false);
  assert.equal(isOverdueDay(3), false);
});
