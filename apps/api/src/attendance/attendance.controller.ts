import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  InternalServerErrorException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { markAttendanceSchema } from './attendance.schema';

interface MarkResult {
  sessionId: string;
  revision: number;
  counts: Record<string, number>;
  alertsQueued: number;
}

@Controller('attendance')
@UseGuards(AuthGuard, TenantGuard)
export class AttendanceController {
  constructor(private readonly supabase: SupabaseService) {}

  @Post()
  @RequirePermission('attendance.mark')
  async mark(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = markAttendanceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'ATTENDANCE_INVALID',
        issues: parsed.error.issues,
      });
    }

    const seen = new Set<string>();
    for (const record of parsed.data.records) {
      if (seen.has(record.studentId)) {
        throw new BadRequestException({
          code: 'ATTENDANCE_DUPLICATE_STUDENT',
          message: `Student ${record.studentId} appears more than once`,
        });
      }
      seen.add(record.studentId);
    }

    // Re-submitting an existing register is a correction: separate permission.
    // Scoped by tenant, and fails CLOSED — a DB error must not let a plain
    // marker slip a correction through (AUD-004).
    const { data: existing, error: existingError } = await this.supabase.admin
      .from('attendance_sessions')
      .select('id')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('class_section_id', parsed.data.classSectionId)
      .eq('session_date', parsed.data.date)
      .maybeSingle();
    if (existingError) {
      throw new InternalServerErrorException({
        code: 'ATTENDANCE_LOOKUP_FAILED',
        message: existingError.message,
      });
    }
    if (
      existing &&
      !req.tenant.isOwner &&
      !req.tenant.permissions.has('attendance.correct')
    ) {
      throw new ForbiddenException('Missing permission: attendance.correct');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('mark_attendance', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_class_section_id: parsed.data.classSectionId,
      p_date: parsed.data.date,
      p_records: parsed.data.records,
    });
    if (error) {
      if (error.message.includes('ATTENDANCE_STUDENT_NOT_ENROLLED')) {
        throw new BadRequestException({
          code: 'ATTENDANCE_STUDENT_NOT_ENROLLED',
          message: error.message,
        });
      }
      if (error.message.includes('ATTENDANCE_SECTION_NOT_FOUND')) {
        throw new BadRequestException({ code: 'ATTENDANCE_SECTION_NOT_FOUND' });
      }
      throw new InternalServerErrorException({
        code: 'ATTENDANCE_MARK_FAILED',
        message: error.message,
      });
    }
    return data as MarkResult;
  }
}
