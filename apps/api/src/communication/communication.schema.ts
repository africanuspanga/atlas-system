import { z } from 'zod';

export const createAnnouncementSchema = z
  .object({
    audienceType: z.enum(['all_guardians', 'class_section']),
    classSectionId: z.string().uuid().optional(),
    body: z.string().trim().min(3).max(480),
  })
  .refine(
    (value) => value.audienceType !== 'class_section' || !!value.classSectionId,
    { message: 'classSectionId is required for class_section audience' },
  );
