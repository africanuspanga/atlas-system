import { z } from 'zod';

const isoDay = z.string().date('Expected YYYY-MM-DD');

/**
 * Academic-year rollover (migration 0030, LIFE-030-D). academic_years,
 * academic_terms, grade_levels and class_sections were written in exactly one
 * place — inside app.onboard_school — so a school was permanently frozen in
 * the single year it typed into the onboarding wizard.
 */
export const createYearSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    startsOn: isoDay,
    endsOn: isoDay,
    /** Copy the grade/stream grid from a previous year instead of retyping it. */
    cloneSectionsFromYearId: z.string().uuid().optional(),
    terms: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(50),
          startsOn: isoDay,
          endsOn: isoDay,
        }),
      )
      .min(1)
      .max(6),
  })
  .refine((v) => v.endsOn > v.startsOn, {
    message: 'endsOn must be after startsOn',
    path: ['endsOn'],
  })
  .refine((v) => v.terms.every((t) => t.endsOn > t.startsOn), {
    message: 'each term must end after it starts',
    path: ['terms'],
  });

export const createGradeLevelSchema = z.object({
  educationLevel: z.enum(['pre_primary', 'primary', 'o_level', 'a_level']),
  name: z.string().trim().min(1).max(50),
  sequence: z.number().int().min(1).max(100),
});

export const createSectionSchema = z.object({
  academicYearId: z.string().uuid(),
  gradeLevelId: z.string().uuid(),
  /** Stream label — class_sections.name holds "A"/"B"; there is no stream column. */
  name: z.string().trim().min(1).max(20),
  capacity: z.number().int().min(1).max(500).optional(),
  campusId: z.string().uuid().optional(),
});

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
  type: z
    .enum(['test', 'midterm', 'terminal', 'mock', 'other'])
    .default('test'),
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

export const assignCombinationSchema = z.object({
  combinationId: z.string().uuid(),
  academicYearId: z.string().uuid(),
});

export const caSummaryQuerySchema = z.object({
  sectionId: z.string().uuid(),
  yearId: z.string().uuid(),
});

export const sectionQuerySchema = z.object({
  sectionId: z.string().uuid(),
});
