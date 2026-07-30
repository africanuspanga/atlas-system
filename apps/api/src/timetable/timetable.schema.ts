import { z } from 'zod';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const createPeriodsSchema = z.object({
  periods: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(40),
        startsAt: z.string().regex(TIME_RE, 'expected HH:MM'),
        endsAt: z.string().regex(TIME_RE, 'expected HH:MM'),
        isBreak: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(20),
});

export const timetableQuerySchema = z
  .object({
    sectionId: z.string().uuid().optional(),
    teacherUserId: z.literal('me').optional(),
  })
  .refine((q) => Boolean(q.sectionId) !== Boolean(q.teacherUserId), {
    message: 'provide exactly one of sectionId or teacherUserId=me',
  });

export const setSlotSchema = z.object({
  sectionId: z.string().uuid(),
  day: z.number().int().min(1).max(5),
  periodId: z.string().uuid(),
  subjectId: z.string().uuid(),
  teacherUserId: z.string().uuid(),
});
