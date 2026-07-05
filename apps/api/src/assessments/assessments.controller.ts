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
  createAssessmentSchema,
  createSubjectSchema,
  presetSubjectsSchema,
  recordScoresSchema,
  reportCardQuerySchema,
} from './assessments.schema';
import { SUBJECT_PRESETS } from './subjects.presets';

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'ASSESSMENTS_RPC_FAILED',
    message: error.message,
  });
}

@Controller('subjects')
@UseGuards(AuthGuard, TenantGuard)
export class SubjectsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Post()
  @RequirePermission('academics.manage')
  async create(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createSubjectSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'SUBJECT_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { error } = await this.supabase.admin.from('subjects').insert({
      tenant_id: req.tenant.tenantId,
      code: parsed.data.code,
      name: parsed.data.name,
      name_sw: parsed.data.nameSw ?? null,
      education_level: parsed.data.educationLevel,
    });
    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException({ code: 'SUBJECT_DUPLICATE_CODE' });
      }
      throw new InternalServerErrorException({
        code: 'SUBJECT_CREATE_FAILED',
        message: error.message,
      });
    }
    return { created: 1 };
  }

  @Post('preset')
  @RequirePermission('academics.manage')
  async preset(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = presetSubjectsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'SUBJECT_PRESET_INVALID',
        issues: parsed.error.issues,
      });
    }
    const presets = SUBJECT_PRESETS[parsed.data.educationLevel];
    const { data: existing } = await this.supabase.admin
      .from('subjects')
      .select('code')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('education_level', parsed.data.educationLevel);
    const have = new Set((existing ?? []).map((s) => s.code as string));
    const missing = presets.filter((p) => !have.has(p.code));
    if (missing.length > 0) {
      const { error } = await this.supabase.admin.from('subjects').insert(
        missing.map((p) => ({
          tenant_id: req.tenant.tenantId,
          code: p.code,
          name: p.name,
          name_sw: p.nameSw,
          education_level: parsed.data.educationLevel,
        })),
      );
      if (error) {
        throw new InternalServerErrorException({
          code: 'SUBJECT_PRESET_FAILED',
          message: error.message,
        });
      }
    }
    return { created: missing.length, skipped: presets.length - missing.length };
  }
}

@Controller('assessments')
@UseGuards(AuthGuard, TenantGuard)
export class AssessmentsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Post()
  @RequirePermission('exams.create')
  async create(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createAssessmentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'ASSESSMENT_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { data: section } = await this.supabase.admin
      .from('class_sections')
      .select('id')
      .eq('id', parsed.data.classSectionId)
      .eq('tenant_id', req.tenant.tenantId)
      .maybeSingle();
    const { data: term } = await this.supabase.admin
      .from('academic_terms')
      .select('id')
      .eq('id', parsed.data.academicTermId)
      .eq('tenant_id', req.tenant.tenantId)
      .maybeSingle();
    if (!section || !term) {
      throw new BadRequestException({ code: 'ASSESSMENT_BAD_SECTION_OR_TERM' });
    }

    const { data, error } = await this.supabase.admin
      .from('assessments')
      .insert({
        tenant_id: req.tenant.tenantId,
        class_section_id: parsed.data.classSectionId,
        academic_term_id: parsed.data.academicTermId,
        name: parsed.data.name,
        type: parsed.data.type,
        weight: parsed.data.weight,
        created_by: req.user.id,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException({ code: 'ASSESSMENT_DUPLICATE_NAME' });
      }
      throw new InternalServerErrorException({
        code: 'ASSESSMENT_CREATE_FAILED',
        message: error.message,
      });
    }
    return { assessmentId: data.id as string };
  }

  @Post(':id/scores')
  @RequirePermission('marks.enter')
  async scores(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = recordScoresSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'SCORES_INVALID',
        issues: parsed.error.issues,
      });
    }
    const seen = new Set<string>();
    for (const row of parsed.data.rows) {
      if (seen.has(row.studentId)) {
        throw new BadRequestException({ code: 'SCORES_DUPLICATE_STUDENT' });
      }
      seen.add(row.studentId);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('record_scores', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_assessment_id: id,
      p_subject_id: parsed.data.subjectId,
      p_rows: parsed.data.rows,
    });
    if (error) {
      rpcError(error, [
        'SCORES_ASSESSMENT_NOT_FOUND',
        'SCORES_ASSESSMENT_PUBLISHED',
        'SCORES_SUBJECT_NOT_FOUND',
        'SCORES_SUBJECT_LEVEL_MISMATCH',
        'SCORES_STUDENT_NOT_ENROLLED',
      ]);
    }
    return data as { saved: number };
  }

  @Post(':id/publish')
  @RequirePermission('results.publish')
  async publish(@Req() req: TenantRequest, @Param('id') id: string) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('publish_results', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_assessment_id: id,
    });
    if (error) {
      rpcError(error, [
        'RESULTS_ASSESSMENT_NOT_FOUND',
        'RESULTS_ALREADY_PUBLISHED',
      ]);
    }
    return data as { assessmentId: string; status: string };
  }

  @Get('report-card')
  @RequirePermission('students.view')
  async reportCard(@Req() req: TenantRequest, @Query() query: unknown) {
    const parsed = reportCardQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'REPORT_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('report_card', {
      p_tenant_id: req.tenant.tenantId,
      p_student_id: parsed.data.studentId,
      p_term_id: parsed.data.termId,
    });
    if (error) {
      rpcError(error, [
        'REPORT_STUDENT_NOT_FOUND',
        'REPORT_TERM_NOT_FOUND',
        'REPORT_STUDENT_NOT_ENROLLED',
      ]);
    }
    return data as Record<string, unknown>;
  }
}
