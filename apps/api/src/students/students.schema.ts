import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const studentRowSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  middleName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().min(1).max(100),
  gender: z.enum(['male', 'female']),
  dateOfBirth: isoDate.optional(),
  boardingStatus: z.enum(['day', 'boarding']).default('day'),
  /** Resolved server-side from className/stream for imports. */
  classSectionId: z.string().uuid().optional(),
  guardian: z
    .object({
      fullName: z.string().trim().min(1).max(200),
      phone: z.string().trim().max(30).optional(),
      relationship: z
        .enum(['mother', 'father', 'guardian', 'sponsor', 'other'])
        .default('guardian'),
    })
    .optional(),
});

/** Raw Excel row: class targeted by name + stream, resolved server-side. */
export const importRowSchema = studentRowSchema
  .omit({ classSectionId: true })
  .extend({
    className: z.string().trim().min(1).max(50).optional(),
    stream: z.string().trim().max(20).optional(),
  });

export const importRequestSchema = z.object({
  rows: z.array(importRowSchema).min(1).max(2000),
  dryRun: z.boolean().default(false),
});

export type StudentRow = z.infer<typeof studentRowSchema>;
export type ImportRow = z.infer<typeof importRowSchema>;
