import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

// Replica del schema usado en routes/tenants.js. Mantenerlos alineados.
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

const validBase = {
  tenant_id: '00000000-0000-0000-0000-000000000001',
  period_start: '2025-04-15',
  period_end: '2025-05-15',
  paid_date: '2025-04-20',
  amount: 1500,
};

test('paymentSchema: payload válido', () => {
  const r = paymentSchema.safeParse(validBase);
  assert.equal(r.success, true);
});

test('paymentSchema: rechaza período invertido', () => {
  const r = paymentSchema.safeParse({
    ...validBase,
    period_start: '2025-05-15',
    period_end: '2025-04-15',
  });
  assert.equal(r.success, false);
});

test('paymentSchema: rechaza paid_date previo al inicio del período', () => {
  const r = paymentSchema.safeParse({
    ...validBase,
    paid_date: '2025-04-14',
  });
  assert.equal(r.success, false);
});

test('paymentSchema: rechaza monto negativo o cero', () => {
  assert.equal(paymentSchema.safeParse({ ...validBase, amount: 0 }).success, false);
  assert.equal(paymentSchema.safeParse({ ...validBase, amount: -100 }).success, false);
});

test('paymentSchema: rechaza fechas mal formateadas', () => {
  assert.equal(paymentSchema.safeParse({ ...validBase, period_start: '15/04/2025' }).success, false);
  assert.equal(paymentSchema.safeParse({ ...validBase, paid_date: '2025-4-20' }).success, false);
});

test('paymentSchema: tenant_id debe ser UUID', () => {
  assert.equal(paymentSchema.safeParse({ ...validBase, tenant_id: 'not-a-uuid' }).success, false);
});
