import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const PAYMENT_METHODS = [
  'cash',
  'mpesa',
  'tigopesa',
  'airtel_money',
  'halopesa',
  'bank',
  'cheque',
  'other',
] as const;

export const createFeeItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  amount: z.number().positive().max(1_000_000_000),
  gradeLevelId: z.string().uuid().optional(),
  academicTermId: z.string().uuid().optional(),
});

const invoiceLineSchema = z.union([
  z.object({ feeItemId: z.string().uuid() }),
  z.object({
    description: z.string().trim().min(1).max(200),
    amount: z.number().positive().max(1_000_000_000),
  }),
]);

export const createInvoiceSchema = z.object({
  studentId: z.string().uuid(),
  academicTermId: z.string().uuid().optional(),
  dueOn: isoDate.optional(),
  lines: z.array(invoiceLineSchema).min(1).max(50),
});

export const recordPaymentSchema = z.object({
  amount: z.number().positive().max(1_000_000_000),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(100).optional(),
  paidOn: isoDate.optional(),
});

export const reversePaymentSchema = z.object({
  reason: z.string().trim().min(3).max(300),
});
