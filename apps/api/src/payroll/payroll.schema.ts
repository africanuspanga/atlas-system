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

export const payeBandSchema = z.object({
  up_to: z.number().nonnegative().max(1_000_000_000).nullable(),
  rate: z.number().min(0).max(1),
});

const payeBandsSchema = z
  .array(payeBandSchema)
  .min(1)
  .max(20)
  .superRefine((bands, ctx) => {
    if (bands.at(-1)?.up_to !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Last PAYE band must be open-ended',
      });
    }
    let previous = -1;
    bands.slice(0, -1).forEach((band, index) => {
      if (band.up_to === null || band.up_to <= previous) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'up_to'],
          message: 'PAYE bands must be strictly ascending',
        });
      } else {
        previous = band.up_to;
      }
    });
  });

export const payrollRatesSchema = z
  .object({
    paye_bands: payeBandsSchema,
    nssf_employee_rate: z.number().min(0).max(1),
    heslb_rate: z.number().min(0).max(1),
    employer: z.object({
      nssf_rate: z.number().min(0).max(1),
      wcf_rate: z.number().min(0).max(1),
      sdl_rate: z.number().min(0).max(1),
    }),
  })
  .passthrough();

export const updateSettingsSchema = z.object({
  rates: payrollRatesSchema,
  verified: z.boolean(),
});
