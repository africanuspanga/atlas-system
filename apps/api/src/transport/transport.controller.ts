import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  InternalServerErrorException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import {
  assignTransportSchema,
  createRouteSchema,
  createStopSchema,
} from './transport.schema';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'TRANSPORT_RPC_FAILED',
    message: error.message,
  });
}

interface RouteRow {
  id: string;
  name: string;
  fee_amount: number;
  transport_stops: Array<{ id: string; name: string; sort_order: number }>;
}

interface RosterRow {
  id: string;
  stop_id: string | null;
  students: {
    id: string;
    student_number: string;
    first_name: string;
    last_name: string;
  } | null;
  transport_stops: { name: string } | null;
}

@Controller('transport')
@UseGuards(AuthGuard, TenantGuard)
export class TransportController {
  constructor(private readonly supabase: SupabaseService) {}

  /** Routes with ordered stops and active assignment counts. */
  @Get()
  @RequirePermission('transport.view')
  async list(@Req() req: TenantRequest) {
    const [routes, load] = await Promise.all([
      this.supabase.admin
        .from('transport_routes')
        .select('id, name, fee_amount, transport_stops(id, name, sort_order)')
        .eq('tenant_id', req.tenant.tenantId)
        .order('name')
        .limit(200),
      this.supabase.admin.rpc('transport_route_load', {
        p_tenant_id: req.tenant.tenantId,
      }),
    ]);
    const err = routes.error ?? load.error;
    if (err) {
      throw new InternalServerErrorException({
        code: 'TRANSPORT_FETCH_FAILED',
        message: err.message,
      });
    }
    const counts = new Map<string, number>();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const loadRows: Array<{ route_id: string; assigned: number }> =
      load.data ?? [];
    for (const l of loadRows) {
      counts.set(l.route_id, Number(l.assigned));
    }
    const rows: RouteRow[] = routes.data ?? [];
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        feeAmount: Number(r.fee_amount),
        students: counts.get(r.id) ?? 0,
        stops: r.transport_stops
          .sort(
            (a, b) =>
              a.sort_order - b.sort_order || a.name.localeCompare(b.name),
          )
          .map((s) => ({ id: s.id, name: s.name, sortOrder: s.sort_order })),
      })),
    };
  }

  @Post('routes')
  @RequirePermission('transport.manage')
  async createRoute(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createRouteSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'TRANSPORT_ROUTE_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { data, error } = await this.supabase.admin
      .from('transport_routes')
      .insert({
        tenant_id: req.tenant.tenantId,
        name: parsed.data.name,
        fee_amount: parsed.data.feeAmount,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({ code: 'TRANSPORT_ROUTE_DUPLICATE' });
      }
      throw new InternalServerErrorException({
        code: 'TRANSPORT_ROUTE_CREATE_FAILED',
        message: error.message,
      });
    }
    return { routeId: data.id as string };
  }

  @Post('stops')
  @RequirePermission('transport.manage')
  async createStop(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createStopSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'TRANSPORT_STOP_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { data: route } = await this.supabase.admin
      .from('transport_routes')
      .select('id')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('id', parsed.data.routeId)
      .maybeSingle();
    if (!route) {
      throw new BadRequestException({ code: 'TRANSPORT_ROUTE_NOT_FOUND' });
    }
    const { data, error } = await this.supabase.admin
      .from('transport_stops')
      .insert({
        tenant_id: req.tenant.tenantId,
        route_id: parsed.data.routeId,
        name: parsed.data.name,
        sort_order: parsed.data.sortOrder,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({ code: 'TRANSPORT_STOP_DUPLICATE' });
      }
      throw new InternalServerErrorException({
        code: 'TRANSPORT_STOP_CREATE_FAILED',
        message: error.message,
      });
    }
    return { stopId: data.id as string };
  }

  @Post('assignments')
  @RequirePermission('transport.manage')
  async assign(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = assignTransportSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'TRANSPORT_ASSIGNMENT_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('assign_transport', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_student_id: parsed.data.studentId,
      p_route_id: parsed.data.routeId,
      p_stop_id: parsed.data.stopId ?? null,
      p_year_id: parsed.data.academicYearId,
    });
    if (error) {
      rpcError(error, [
        'TRANSPORT_STUDENT_NOT_FOUND',
        'TRANSPORT_ROUTE_NOT_FOUND',
        'TRANSPORT_STOP_MISMATCH',
        'TRANSPORT_YEAR_NOT_FOUND',
      ]);
    }
    return data as {
      assignmentId: string;
      routeId: string;
      stopId: string | null;
      previousRouteId: string | null;
    };
  }

  /** Active student roster for one route. */
  @Get('routes/:id/students')
  @RequirePermission('transport.view')
  async roster(@Req() req: TenantRequest, @Param('id') id: string) {
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({ code: 'TRANSPORT_ROUTE_INVALID' });
    }
    const { data, error } = await this.supabase.admin
      .from('transport_assignments')
      .select(
        'id, stop_id, students(id, student_number, first_name, last_name), transport_stops(name)',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .eq('route_id', id)
      .eq('active', true)
      .limit(1000);
    if (error) {
      throw new InternalServerErrorException({
        code: 'TRANSPORT_ROSTER_FAILED',
        message: error.message,
      });
    }
    const rows: RosterRow[] = (data ?? []) as unknown as RosterRow[];
    return {
      data: rows
        .map((a) => ({
          assignmentId: a.id,
          studentId: a.students?.id ?? null,
          studentNumber: a.students?.student_number ?? '',
          name: `${a.students?.first_name ?? ''} ${a.students?.last_name ?? ''}`.trim(),
          stop: a.transport_stops?.name ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}
