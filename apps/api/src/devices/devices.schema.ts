import { z } from 'zod';

export const registerDeviceSchema = z.object({
  token: z.string().trim().min(10).max(300),
  platform: z.enum(['ios', 'android']),
  tenantId: z.string().uuid().optional(),
});

export const unregisterDeviceSchema = z.object({
  token: z.string().trim().min(10).max(300),
});
