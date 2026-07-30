import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const recordVisitSchema = z.object({
  studentId: z.string().uuid(),
  symptoms: z.string().trim().min(2).max(1000),
  treatment: z.string().trim().max(1000).optional(),
  notes: z.string().trim().max(1000).optional(),
  notifyGuardian: z.boolean().default(false),
});

export const visitsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
