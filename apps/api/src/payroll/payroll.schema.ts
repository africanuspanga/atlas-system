import { z } from 'zod';

/** Payroll period, e.g. "2026-07". */
export const periodRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

export const setSalarySchema = z.object({
  userId: z.string().uuid(),
  // Same upper bound as finance money amounts (see finance.schema.ts).
  basic: z.number().positive().max(1_000_000_000),
  allowances: z.number().nonnegative().max(1_000_000_000).default(0),
  hasHeslb: z.boolean().default(false),
});

export const createRunSchema = z.object({
  period: z.string().regex(periodRegex, 'Expected YYYY-MM'),
});

/**
 * Payroll settings (statutory rates). Kept permissive but typed — the RPC
 * (`update_payroll_settings`) validates the shape and raises
 * PAYROLL_SETTINGS_INVALID on bad values.
 */
export const payeBandSchema = z.object({
  up_to: z.number().nonnegative().nullable(),
  rate: z.number().nonnegative(),
});

export const payrollRatesSchema = z
  .object({
    paye_bands: z.array(payeBandSchema),
    nssf_employee_rate: z.number().nonnegative(),
    heslb_rate: z.number().nonnegative(),
    employer: z.record(z.string(), z.number()),
  })
  .passthrough();

export const updateSettingsSchema = z.object({
  rates: payrollRatesSchema,
  verified: z.boolean(),
});
