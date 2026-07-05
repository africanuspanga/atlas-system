import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const onboardingSchema = z.object({
  school: z.object({
    name: z.string().min(2).max(200),
    slug: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    email: z.string().email(),
    phone: z.string().max(30).optional(),
    region: z.string().max(100).optional(),
    district: z.string().max(100).optional(),
    defaultLanguage: z.enum(['en', 'sw']).default('en'),
  }),
  academicYear: z.object({
    name: z.string().min(2).max(50),
    startsOn: isoDate,
    endsOn: isoDate,
    terms: z
      .array(
        z.object({
          name: z.string().min(1).max(50),
          startsOn: isoDate,
          endsOn: isoDate,
        }),
      )
      .min(1)
      .max(4),
  }),
  classes: z
    .array(
      z.object({
        educationLevel: z.enum([
          'pre_primary',
          'primary',
          'o_level',
          'a_level',
        ]),
        gradeName: z.string().min(1).max(50),
        sequence: z.number().int().min(1).max(30),
        streams: z.array(z.string().min(1).max(20)).min(1).max(12),
      }),
    )
    .min(1)
    .max(40),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;
