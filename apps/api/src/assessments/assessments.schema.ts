import { z } from 'zod';

const educationLevel = z.enum(['pre_primary', 'primary', 'o_level', 'a_level']);

export const createSubjectSchema = z.object({
  code: z.string().trim().min(1).max(10).toUpperCase(),
  name: z.string().trim().min(1).max(100),
  nameSw: z.string().trim().min(1).max(100).optional(),
  educationLevel,
});

export const presetSubjectsSchema = z.object({
  educationLevel: z.enum(['primary', 'o_level', 'a_level']),
});

export const createAssessmentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['test', 'midterm', 'terminal', 'mock', 'other']).default('test'),
  classSectionId: z.string().uuid(),
  academicTermId: z.string().uuid(),
  weight: z.number().positive().max(10).default(1),
});

export const recordScoresSchema = z.object({
  subjectId: z.string().uuid(),
  rows: z
    .array(
      z.object({
        studentId: z.string().uuid(),
        marks: z.number().min(0).max(100),
      }),
    )
    .min(1)
    .max(500),
});

export const reportCardQuerySchema = z.object({
  studentId: z.string().uuid(),
  termId: z.string().uuid(),
});
