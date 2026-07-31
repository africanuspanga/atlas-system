import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import {
  importRequestSchema,
  setEnrolmentSchema,
  setStatusSchema,
  studentRowSchema,
  type StudentRow,
} from './students.schema';

interface SectionRef {
  id: string;
  name: string;
  grade: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Business errors raised by the 0030 lifecycle RPCs, mapped to stable codes.
 * Anything unrecognised becomes a 500 rather than leaking raw Postgres text.
 */
const RPC_BUSINESS_ERRORS = new Set([
  'STUDENT_NOT_FOUND',
  'STUDENT_STATUS_INVALID',
  'ENROLMENT_STUDENT_NOT_FOUND',
  'ENROLMENT_SECTION_NOT_FOUND',
  'ENROLMENT_YEAR_MISMATCH',
]);

@Controller('students')
@UseGuards(AuthGuard, TenantGuard)
export class StudentsController {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Turns a plpgsql `raise exception 'CODE'` into a stable business 400 (or a
   * 404 where that is the honest answer), and anything else into a 500 with no
   * database text attached — a raw PostgrestError message would leak table and
   * column names to the client, and the 500-scrub filter only covers >= 500.
   */
  private rpcError(message: string, fallback: string) {
    const code = RPC_BUSINESS_ERRORS.has(message) ? message : null;
    if (!code) {
      return new InternalServerErrorException({ code: fallback });
    }
    if (
      code === 'STUDENT_NOT_FOUND' ||
      code === 'ENROLMENT_STUDENT_NOT_FOUND'
    ) {
      return new NotFoundException({ code });
    }
    return new BadRequestException({ code });
  }

  private async loadContext(tenantId: string) {
    const [{ data: campus }, { data: year }, { data: sections }] =
      await Promise.all([
        this.supabase.admin
          .from('campuses')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('is_main', true)
          .maybeSingle(),
        this.supabase.admin
          .from('academic_years')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('status', 'active')
          .order('starts_on', { ascending: false })
          .limit(1)
          .maybeSingle(),
        this.supabase.admin
          .from('class_sections')
          .select('id, name, grade_levels(name)')
          .eq('tenant_id', tenantId),
      ]);
    const sectionRefs: SectionRef[] = (sections ?? []).map((s) => ({
      id: s.id as string,
      name: (s.name as string).trim().toLowerCase(),
      grade: (
        (s.grade_levels as unknown as { name: string } | null)?.name ?? ''
      )
        .trim()
        .toLowerCase(),
    }));
    return {
      campusId: campus?.id as string,
      yearId: year?.id as string,
      sectionRefs,
    };
  }

  /** Plan cap (mig 0013): active students + incoming rows must fit the plan. */
  private assertStudentCapacity(req: TenantRequest, adding: number) {
    const { limits, usage, planKey } = req.tenant.entitlements;
    if (limits.students !== null && usage.students + adding > limits.students) {
      throw new ForbiddenException({
        code: 'PLAN_LIMIT_STUDENTS',
        limit: limits.students,
        current: usage.students,
        planKey,
      });
    }
  }

  private async runImport(
    req: TenantRequest,
    rows: StudentRow[],
  ): Promise<{ imported: number }> {
    this.assertStudentCapacity(req, rows.length);
    const { campusId, yearId } = await this.loadContext(req.tenant.tenantId);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('import_students', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_campus_id: campusId ?? null,
      p_year_id: yearId ?? null,
      p_rows: rows,
    });
    if (error) {
      if (error.message.includes('IMPORT_SECTION_NOT_FOUND')) {
        throw new BadRequestException({ code: 'IMPORT_SECTION_NOT_FOUND' });
      }
      throw new InternalServerErrorException({
        code: 'STUDENT_IMPORT_FAILED',
        message: error.message,
      });
    }
    return data as { imported: number };
  }

