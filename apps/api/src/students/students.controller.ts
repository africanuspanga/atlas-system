import {
  BadRequestException,
  Body,
  Controller,
  InternalServerErrorException,
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
  studentRowSchema,
  type StudentRow,
} from './students.schema';

interface SectionRef {
  id: string;
  name: string;
  grade: string;
}

@Controller('students')
@UseGuards(AuthGuard, TenantGuard)
export class StudentsController {
  constructor(private readonly supabase: SupabaseService) {}

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

  private async runImport(
    req: TenantRequest,
    rows: StudentRow[],
  ): Promise<{ imported: number }> {
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
