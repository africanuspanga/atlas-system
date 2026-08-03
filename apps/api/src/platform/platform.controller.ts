import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { SupabaseService } from '../supabase/supabase.service';
import {
  addUtcCalendarMonthsClamped,
  todayInTanzania,
} from '../common/tanzania-date';
import { PlatformGuard, PlatformWrite } from './platform.guard';
import type { PlatformRequest } from './platform.guard';

const suspendSchema = z.object({ reason: z.string().min(5).max(500) });
const archiveSchema = z.object({
  reason: z.string().min(5).max(500),
  force: z.boolean().optional(),
});
/** Non-suspended tenant lifecycle statuses (mig 0001 check constraint). */
const REACTIVATE_STATUSES = [
  'draft',
  'configuration',
  'data_review',
  'training',
  'live',
] as const;
const reactivateSchema = z.object({
  targetStatus: z.enum(REACTIVATE_STATUSES).optional(),
});
const planSchema = z.object({
  planKey: z.string().min(2).max(40),
  cycle: z.enum(['monthly', 'annual']),
});
const trialSchema = z.object({ days: z.number().int().min(1).max(180) });
const recordPaymentSchema = z.object({
  months: z.number().int().min(1).max(24),
  reference: z.string().min(3).max(120),
  reason: z.string().min(5).max(500),
});
const auditQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  action: z
    .string()
    .regex(/^[a-z0-9_.]+$/i)
    .max(100)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const unitCostsSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

/**
 * ATLAS control centre API (CTO §7). Every mutation writes BOTH
 * platform_audit_logs (who did what, platform-wide) and the target tenant's
 * audit_logs (so the school sees what was done to it).
 */
@Controller('platform')
@UseGuards(AuthGuard, PlatformGuard)
export class PlatformController {
  constructor(private readonly supabase: SupabaseService) {}

  private async audit(
    req: PlatformRequest,
    action: string,
    tenantId: string | null,
    details: Record<string, unknown> = {},
  ) {
    // A mutation must never succeed without its audit trail — a silent audit
    // failure would leave a change no one can trace (CTO §7).
    const { error: platformErr } = await this.supabase.admin
      .from('platform_audit_logs')
      .insert({
        actor_user_id: req.user.id,
        action,
        tenant_id: tenantId,
        details,
      });
    if (platformErr) {
      throw new InternalServerErrorException({ code: 'PLATFORM_AUDIT_FAILED' });
    }
    if (tenantId) {
      const { error: tenantErr } = await this.supabase.admin
        .from('audit_logs')
        .insert({
          tenant_id: tenantId,
          actor_user_id: req.user.id,
          action,
          entity_type: 'tenant',
          entity_id: tenantId,
          after: details,
        });
      if (tenantErr) {
        throw new InternalServerErrorException({
          code: 'PLATFORM_AUDIT_FAILED',
        });
      }
    }
  }

  private async loadTenant(id: string) {
    const { data: tenant, error } = await this.supabase.admin
      .from('tenants')
      .select('id, name, slug, status, region, created_at')
      .eq('id', id)
      .maybeSingle();
    // Distinguish a genuine miss (404) from a transient DB error (500) so a
    // flaky read never masquerades as "tenant not found".
    if (error) {
      throw new InternalServerErrorException({ code: 'TENANT_LOOKUP_FAILED' });
    }
    if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND' });
    return tenant;
  }

  @Get('overview')
  async overview() {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('platform_overview');
    if (error) {
      throw new InternalServerErrorException({
        code: 'PLATFORM_OVERVIEW_FAILED',
      });
    }
    return data as Record<string, unknown>;
  }

  /**
   * Super-dashboard metrics (read-level: any platform role). The RPCs are
   * service-role-only aggregates across ALL tenants (migration 0024) — this
   * guard is the sole authorization in front of them.
   */
  @Get('revenue')
  async revenue() {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('platform_revenue');
    if (error) {
      throw new InternalServerErrorException({
        code: 'PLATFORM_REVENUE_FAILED',
      });
    }
    return data as Record<string, unknown>;
  }

  @Get('health')
  async health() {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('platform_health');
    if (error) {
      throw new InternalServerErrorException({
        code: 'PLATFORM_HEALTH_FAILED',
      });
    }
    return data as Record<string, unknown>;
  }

