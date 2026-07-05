import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { resolveWebOrigin } from '../config';

@Controller('guardians')
export class GuardiansController {
  constructor(private readonly supabase: SupabaseService) {}

  /** Parent invite: links a guardian to an auth account on acceptance. */
  @Post(':id/invite')
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.invite')
  async invite(@Req() req: TenantRequest, @Param('id') id: string) {
    const { data: guardian } = await this.supabase.admin
      .from('guardians')
      .select('id, email, full_name, user_id')
      .eq('id', id)
      .eq('tenant_id', req.tenant.tenantId)
      .maybeSingle();
    if (!guardian) {
      throw new NotFoundException({ code: 'GUARDIAN_NOT_FOUND' });
    }
    if (!guardian.email) {
      throw new BadRequestException({ code: 'GUARDIAN_NO_EMAIL' });
    }
    if (guardian.user_id) {
      throw new BadRequestException({ code: 'GUARDIAN_ALREADY_LINKED' });
    }

    const token = randomBytes(24).toString('hex');
    const { error } = await this.supabase.admin.from('invitations').insert({
      tenant_id: req.tenant.tenantId,
      email: guardian.email,
      role_keys: ['parent'],
      guardian_id: guardian.id,
      token_hash: createHash('sha256').update(token).digest('hex'),
      invited_by: req.user.id,
      expires_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    });
    if (error) {
      throw new InternalServerErrorException({
        code: 'GUARDIAN_INVITE_FAILED',
        message: error.message,
      });
    }
    return {
      inviteUrl: `${resolveWebOrigin()}/invite/${token}`,
      email: guardian.email as string,
    };
  }
}

interface LinkedStudent {
  studentId: string;
  tenantId: string;
}

@Controller('portal')
@UseGuards(AuthGuard)
export class PortalController {
  constructor(private readonly supabase: SupabaseService) {}

  /** Students reachable from the caller's linked guardian records. */
  private async linkedStudents(userId: string): Promise<LinkedStudent[]> {
    const { data: guardians } = await this.supabase.admin
      .from('guardians')
      .select('id, tenant_id, student_guardians(student_id)')
      .eq('user_id', userId);
    if (!guardians || guardians.length === 0) {
      throw new ForbiddenException({ code: 'PORTAL_NOT_LINKED' });
    }
    return guardians.flatMap((guardian) =>
      ((guardian.student_guardians ?? []) as Array<{ student_id: string }>).map(
        (link) => ({
          studentId: link.student_id,
          tenantId: guardian.tenant_id as string,
        }),
      ),
    );
  }

  @Get('children')
  async children(@Req() req: AuthenticatedRequest) {
    const links = await this.linkedStudents(req.user.id);
    const children: Array<Record<string, unknown>> = [];

    for (const link of links) {
      const [{ data: student }, { data: tenant }, { data: terms }] =
        await Promise.all([
          this.supabase.admin
            .from('students')
            .select(
              `id, first_name, middle_name, last_name, student_number, status,
               class_enrolments(status, class_sections(name, grade_levels(name)))`,
            )
            .eq('id', link.studentId)
            .maybeSingle(),
          this.supabase.admin
            .from('tenants')
            .select('name, status')
            .eq('id', link.tenantId)
            .maybeSingle(),
          this.supabase.admin
            .from('academic_terms')
            .select('id, name, starts_on, ends_on')
            .eq('tenant_id', link.tenantId)
            .order('starts_on'),
        ]);
      if (!student || student.status !== 'active') continue;
      if (!tenant || tenant.status === 'archived') continue;

      const [{ data: invoices }, { data: payments }, { data: attendance }] =
        await Promise.all([
          this.supabase.admin
            .from('invoices')
            .select('total')
            .eq('student_id', link.studentId),
          this.supabase.admin
            .from('payments')
            .select('amount')
            .eq('student_id', link.studentId),
          this.supabase.admin
            .from('attendance_records')
            .select('status')
            .eq('student_id', link.studentId),
        ]);

      const attendanceCounts: Record<string, number> = {};
      for (const record of (attendance ?? []) as Array<{ status: string }>) {
        attendanceCounts[record.status] =
          (attendanceCounts[record.status] ?? 0) + 1;
      }
      const enrolment = (
        (student.class_enrolments ?? []) as unknown as Array<{
          status: string;
          class_sections: {
            name: string;
            grade_levels: { name: string } | null;
          } | null;
        }>
      ).find((e) => e.status === 'active');

      children.push({
        studentId: student.id as string,
        tenantId: link.tenantId,
        school: tenant.name as string,
        name: `${student.first_name} ${student.middle_name ?? ''} ${student.last_name}`
          .replace(/\s+/g, ' ')
          .trim(),
        number: student.student_number as string,
        className: enrolment?.class_sections
          ? `${enrolment.class_sections.grade_levels?.name ?? ''} ${enrolment.class_sections.name}`.trim()
          : null,
        balance:
          ((invoices ?? []) as Array<{ total: number }>).reduce(
            (sum, i) => sum + Number(i.total),
            0,
          ) -
          ((payments ?? []) as Array<{ amount: number }>).reduce(
            (sum, p) => sum + Number(p.amount),
            0,
          ),
        attendance: attendanceCounts,
        terms: ((terms ?? []) as Array<{ id: string; name: string }>).map(
          (t) => ({ id: t.id, name: t.name }),
        ),
      });
    }

    return { children };
  }

  @Get('children/:studentId/report-card')
  async reportCard(
    @Req() req: AuthenticatedRequest,
    @Param('studentId') studentId: string,
    @Query('termId') termId: string,
  ) {
    if (!termId || !/^[0-9a-f-]{36}$/.test(termId)) {
      throw new BadRequestException({ code: 'PORTAL_TERM_INVALID' });
    }
    const links = await this.linkedStudents(req.user.id);
    const link = links.find((l) => l.studentId === studentId);
    if (!link) {
      throw new ForbiddenException({ code: 'PORTAL_NOT_YOUR_CHILD' });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('report_card', {
      p_tenant_id: link.tenantId,
      p_student_id: studentId,
      p_term_id: termId,
    });
    if (error) {
      throw new BadRequestException({
        code: 'PORTAL_REPORT_FAILED',
        message: error.message,
      });
    }
    return data as Record<string, unknown>;
  }
}