  @Post()
  @RequirePermission('students.create')
  async create(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = studentRowSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'STUDENT_INVALID',
        issues: parsed.error.issues,
      });
    }
    return this.runImport(req, [parsed.data]);
  }

  /**
   * Student lifecycle — LIFE-030-A. Marks a pupil transferred / withdrawn /
   * graduated / archived and closes their open class enrolment, which frees
   * the plan seat, stops invoicing and stops absence SMS. `students.archive`
   * for terminal states, `students.update` for a plain correction; both keys
   * were already seeded and granted, they simply had no endpoint behind them.
   */
  @Patch(':id/status')
  @RequirePermission('students.update')
  async setStatus(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({ code: 'STUDENT_NOT_FOUND' });
    }
    const parsed = setStatusSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'STUDENT_STATUS_INVALID',
        issues: parsed.error.issues,
      });
    }
    // Retiring a pupil is a heavier act than editing their name: require the
    // archive right for the terminal states, mirroring the seeded roles.
    if (parsed.data.status !== 'active') {
      if (
        !req.tenant.isOwner &&
        !req.tenant.permissions.has('students.archive')
      ) {
        // Stable code, not a bare string: every other business error in this
        // controller is `{ code: 'STABLE_CODE' }`, and the web/mobile error
        // maps key off `code`. A message-only 403 renders as raw English.
        throw new ForbiddenException({ code: 'STUDENTS_ARCHIVE_REQUIRED' });
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'set_student_status',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_student_id: id,
        p_status: parsed.data.status,
        p_reason: parsed.data.reason ?? null,
      },
    );
    if (error) {
      throw this.rpcError(error.message, 'STUDENT_STATUS_FAILED');
    }
    return data as Record<string, unknown>;
  }

  /**
   * Class placement — LIFE-030-B / LIFE-030-C. Assigns a class to a student
   * who has none, or corrects a wrong one. `class_enrolments` was previously
   * insert-only and `unique (student_id, academic_year_id)` blocked a second
   * row, so a mistyped stream was permanent for the whole academic year and
   * the pupil never appeared on their real register.
   */
  @Patch(':id/enrolment')
  @RequirePermission('students.update')
  async setEnrolment(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({ code: 'ENROLMENT_STUDENT_NOT_FOUND' });
    }
    const parsed = setEnrolmentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'ENROLMENT_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'set_class_enrolment',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_student_id: id,
        p_section_id: parsed.data.classSectionId,
        p_year_id: parsed.data.academicYearId ?? null,
      },
    );
    if (error) {
      throw this.rpcError(error.message, 'ENROLMENT_FAILED');
    }
    return data as Record<string, unknown>;
  }

  @Post('import')
  @RequirePermission('students.create')
  async import(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = importRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'IMPORT_INVALID',
        issues: parsed.error.issues,
      });
    }

    const { sectionRefs } = await this.loadContext(req.tenant.tenantId);
    const errors: Array<{ row: number; message: string }> = [];
    const resolved: StudentRow[] = [];

    parsed.data.rows.forEach((row, index) => {
      let classSectionId: string | undefined;
      if (row.className) {
        const grade = row.className.trim().toLowerCase();
        const stream = (row.stream ?? 'A').trim().toLowerCase();
        const match = sectionRefs.find(
          (s) => s.grade === grade && s.name === stream,
        );
        if (!match) {
          errors.push({
            row: index + 1,
            message: `Unknown class "${row.className}" stream "${row.stream ?? 'A'}"`,
          });
          return;
        }
        classSectionId = match.id;
      }
      resolved.push({
        firstName: row.firstName,
        middleName: row.middleName,
        lastName: row.lastName,
        gender: row.gender,
        dateOfBirth: row.dateOfBirth,
        boardingStatus: row.boardingStatus,
        guardian: row.guardian,
        classSectionId,
      });
    });

    if (parsed.data.dryRun || errors.length > 0) {
      return {
        dryRun: true,
        valid: resolved.length,
        invalid: errors.length,
        errors,
      };
    }

    // Never partially import: only proceeds when every row resolved.
    const result = await this.runImport(req, resolved);
    return { ...result, errors: [] };
  }
}
