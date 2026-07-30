import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
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
  createPeriodsSchema,
  setSlotSchema,
  timetableQuerySchema,
} from './timetable.schema';

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'TIMETABLE_RPC_FAILED',
    message: error.message,
  });
}

interface SlotRow {
  id: string;
  class_section_id: string;
  day_of_week: number;
  period_id: string;
  subject_id: string;
  teacher_user_id: string;
  subjects: { code: string; name: string; name_sw: string | null } | null;
  profiles: { full_name: string } | null;
  class_sections: {
    name: string;
    grade_levels: { name: string } | null;
  } | null;
}

@Controller('timetable')
@UseGuards(AuthGuard, TenantGuard)
export class TimetableController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get('periods')
  @RequirePermission('timetable.view')
  async periods(@Req() req: TenantRequest) {
    const { data, error } = await this.supabase.admin
      .from('timetable_periods')
      .select('id, label, starts_at, ends_at, is_break, sort_order')
      .eq('tenant_id', req.tenant.tenantId)
      .order('sort_order')
      .order('starts_at');
    if (error) {
      throw new InternalServerErrorException({
        code: 'TIMETABLE_PERIODS_FAILED',
        message: error.message,
      });
    }
    return { data: data ?? [] };
  }

  @Post('periods')
  @RequirePermission('timetable.manage')
  async createPeriods(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createPeriodsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'TIMETABLE_PERIODS_INVALID',
        issues: parsed.error.issues,
      });
    }
    const labels = new Set<string>();
    for (const period of parsed.data.periods) {
      if (period.endsAt <= period.startsAt) {
        throw new BadRequestException({
          code: 'TIMETABLE_PERIOD_BAD_TIMES',
          message: `${period.label}: endsAt must be after startsAt`,
        });
      }
      if (labels.has(period.label)) {
        throw new ConflictException({ code: 'TIMETABLE_PERIOD_DUPLICATE' });
      }
      labels.add(period.label);
    }

    const { error } = await this.supabase.admin
      .from('timetable_periods')
      .insert(
        parsed.data.periods.map((p, index) => ({
          tenant_id: req.tenant.tenantId,
          label: p.label,
          starts_at: p.startsAt,
          ends_at: p.endsAt,
          is_break: p.isBreak,
          sort_order: index,
        })),
      );
    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({ code: 'TIMETABLE_PERIOD_DUPLICATE' });
      }
      throw new InternalServerErrorException({
        code: 'TIMETABLE_PERIODS_CREATE_FAILED',
        message: error.message,
      });
    }
    return { created: parsed.data.periods.length };
  }

  /**
   * Active staff for the teacher picker. /api/v1/staff exposes membership
   * ids only (and needs members.manage); the slot RPC needs USER ids, so the
   * timetable module has its own manage-gated list.
   */
  @Get('teachers')
  @RequirePermission('timetable.manage')
  async teachers(@Req() req: TenantRequest) {
    const { data, error } = await this.supabase.admin
      .from('tenant_memberships')
      .select('user_id, profiles(full_name)')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('status', 'active')
      .limit(1000);
    if (error) {
      throw new InternalServerErrorException({
        code: 'TIMETABLE_TEACHERS_FAILED',
        message: error.message,
      });
    }
    const rows: Array<{
      user_id: string;
      profiles: { full_name: string } | null;
    }> = (data ?? []) as unknown as Array<{
      user_id: string;
      profiles: { full_name: string } | null;
    }>;
    return {
      data: rows
        .map((m) => ({
          userId: m.user_id,
          fullName: m.profiles?.full_name ?? '',
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
  }

  @Get()
  @RequirePermission('timetable.view')
  async slots(@Req() req: TenantRequest, @Query() query: unknown) {
    const parsed = timetableQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'TIMETABLE_QUERY_INVALID',
        issues: parsed.error.issues,
      });
    }
    let builder = this.supabase.admin
      .from('timetable_slots')
      .select(
        'id, class_section_id, day_of_week, period_id, subject_id, teacher_user_id, subjects(code, name, name_sw), profiles(full_name), class_sections(name, grade_levels(name))',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .limit(1000);
    builder = parsed.data.sectionId
      ? builder.eq('class_section_id', parsed.data.sectionId)
      : builder.eq('teacher_user_id', req.user.id);
    const { data, error } = await builder;
    if (error) {
      throw new InternalServerErrorException({
        code: 'TIMETABLE_FETCH_FAILED',
        message: error.message,
      });
    }
    const rows: SlotRow[] = (data ?? []) as unknown as SlotRow[];
    return {
      data: rows.map((s) => ({
        id: s.id,
        sectionId: s.class_section_id,
        sectionLabel:
          `${s.class_sections?.grade_levels?.name ?? ''} ${s.class_sections?.name ?? ''}`.trim(),
        day: s.day_of_week,
        periodId: s.period_id,
        subjectId: s.subject_id,
        subjectCode: s.subjects?.code ?? '',
        subjectName: s.subjects?.name ?? '',
        subjectNameSw: s.subjects?.name_sw ?? null,
        teacherUserId: s.teacher_user_id,
        teacherName: s.profiles?.full_name ?? '',
      })),
    };
  }

  @Post('slots')
  @RequirePermission('timetable.manage')
  async setSlot(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = setSlotSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'TIMETABLE_SLOT_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'set_timetable_slot',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_section_id: parsed.data.sectionId,
        p_day: parsed.data.day,
        p_period_id: parsed.data.periodId,
        p_subject_id: parsed.data.subjectId,
        p_teacher_user_id: parsed.data.teacherUserId,
      },
    );
    if (error) {
      rpcError(error, [
        'TIMETABLE_TEACHER_CLASH',
        'TIMETABLE_SECTION_NOT_FOUND',
        'TIMETABLE_PERIOD_NOT_FOUND',
        'TIMETABLE_PERIOD_IS_BREAK',
        'TIMETABLE_SUBJECT_NOT_FOUND',
        'TIMETABLE_SUBJECT_LEVEL_MISMATCH',
        'TIMETABLE_TEACHER_NOT_FOUND',
        'TIMETABLE_BAD_DAY',
      ]);
    }
    return data as { slotId: string };
  }

  @Delete('slots/:id')
  @RequirePermission('timetable.manage')
  async deleteSlot(@Req() req: TenantRequest, @Param('id') id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      throw new BadRequestException({ code: 'TIMETABLE_SLOT_INVALID' });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'delete_timetable_slot',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_slot_id: id,
      },
    );
    if (error) {
      rpcError(error, ['TIMETABLE_SLOT_NOT_FOUND']);
    }
    return data as { deleted: boolean };
  }
}
