import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const createBookSchema = z.object({
  code: z.string().trim().min(1).max(40),
  title: z.string().trim().min(2).max(200),
  author: z.string().trim().min(1).max(120).optional(),
  subjectId: z.string().uuid().optional(),
  copiesTotal: z.number().int().min(1).max(100000),
});

export const loanBookSchema = z.object({
  bookId: z.string().uuid(),
  studentId: z.string().uuid(),
  dueOn: isoDate,
});
