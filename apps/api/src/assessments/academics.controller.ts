import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import {
  assignCombinationSchema,
  caSummaryQuerySchema,
  createGradeLevelSchema,
  createSectionSchema,
  createYearSchema,
  sectionQuerySchema,
} from './assessments.schema';
import { COMBINATION_PRESETS } from './combinations.presets';

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'ACADEMICS_RPC_FAILED',
    message: error.message,
  });
}

/**
 * RFC-4180-ish CSV field: quote when it contains a comma, quote or newline.
 * Also neutralises spreadsheet formula injection by prefixing a leading
 * =, +, -, @, tab or CR with a single quote before escaping.
 */
function csvField(value: string | null | undefined): string {
  let s = value ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface CombinationRow {
  id: string;
  code: string;
  name: string;
  subject_combination_subjects: Array<{
    is_principal: boolean;
    subjects: { id: string; code: string; name: string } | null;
  }>;
}

/** NECTA academic pack: A-Level combinations, CA summary, candidate export. */
@Controller('academics')
@UseGuards(AuthGuard, TenantGuard)
export class AcademicsController {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Inserts the standard ACSEE combination presets, resolving subject ids by
   * code for this tenant. Combinations whose subjects are not all present
   * (or that already exist) are skipped — idempotent like /subjects/preset.
   */
  /**
   * Academic-year rollover — LIFE-030-D. Creates the next year, its terms and
   * (optionally) a clone of an existing year's section grid. Without this a
   * school onboarded in 2026 had no path into 2027 at all: every one of these
   * four tables was written only inside app.onboard_school, which runs once.
   */
  @Post('years')
  @RequirePermission('academics.manage')
  async createYear(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createYearSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'YEAR_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'create_academic_year',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_payload: parsed.data,
      },
    );
    if (error) {
      rpcError(error, [
        'YEAR_NAME_REQUIRED',
        'YEAR_NAME_TAKEN',
        'YEAR_TERMS_REQUIRED',
        'YEAR_CLONE_SOURCE_NOT_FOUND',
      ]);
    }
    return data as Record<string, unknown>;
  }

  /**
   * Makes a year the active one and closes the previous. students.controller's
   * loadContext resolves sections via the newest year with status='active', so
   * two simultaneously-active years would make that lookup non-deterministic.
   */
  @Post('years/:id/activate')
  @RequirePermission('academics.manage')
  async activateYear(@Req() req: TenantRequest, @Param('id') id: string) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'activate_academic_year',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_year_id: id,
      },
    );
    if (error) rpcError(error, ['YEAR_NOT_FOUND']);
    return data as Record<string, unknown>;
  }

  @Post('grade-levels')
  @RequirePermission('academics.manage')
  async createGradeLevel(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createGradeLevelSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'GRADE_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'create_grade_level',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_education_level: parsed.data.educationLevel,
        p_name: parsed.data.name,
        p_sequence: parsed.data.sequence,
      },
    );
    if (error) rpcError(error, ['GRADE_LEVEL_INVALID', 'GRADE_NAME_TAKEN']);
    return data as Record<string, unknown>;
  }

  @Post('sections')
  @RequirePermission('academics.manage')
  async createSection(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createSectionSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'SECTION_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'create_class_section',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_year_id: parsed.data.academicYearId,
        p_grade_id: parsed.data.gradeLevelId,
        p_name: parsed.data.name,
        p_capacity: parsed.data.capacity ?? null,
        p_campus_id: parsed.data.campusId ?? null,
      },
    );
    if (error) {
      rpcError(error, [
        'SECTION_YEAR_NOT_FOUND',
        'SECTION_GRADE_NOT_FOUND',
        'SECTION_CAMPUS_NOT_FOUND',
        'SECTION_NAME_TAKEN',
      ]);
    }
    return data as Record<string, unknown>;
  }

  @Post('combinations/preset')
  @RequirePermission('academics.combinations.manage')
  async preset(@Req() req: TenantRequest) {
    const [
      { data: subjects, error: subjectsLookupError },
      { data: existing, error: existingError },
    ] = await Promise.all([
      this.supabase.admin
        .from('subjects')
        .select('id, code')
        .eq('tenant_id', req.tenant.tenantId)
        .eq('education_level', 'a_level')
        .eq('status', 'active'),
      this.supabase.admin
        .from('subject_combinations')
        .select('code')
        .eq('tenant_id', req.tenant.tenantId),
    ]);
    if (subjectsLookupError || existingError) {
      throw new InternalServerErrorException({
        code: 'COMBINATION_PRESET_FAILED',
        message: (subjectsLookupError ?? existingError)?.message,
      });
    }
    const subjectIdByCode = new Map(
      (subjects ?? []).map((s) => [s.code as string, s.id as string]),
    );
    const have = new Set((existing ?? []).map((c) => c.code as string));

    let created = 0;
    for (const preset of COMBINATION_PRESETS) {
      if (have.has(preset.code)) continue;
      const resolved = preset.subjects.map((s) => ({
        subjectId: subjectIdByCode.get(s.code),
        isPrincipal: s.isPrincipal,
      }));
      if (resolved.some((s) => !s.subjectId)) continue; // subject missing → skip

      const { data: combination, error } = await this.supabase.admin
        .from('subject_combinations')
        .insert({
          tenant_id: req.tenant.tenantId,
          code: preset.code,
          name: preset.name,
        })
        .select('id')
        .single();
      if (error) {
        throw new InternalServerErrorException({
          code: 'COMBINATION_PRESET_FAILED',
          message: error.message,
        });
      }
      const { error: subjectsError } = await this.supabase.admin
        .from('subject_combination_subjects')
        .insert(
          resolved.map((s) => ({
            combination_id: combination.id as string,
            subject_id: s.subjectId,
            is_principal: s.isPrincipal,
          })),
        );
      if (subjectsError) {
        throw new InternalServerErrorException({
          code: 'COMBINATION_PRESET_FAILED',
          message: subjectsError.message,
        });
      }
      created += 1;
    }
    return { created, skipped: COMBINATION_PRESETS.length - created };
  }

  @Get('combinations')
  @RequirePermission('students.view')
  async listCombinations(@Req() req: TenantRequest) {
    const { data, error } = await this.supabase.admin
      .from('subject_combinations')
      .select(
        'id, code, name, subject_combination_subjects(is_principal, subjects(id, code, name))',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .order('code');
    if (error) {
      throw new InternalServerErrorException({
        code: 'COMBINATION_LIST_FAILED',
        message: error.message,
      });
    }
    const rows = ((data ?? []) as unknown as CombinationRow[]).map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      subjects: c.subject_combination_subjects
        .filter((s) => s.subjects !== null)
        .map((s) => ({
          id: s.subjects?.id,
          code: s.subjects?.code,
          name: s.subjects?.name,
          isPrincipal: s.is_principal,
        }))
        .sort((a, b) =>
          a.isPrincipal === b.isPrincipal
            ? (a.code ?? '').localeCompare(b.code ?? '')
            : a.isPrincipal
              ? -1
              : 1,
        ),
    }));
    return { data: rows };
  }

  /**
   * Roster for the combination-assignment UI: active students of one section
   * with their current combination for the section's academic year.
   */
  @Get('combinations/roster')
  @RequirePermission('students.view')
  async roster(@Req() req: TenantRequest, @Query() query: unknown) {
    const parsed = sectionQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'ROSTER_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { data: section, error: sectionError } = await this.supabase.admin
      .from('class_sections')
      .select('id, academic_year_id, grade_levels(education_level)')
      .eq('id', parsed.data.sectionId)
      .eq('tenant_id', req.tenant.tenantId)
      .maybeSingle();
    if (sectionError) {
      throw new InternalServerErrorException({
        code: 'ROSTER_QUERY_FAILED',
        message: sectionError.message,
      });
    }
    if (!section) {
      throw new BadRequestException({ code: 'ROSTER_SECTION_NOT_FOUND' });
    }
    const yearId = section.academic_year_id as string;
    // Fetch the section's enrolments first (bounded to one section/year), then
    // look up combinations for exactly those students — an unbounded query over
    // the whole tenant would truncate at 1000 rows for large schools.
    const { data: enrolments, error: enrolmentsError } =
      await this.supabase.admin
        .from('class_enrolments')
        .select(
          'students(id, student_number, first_name, middle_name, last_name)',
        )
        .eq('tenant_id', req.tenant.tenantId)
        .eq('class_section_id', parsed.data.sectionId)
        .eq('academic_year_id', yearId)
        .eq('status', 'active')
        .limit(500);
    if (enrolmentsError) {
      throw new InternalServerErrorException({
        code: 'ROSTER_QUERY_FAILED',
        message: enrolmentsError.message,
      });
    }
    const roster = (enrolments ?? [])
      .map(
        (e) =>
          e.students as unknown as {
            id: string;
            student_number: string;
            first_name: string;
            middle_name: string | null;
            last_name: string;
          } | null,
      )
      .filter((s): s is NonNullable<typeof s> => s !== null);
    const studentIds = roster.map((s) => s.id);
    let assignments: Array<{ student_id: string; combination_id: string }> = [];
    if (studentIds.length > 0) {
      const { data: assignmentsData, error: assignmentsError } =
        await this.supabase.admin
          .from('student_combinations')
          .select('student_id, combination_id')
          .eq('tenant_id', req.tenant.tenantId)
          .eq('academic_year_id', yearId)
          .in('student_id', studentIds);
      if (assignmentsError) {
        throw new InternalServerErrorException({
          code: 'ROSTER_QUERY_FAILED',
          message: assignmentsError.message,
        });
      }
      assignments = assignmentsData ?? [];
    }
    const combinationByStudent = new Map(
      assignments.map((a) => [a.student_id, a.combination_id]),
    );
    const students = roster
      .map((s) => ({
        id: s.id,
        studentNumber: s.student_number,
        name: [s.first_name, s.middle_name, s.last_name]
          .filter(Boolean)
          .join(' '),
        combinationId: combinationByStudent.get(s.id) ?? null,
      }))
      .sort((a, b) => a.studentNumber.localeCompare(b.studentNumber));
    return {
      sectionId: parsed.data.sectionId,
      academicYearId: yearId,
      educationLevel:
        (section.grade_levels as unknown as { education_level: string } | null)
          ?.education_level ?? null,
      students,
    };
  }

  @Post('students/:id/combination')
  @RequirePermission('academics.combinations.manage')
  async assign(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = assignCombinationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'COMBINATION_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'assign_student_combination',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_student_id: id,
        p_combination_id: parsed.data.combinationId,
        p_year_id: parsed.data.academicYearId,
      },
    );
    if (error) {
      rpcError(error, [
        'COMBINATION_NOT_FOUND',
        'COMBINATION_YEAR_NOT_FOUND',
        'COMBINATION_STUDENT_NOT_FOUND',
        'COMBINATION_NOT_A_LEVEL',
      ]);
    }
    return data as { studentCombinationId: string; combinationCode: string };
  }

  @Get('ca-summary')
  @RequirePermission('students.view')
  async caSummary(@Req() req: TenantRequest, @Query() query: unknown) {
    const parsed = caSummaryQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'CA_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('report_ca_summary', {
      p_tenant_id: req.tenant.tenantId,
      p_section_id: parsed.data.sectionId,
      p_year_id: parsed.data.yearId,
    });
    if (error) {
      rpcError(error, ['CA_SECTION_NOT_FOUND', 'CA_YEAR_NOT_FOUND']);
    }
    return data as Record<string, unknown>;
  }

  @Get('candidates-export')
  @RequirePermission('academics.manage')
  async candidatesExport(@Req() req: TenantRequest, @Query() query: unknown) {
    const parsed = sectionQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'EXPORT_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('export_candidates', {
      p_tenant_id: req.tenant.tenantId,
      p_section_id: parsed.data.sectionId,
    });
    if (error) {
      rpcError(error, ['EXPORT_SECTION_NOT_FOUND']);
    }
    const payload = data as {
      section: string;
      educationLevel: string;
      candidates: number;
      rows: Array<{
        studentNumber: string;
        fullName: string;
        gender: string;
        dateOfBirth: string | null;
        combination: string | null;
      }>;
    };
    const aLevel = payload.educationLevel === 'a_level';
    const header = [
      'student_number',
      'full_name',
      'gender',
      'date_of_birth',
      ...(aLevel ? ['combination'] : []),
    ];
    const csv = [
      header.join(','),
      ...payload.rows.map((r) =>
        [
          csvField(r.studentNumber),
          csvField(r.fullName),
          csvField(r.gender),
          csvField(r.dateOfBirth),
          ...(aLevel ? [csvField(r.combination)] : []),
        ].join(','),
      ),
    ].join('\n');
    return { ...payload, csv };
  }
}
