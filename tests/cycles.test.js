import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonthsISO, currentCycleIndex, getCycles, daysUntil } from '../src/lib/cycles.js';

test('addMonthsISO: caso simple', () => {
  assert.equal(addMonthsISO('2025-01-15', 1), '2025-02-15');
  assert.equal(addMonthsISO('2025-01-15', 12), '2026-01-15');
  assert.equal(addMonthsISO('2025-01-15', 0), '2025-01-15');
});

test('addMonthsISO: cruza año', () => {
  assert.equal(addMonthsISO('2025-12-15', 1), '2026-01-15');
  assert.equal(addMonthsISO('2025-12-15', 13), '2027-01-15');
});

test('addMonthsISO: día 31 en mes corto cae al último día', () => {
  assert.equal(addMonthsISO('2025-01-31', 1), '2025-02-28');
  assert.equal(addMonthsISO('2024-01-31', 1), '2024-02-29'); // bisiesto
  assert.equal(addMonthsISO('2025-03-31', 1), '2025-04-30');
});

test('addMonthsISO: acepta objetos Date sin corrimiento por TZ', () => {
  // Simula lo que pg devuelve para una columna DATE: medianoche local.
  const d = new Date(2025, 0, 31); // 2025-01-31 local
  assert.equal(addMonthsISO(d, 1), '2025-02-28');
});

test('currentCycleIndex: mismo mes que entrada', () => {
  const refDate = new Date(2025, 0, 20); // 20 ene 2025
  assert.equal(currentCycleIndex('2025-01-15', refDate), 0);
});

test('currentCycleIndex: justo antes del día de corte', () => {
  // entrada 15, hoy 14 del mes siguiente → todavía estás en el ciclo previo
  const refDate = new Date(2025, 1, 14); // 14 feb 2025
  assert.equal(currentCycleIndex('2025-01-15', refDate), 0);
});

test('currentCycleIndex: el día de corte avanza el ciclo', () => {
  const refDate = new Date(2025, 1, 15); // 15 feb 2025
  assert.equal(currentCycleIndex('2025-01-15', refDate), 1);
});

test('currentCycleIndex: nunca devuelve negativo', () => {
  const refDate = new Date(2024, 0, 1); // 1 ene 2024
  assert.equal(currentCycleIndex('2025-06-15', refDate), 0);
});

test('getCycles: produce N+1 ciclos contiguos', () => {
  const refDate = new Date(2025, 5, 20); // 20 jun 2025
  const cycles = getCycles('2025-01-15', refDate);
  assert.equal(cycles.length, 6); // ene→feb, …, jun→jul
  assert.equal(cycles[0].start, '2025-01-15');
  assert.equal(cycles[0].end, '2025-02-15');
  assert.equal(cycles[5].start, '2025-06-15');
  assert.equal(cycles[5].end, '2025-07-15');
});

test('daysUntil: hoy es 0', () => {
  const today = new Date(2025, 5, 20);
  assert.equal(daysUntil('2025-06-20', today), 0);
});

test('daysUntil: futuro positivo, pasado negativo', () => {
  const today = new Date(2025, 5, 20);
  assert.equal(daysUntil('2025-06-23', today), 3);
  assert.equal(daysUntil('2025-06-17', today), -3);
});
