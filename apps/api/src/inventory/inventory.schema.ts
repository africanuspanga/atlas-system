import { z } from 'zod';

export const createItemSchema = z.object({
  name: z.string().trim().min(2).max(120),
  unit: z.string().trim().min(1).max(20).default('pcs'),
  reorderLevel: z.number().int().min(0).max(1000000).default(0),
});

export const moveInventorySchema = z.object({
  itemId: z.string().uuid(),
  kind: z.enum(['in', 'out']),
  quantity: z.number().int().min(1).max(1000000),
  note: z.string().trim().max(300).optional(),
});
