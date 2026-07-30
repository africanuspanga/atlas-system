import { z } from 'zod';

export const createHostelSchema = z.object({
  name: z.string().trim().min(2).max(80),
  gender: z.enum(['male', 'female', 'mixed']),
});

export const createRoomSchema = z.object({
  hostelId: z.string().uuid(),
  name: z.string().trim().min(1).max(40),
  capacity: z.number().int().min(1).max(500),
});

export const allocateBedSchema = z.object({
  studentId: z.string().uuid(),
  roomId: z.string().uuid(),
  academicYearId: z.string().uuid(),
});
