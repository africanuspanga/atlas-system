import { z } from 'zod';

export const createRouteSchema = z.object({
  name: z.string().trim().min(2).max(80),
  feeAmount: z.number().min(0).max(1e9).default(0),
});

export const createStopSchema = z.object({
  routeId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export const assignTransportSchema = z.object({
  studentId: z.string().uuid(),
  routeId: z.string().uuid(),
  stopId: z.string().uuid().nullish(),
  academicYearId: z.string().uuid(),
});
