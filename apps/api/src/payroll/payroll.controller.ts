import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import {
  createRunSchema,
  setSalarySchema,
  updateSettingsSchema,
} from './payroll.schema';

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'PAYROLL_RPC_FAILED',
    message: error.message,
  });
}

interface SalaryRow {
  id: string;
  user_id: string;
  basic_salary: number;
  allowances: number;
  has_heslb: boolean;
  created_at: string;
  profiles: { full_name: string } | null;
}

interface RunListRow {
  id: string;
  period: string;
  status: string;
  posted_at: string | null;
  created_at: string;
  payroll_items: Array<{ gross: number; net: number }>;
}

interface ItemRow {
  id: string;
  user_id: string;
  basic: number;
  allowances: number;
  gross: number;
  paye: number;
  nssf_employee: number;
  heslb: number;
  other_deductions: number;
  net: number;
  employer: { nssf?: number; wcf?: number; sdl?: number } | null;
  profiles: { full_name: string } | null;
}

@Controller('payroll')
@UseGuards(AuthGuard, TenantGuard)
export class PayrollController {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Active staff for the set-salary picker. Like GET /timetable/teachers,
   * this module owns its manage-gated list because /api/v1/staff needs
   * members.manage (which a bursar does not have) and returns membership
   * ids, while the salary RPC needs USER ids.
   */
  @Get('staff')
  @RequirePermission('payroll.manage')
  async staff(@Req() req: TenantRequest) {
    const { data, error } = await this.supabase.admin
      .from('tenant_memberships')
      .select('user_id, profiles(full_name)')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('status', 'active')
      .limit(1000);
    if (error) {
      throw new InternalServerErrorException({
        code: 'PAYROLL_STAFF_FAILED',
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

  /** Active salaries with staff names (salary data is API-only — no RLS reads). */
  @Get('salaries')
  @RequirePermission('payroll.view')
  async salaries(@Req() req: TenantRequest) {
    const { data, error } = await this.supabase.admin
      .from('staff_salaries')
      .select(
        'id, user_id, basic_salary, allowances, has_heslb, created_at, profiles(full_name)',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .eq('active', true)
      .order('created_at')
      .limit(1000);
    if (error) {
      throw new InternalServerErrorException({
        code: 'PAYROLL_SALARIES_FAILED',
        message: error.message,
      });
    }
    const rows: SalaryRow[] = (data ?? []) as unknown as SalaryRow[];
    return {
      data: rows
        .map((s) => ({
          id: s.id,
          userId: s.user_id,
          fullName: s.profiles?.full_name ?? '',
          basic: Number(s.basic_salary),
          allowances: Number(s.allowances),
          hasHeslb: s.has_heslb,
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
  }

  @Post('salaries')
  @RequirePermission('payroll.manage')
  async setSalary(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = setSalarySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'SALARY_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('set_staff_salary', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_user_id: parsed.data.userId,
      p_basic: parsed.data.basic,
      p_allowances: parsed.data.allowances,
      p_has_heslb: parsed.data.hasHeslb,
    });
    if (error) {
      rpcError(error, ['SALARY_BAD_AMOUNT', 'SALARY_MEMBER_NOT_FOUND']);
    }
    return data as { salaryId: string };
  }

  /** Runs (newest period first) with gross/net totals per run. */
  @Get('runs')
  @RequirePermission('payroll.view')
  async runs(@Req() req: TenantRequest) {
    const { data, error } = await this.supabase.admin
      .from('payroll_runs')
      .select(
        'id, period, status, posted_at, created_at, payroll_items(gross, net)',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .order('period', { ascending: false })
      .limit(200);
    if (error) {
      throw new InternalServerErrorException({
        code: 'PAYROLL_RUNS_FAILED',
        message: error.message,
      });
    }
    const rows: RunListRow[] = data ?? [];
    return {
      data: rows.map((r) => ({
        id: r.id,
        period: r.period,
        status: r.status,
        postedAt: r.posted_at,
        employees: r.payroll_items.length,
        totalGross: r.payroll_items.reduce((s, i) => s + Number(i.gross), 0),
        totalNet: r.payroll_items.reduce((s, i) => s + Number(i.net), 0),
      })),
    };
  }

  @Post('runs')
  @RequirePermission('payroll.manage')
  async createRun(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createRunSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'PAYROLL_RUN_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('run_payroll', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_period: parsed.data.period,
    });
    if (error) {
      rpcError(error, [
        'PAYROLL_PERIOD_EXISTS',
        'PAYROLL_NO_SALARIES',
        'PAYROLL_BAD_PERIOD',
      ]);
    }
    return data as {
      runId: string;
      period: string;
      employees: number;
      totalGross: number;
      totalNet: number;
    };
  }

  /** One run with its items (names resolved) and totals, incl. informational employer contributions. */
  @Get('runs/:id')
  @RequirePermission('payroll.view')
  async run(@Req() req: TenantRequest, @Param('id') id: string) {
    const { data: run, error: runError } = await this.supabase.admin
      .from('payroll_runs')
      .select('id, period, status, posted_at, journal_entry_id')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('id', id)
      .maybeSingle();
    if (runError) {
      if (runError.code === '22P02') {
        throw new NotFoundException({ code: 'PAYROLL_RUN_NOT_FOUND' });
      }
      throw new InternalServerErrorException({
        code: 'PAYROLL_RUN_LOOKUP_FAILED',
        message: runError.message,
      });
    }
    if (!run) {
      throw new NotFoundException({ code: 'PAYROLL_RUN_NOT_FOUND' });
    }
    const { data, error } = await this.supabase.admin
      .from('payroll_items')
      .select(
        `id, user_id, basic, allowances, gross, paye, nssf_employee, heslb,
         other_deductions, net, employer, profiles(full_name)`,
      )
      .eq('tenant_id', req.tenant.tenantId)
      .eq('run_id', id)
      .limit(1000);
    if (error) {
      throw new InternalServerErrorException({
        code: 'PAYROLL_ITEMS_FAILED',
        message: error.message,
      });
    }
    const rows: ItemRow[] = (data ?? []) as unknown as ItemRow[];
    const items = rows
      .map((i) => ({
        id: i.id,
        userId: i.user_id,
        fullName: i.profiles?.full_name ?? '',
        basic: Number(i.basic),
        allowances: Number(i.allowances),
        gross: Number(i.gross),
        paye: Number(i.paye),
        nssf: Number(i.nssf_employee),
        heslb: Number(i.heslb),
        otherDeductions: Number(i.other_deductions),
        net: Number(i.net),
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
    const sum = (pick: (i: (typeof items)[number]) => number) =>
      items.reduce((s, i) => s + pick(i), 0);
    return {
      id: run.id as string,
      period: run.period as string,
      status: run.status as string,
      postedAt: run.posted_at as string | null,
      journalEntryId: run.journal_entry_id as string | null,
      items,
      totals: {
        basic: sum((i) => i.basic),
        allowances: sum((i) => i.allowances),
        gross: sum((i) => i.gross),
        paye: sum((i) => i.paye),
        nssf: sum((i) => i.nssf),
        heslb: sum((i) => i.heslb),
        net: sum((i) => i.net),
      },
      // Informational only in v1 — never posted to the ledger.
      employer: {
        nssf: rows.reduce((s, i) => s + Number(i.employer?.nssf ?? 0), 0),
        wcf: rows.reduce((s, i) => s + Number(i.employer?.wcf ?? 0), 0),
        sdl: rows.reduce((s, i) => s + Number(i.employer?.sdl ?? 0), 0),
      },
    };
  }

  @Post('runs/:id/post')
  @RequirePermission('payroll.manage')
  async postRun(@Req() req: TenantRequest, @Param('id') id: string) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('post_payroll', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_run_id: id,
    });
    if (error) {
      rpcError(error, [
        'PAYROLL_RUN_NOT_FOUND',
        'PAYROLL_ALREADY_POSTED',
        'PAYROLL_RUN_EMPTY',
        'PAYROLL_RUN_STALE',
      ]);
    }
    return data as {
      runId: string;
      journalEntryId: string;
      totalGross: number;
      totalDeductions: number;
      totalNet: number;
    };
  }

  /** Offboarding: remove a staff member's active salary (soft — sets active=false). */
  @Post('salaries/:userId/deactivate')
  @RequirePermission('payroll.manage')
  async deactivateSalary(
    @Req() req: TenantRequest,
    @Param('userId') userId: string,
  ) {
    const parsed = z.string().uuid().safeParse(userId);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'SALARY_USER_INVALID' });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'deactivate_staff_salary',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_user_id: parsed.data,
      },
    );
    if (error) {
      rpcError(error, ['SALARY_NOT_FOUND']);
    }
    return data as { salaryId: string; removed: boolean };
  }

  /** Discard a draft run (not yet posted). Posted runs are immutable. */
  @Post('runs/:id/discard')
  @RequirePermission('payroll.manage')
  async discardRun(@Req() req: TenantRequest, @Param('id') id: string) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'discard_payroll_run',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_run_id: id,
      },
    );
    if (error) {
      rpcError(error, ['PAYROLL_RUN_NOT_FOUND', 'PAYROLL_RUN_POSTED']);
    }
    return data as { runId: string; discarded: boolean };
  }

  /** Statutory rates + verification status. Returns nulls when unset (UI shows defaults). */
  @Get('settings')
  @RequirePermission('payroll.view')
  async getSettings(@Req() req: TenantRequest) {
    const { data, error } = await this.supabase.admin
      .from('payroll_settings')
      .select('rates, verified_at, verified_by')
      .eq('tenant_id', req.tenant.tenantId)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException({
        code: 'PAYROLL_SETTINGS_FAILED',
        message: error.message,
      });
    }

    const row: {
      rates: Record<string, unknown> | null;
      verified_at: string | null;
      verified_by: string | null;
    } | null = data;
    return {
      rates: row?.rates ?? null,
      verifiedAt: row?.verified_at ?? null,
      verifiedBy: row?.verified_by ?? null,
    };
  }

  @Put('settings')
  @RequirePermission('payroll.manage')
  async updateSettings(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = updateSettingsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'PAYROLL_SETTINGS_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'update_payroll_settings',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_rates: parsed.data.rates,
        p_verified: parsed.data.verified,
      },
    );
    if (error) {
      rpcError(error, ['PAYROLL_SETTINGS_INVALID']);
    }
    return data as { tenantId: string; verified: boolean };
  }
}
