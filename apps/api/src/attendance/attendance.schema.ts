import { z } from 'zod';

const isoDate = z.string().date('Expected YYYY-MM-DD');

export const attendanceStatusSchema = z.enum([
  'present',
  'absent',
  'late',
  'excused',
]);

export const markAttendanceSchema = z.object({
  classSectionId: z.string().uuid(),
  date: isoDate,
  records: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        status: attendanceStatusSchema,
        note: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(500),
});

export type MarkAttendanceRequest = z.infer<typeof markAttendanceSchema>;