  @Get('unit-costs')
  async unitCosts(@Query() query: Record<string, unknown>) {
    const parsed = unitCostsSchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'INVALID_DATE_RANGE' });
    }
    // Platform finance follows the Tanzania operating calendar.
    const today = todayInTanzania();
    const from = parsed.data.from ?? `${today.slice(0, 8)}01`;
    const to = parsed.data.to ?? today;
    if (from > to) {
      throw new BadRequestException({ code: 'INVALID_DATE_RANGE' });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'platform_unit_costs',
      { p_from: from, p_to: to },
    );
    if (error) {
      throw new InternalServerErrorException({
        code: 'PLATFORM_UNIT_COSTS_FAILED',
      });
    }
    return data as Record<string, unknown>;
  }

  @Get('plans')
  async plans() {
    const { data } = await this.supabase.admin
      .from('plans')
      .select(
        'key, name, description, monthly_price_tzs, annual_price_tzs, limits, is_active',
      )
      .order('monthly_price_tzs');
    return { plans: data ?? [] };
  }

  @Get('tenants')
  async tenants(@Query('status') status?: string) {
    // A tenant accumulates subscription rows over time (a plan change cancels
    // the old row and inserts a new one) — order the embed newest-first so
    // consumers reading [0] always see the current subscription.
    let query = this.supabase.admin
      .from('tenants')
      .select(
        'id, name, slug, status, region, created_at, subscriptions(status, trial_ends_at, current_period_end, created_at, plans(key, name))',
      )
      .order('created_at', { ascending: false })
      .order('created_at', {
        referencedTable: 'subscriptions',
        ascending: false,
      })
      .limit(200);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException({ code: 'TENANT_LIST_FAILED' });
    }
    return { tenants: data ?? [] };
  }

  /**
   * The platform's own audit trail — readable by ANY platform role (support,
   * finance, auditor…): the owner must be able to see what was done, even if
   * they cannot act. Mutations stay super_admin-only via @PlatformWrite.
   */
  @Get('audit')
  async auditTrail(@Query() query: Record<string, unknown>) {
    const parsed = auditQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'INVALID_AUDIT_QUERY' });
    }
    const { tenantId, action, limit, offset } = parsed.data;
    let q = this.supabase.admin
      .from('platform_audit_logs')
      .select(
        'id, action, tenant_id, entity_type, entity_id, details, created_at, actor:profiles(full_name), tenant:tenants(name, slug)',
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (tenantId) q = q.eq('tenant_id', tenantId);
    if (action) q = q.like('action', `${action}%`);
    const { data, error } = await q;
    if (error) {
      throw new InternalServerErrorException({
        code: 'PLATFORM_AUDIT_LIST_FAILED',
      });
    }
    return { entries: data ?? [], limit, offset };
  }

  @Get('tenants/:id')
  async tenantDetail(@Param('id') id: string) {
    const tenant = await this.loadTenant(id);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: entitlements } = await this.supabase.admin.rpc(
      'tenant_entitlements',
      { p_tenant_id: id },
    );
    const { data: audit } = await this.supabase.admin
      .from('audit_logs')
      .select('action, created_at')
      .eq('tenant_id', id)
      .order('created_at', { ascending: false })
      .limit(20);
    return {
      tenant,
      entitlements: entitlements as Record<string, unknown>,
      recentActivity: audit ?? [],
    };
  }

  @Post('tenants/:id/suspend')
  @PlatformWrite()
  async suspend(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = suspendSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'SUSPEND_REASON_REQUIRED' });
    }
    const tenant = await this.loadTenant(id);
    if (tenant.status === 'archived') {
      throw new BadRequestException({ code: 'TENANT_ARCHIVED' });
    }
    const { error: suspendErr } = await this.supabase.admin
      .from('tenants')
      .update({ status: 'suspended' })
      .eq('id', id);
    if (suspendErr) {
      throw new InternalServerErrorException({
        code: 'TENANT_SUSPEND_FAILED',
      });
    }
    await this.audit(req, 'platform.tenant_suspended', id, {
      reason: parsed.data.reason,
    });
    return { suspended: true };
  }

  /**
   * Tenants are never hard-deleted (audit_logs FK) — archiving is the end of
   * the lifecycle. A 'live' school is a paying customer: archiving it takes
   * an explicit force flag so a typo can't take a school offline.
   */
  @Post('tenants/:id/archive')
  @PlatformWrite()
  async archive(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = archiveSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'ARCHIVE_REASON_REQUIRED' });
    }
    const tenant = await this.loadTenant(id);
    if (tenant.status === 'archived') {
      throw new BadRequestException({ code: 'TENANT_ARCHIVED' });
    }
    if (tenant.status === 'live' && parsed.data.force !== true) {
      throw new BadRequestException({ code: 'TENANT_LIVE_NEEDS_FORCE' });
    }
    const { error: archiveErr } = await this.supabase.admin
      .from('tenants')
      .update({ status: 'archived' })
      .eq('id', id);
    if (archiveErr) {
      throw new InternalServerErrorException({ code: 'TENANT_ARCHIVE_FAILED' });
    }
    await this.audit(req, 'platform.tenant_archived', id, {
      reason: parsed.data.reason,
      previousStatus: tenant.status as string,
      forced: tenant.status === 'live',
    });
    return { archived: true };
  }

  @Post('tenants/:id/reactivate')
  @PlatformWrite()
  async reactivate(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    // Optional body, backward compatible: no body → 'live'. A school
    // suspended mid-onboarding goes back to where it was, not to 'live'.
    const parsed = reactivateSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException({ code: 'INVALID_TARGET_STATUS' });
    }
    const targetStatus = parsed.data.targetStatus ?? 'live';
    const tenant = await this.loadTenant(id);
    if (tenant.status !== 'suspended') {
      throw new BadRequestException({ code: 'TENANT_NOT_SUSPENDED' });
    }
    const { error: reactivateErr } = await this.supabase.admin
      .from('tenants')
      .update({ status: targetStatus })
      .eq('id', id);
    if (reactivateErr) {
      throw new InternalServerErrorException({
        code: 'TENANT_REACTIVATE_FAILED',
      });
    }
    await this.audit(req, 'platform.tenant_reactivated', id, { targetStatus });
    return { reactivated: true, status: targetStatus };
  }

  @Post('tenants/:id/plan')
  @PlatformWrite()
  async changePlan(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = planSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'PLAN_KEY_REQUIRED' });
    }
    await this.loadTenant(id);
    const { data: plan, error: planErr } = await this.supabase.admin
      .from('plans')
      .select('id, key')
      .eq('key', parsed.data.planKey)
      .eq('is_active', true)
      .maybeSingle();
    // A transient read error must not be reported as a missing plan (400).
    if (planErr) {
      throw new InternalServerErrorException({ code: 'PLAN_CHANGE_FAILED' });
    }
    if (!plan) throw new BadRequestException({ code: 'PLAN_NOT_FOUND' });

    const { data: sub, error: subReadErr } = await this.supabase.admin
      .from('subscriptions')
      .select('id')
      .eq('tenant_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (subReadErr) {
      throw new InternalServerErrorException({ code: 'PLAN_CHANGE_FAILED' });
    }
    // A plan change ENDS the current subscription and STARTS a new period —
    // never update-in-place, so billing history survives. The entitlements
    // RPC (mig 0013) resolves the newest row by created_at, so the fresh
    // 'active' row wins over the 'cancelled' one immediately. Cancel-first:
    // if the insert then fails, the tenant is locked (fails closed) rather
    // than left with two live subscriptions.
    const start = new Date();
    const end = addUtcCalendarMonthsClamped(
      start,
      parsed.data.cycle === 'annual' ? 12 : 1,
    );
    if (sub) {
      const { error: cancelErr } = await this.supabase.admin
        .from('subscriptions')
        .update({ status: 'cancelled' })
        .eq('id', sub.id);
      if (cancelErr) {
        throw new InternalServerErrorException({ code: 'PLAN_CHANGE_FAILED' });
      }
    }
    const { error: insertErr } = await this.supabase.admin
      .from('subscriptions')
      .insert({
        tenant_id: id,
        plan_id: plan.id as string,
        status: 'active',
        current_period_start: start.toISOString(),
        current_period_end: end.toISOString(),
      });
    if (insertErr) {
      throw new InternalServerErrorException({ code: 'PLAN_CHANGE_FAILED' });
    }
    // Entitlements are resolved per-request from the DB, so the change takes
    // effect immediately — modules, caps and access included (CTO §7).
    await this.audit(req, 'platform.plan_changed', id, {
      planKey: plan.key as string,
      cycle: parsed.data.cycle,
      currentPeriodStart: start.toISOString(),
      currentPeriodEnd: end.toISOString(),
      previousSubscriptionId: (sub?.id as string | undefined) ?? null,
    });
    return {
      planKey: plan.key as string,
      cycle: parsed.data.cycle,
      currentPeriodEnd: end.toISOString(),
    };
  }

  @Post('tenants/:id/trial-extend')
  @PlatformWrite()
  async extendTrial(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = trialSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'TRIAL_DAYS_REQUIRED' });
    }
    await this.loadTenant(id);
    const { data: sub, error: subReadErr } = await this.supabase.admin
      .from('subscriptions')
      .select('id, trial_ends_at, status')
      .eq('tenant_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    // A transient read error must not be reported as a missing subscription.
    if (subReadErr) {
      throw new InternalServerErrorException({ code: 'TRIAL_EXTEND_FAILED' });
    }
    if (!sub) throw new BadRequestException({ code: 'NO_SUBSCRIPTION' });
    if (sub.status !== 'trialing') {
      throw new BadRequestException({ code: 'TRIAL_EXTENSION_NOT_APPLICABLE' });
    }
    const base = Math.max(
      Date.now(),
      sub.trial_ends_at ? new Date(sub.trial_ends_at as string).getTime() : 0,
    );
    const newEnd = new Date(
      base + parsed.data.days * 24 * 3600 * 1000,
    ).toISOString();
    const { error: updateErr } = await this.supabase.admin
      .from('subscriptions')
      .update({ trial_ends_at: newEnd })
      .eq('id', sub.id);
    if (updateErr) {
      throw new InternalServerErrorException({ code: 'TRIAL_EXTEND_FAILED' });
    }
    await this.audit(req, 'platform.trial_extended', id, {
      days: parsed.data.days,
      trialEndsAt: newEnd,
    });
    return { trialEndsAt: newEnd };
  }

  /**
   * Manual payment reconciliation (bank transfer / M-Pesa — Tanzania
   * reality): extends the paid period by N months from max(now, current
   * period end) and re-activates a past_due/lapsed subscription. The bank
   * reference goes into the audit trail.
   */
  @Post('tenants/:id/record-payment')
  @PlatformWrite()
  async recordPayment(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = recordPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'PAYMENT_DETAILS_REQUIRED' });
    }
    await this.loadTenant(id);
    const { data: sub, error: subReadErr } = await this.supabase.admin
      .from('subscriptions')
      .select('id, status, current_period_start, current_period_end')
      .eq('tenant_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    // A transient read error must not be reported as a missing subscription.
    if (subReadErr) {
      throw new InternalServerErrorException({ code: 'PAYMENT_RECORD_FAILED' });
    }
    if (!sub) throw new BadRequestException({ code: 'SUBSCRIPTION_NOT_FOUND' });
    // Paying early extends from the current period end; paying late from now.
    const base = new Date(
      Math.max(
        Date.now(),
        sub.current_period_end
          ? new Date(sub.current_period_end as string).getTime()
          : 0,
      ),
    );
    const newEnd = addUtcCalendarMonthsClamped(base, parsed.data.months);
    const { error: updateErr } = await this.supabase.admin
      .from('subscriptions')
      .update({
        status: 'active',
        current_period_end: newEnd.toISOString(),
        // Legacy rows may have no period at all — anchor one now.
        ...(sub.current_period_start
          ? {}
          : { current_period_start: new Date().toISOString() }),
      })
      .eq('id', sub.id);
    if (updateErr) {
      throw new InternalServerErrorException({ code: 'PAYMENT_RECORD_FAILED' });
    }
    await this.audit(req, 'platform.payment_recorded', id, {
      months: parsed.data.months,
      reference: parsed.data.reference,
      reason: parsed.data.reason,
      currentPeriodEnd: newEnd.toISOString(),
    });
    return { currentPeriodEnd: newEnd.toISOString() };
  }
}
