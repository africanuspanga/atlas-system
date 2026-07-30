import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { recordVisitSchema, visitsQuerySchema } from './clinic.schema';

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'CLINIC_RPC_FAILED',
    message: error.message,
  });
}

interface VisitRow {
  id: string;
  visited_at: string;
  symptoms: string;
  treatment: string | null;
  notes: string | null;
  notify_guardian: boolean;
  students: {
    id: string;
    student_number: string;
    first_name: string;
    last_name: string;
  } | null;
}

@Controller('clinic')
@UseGuards(AuthGuard, TenantGuard)
export class ClinicController {
  constructor(private readonly supabase: SupabaseService) {}

  /** Visits (newest first), optionally windowed by ?from=&to= (YYYY-MM-DD). */
  @Get('visits')
  @RequirePermission('clinic.view')
  async visits(@Req() req: TenantRequest, @Query() query: unknown) {
    const parsed = visitsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'CLINIC_QUERY_INVALID',
        issues: parsed.error.issues,
      });
    }
    let builder = this.supabase.admin
      .from('clinic_visits')
      .select(
        `id, visited_at, symptoms, treatment, notes, notify_guardian,
         students(id, student_number, first_name, last_name)`,
      )
      .eq('tenant_id', req.tenant.tenantId);
    // Tanzania (Africa/Dar_es_Salaam) is a fixed UTC+3 with no DST; build the
    // day window at +03:00 so ?from=&to= match local calendar days, not UTC.
    if (parsed.data.from) {
      builder = builder.gte(
        'visited_at',
        new Date(`${parsed.data.from}T00:00:00+03:00`).toISOString(),
      );
    }
    if (parsed.data.to) {
      builder = builder.lte(
        'visited_at',
        new Date(`${parsed.data.to}T23:59:59.999+03:00`).toISOString(),
      );
    }
    const { data, error } = await builder
      .order('visited_at', { ascending: false })
      .limit(500);
    if (error) {
      throw new InternalServerErrorException({
        code: 'CLINIC_FETCH_FAILED',
        message: error.message,
      });
    }
    const rows: VisitRow[] = (data ?? []) as unknown as VisitRow[];
    return {
      data: rows.map((v) => ({
        id: v.id,
        visitedAt: v.visited_at,
        studentId: v.students?.id ?? null,
        studentNumber: v.students?.student_number ?? '',
        studentName:
          `${v.students?.first_name ?? ''} ${v.students?.last_name ?? ''}`.trim(),
        symptoms: v.symptoms,
        treatment: v.treatment,
        notes: v.notes,
        notifyGuardian: v.notify_guardian,
      })),
    };
  }

  @Post('visits')
  @RequirePermission('clinic.manage')
  async record(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = recordVisitSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'CLINIC_VISIT_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'record_clinic_visit',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_student_id: parsed.data.studentId,
        p_symptoms: parsed.data.symptoms,
        p_treatment: parsed.data.treatment ?? null,
        p_notes: parsed.data.notes ?? null,
        p_notify: parsed.data.notifyGuardian,
      },
    );
    if (error) {
      rpcError(error, ['CLINIC_STUDENT_NOT_FOUND', 'CLINIC_SYMPTOMS_REQUIRED']);
    }
    return data as { visitId: string; notified: boolean };
  }
}
