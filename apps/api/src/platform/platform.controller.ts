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
import { PlatformGuard, PlatformWrite } from './platform.guard';
import type { PlatformRequest } from './platform.guard';

const suspendSchema = z.object({ reason: z.string().min(5).max(500) });
const planSchema = z.object({ planKey: z.string().min(2).max(40) });
const trialSchema = z.object({ days: z.number().int().min(1).max(180) });

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
    await this.supabase.admin.from('platform_audit_logs').insert({
      actor_user_id: req.user.id,
      action,
      tenant_id: tenantId,
      details,
    });
    if (tenantId) {
      await this.supabase.admin.from('audit_logs').insert({
        tenant_id: tenantId,
        actor_user_id: req.user.id,
        action,
        entity_type: 'tenant',
        entity_id: tenantId,
        after: details,
      });
    }
  }

  private async loadTenant(id: string) {
    const { data: tenant } = await this.supabase.admin
      .from('tenants')
      .select('id, name, slug, status, region, created_at')
      .eq('id', id)
      .maybeSingle();
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
    let query = this.supabase.admin
      .from('tenants')
      .select(
        'id, name, slug, status, region, created_at, subscriptions(status, trial_ends_at, plans(key, name))',
      )
      .order('created_at', { ascending: false })
      .limit(200);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) {
      throw new InternalServerErrorException({ code: 'TENANT_LIST_FAILED' });
    }
    return { tenants: data ?? [] };
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
    await this.supabase.admin
      .from('tenants')
      .update({ status: 'suspended' })
      .eq('id', id);
    await this.audit(req, 'platform.tenant_suspended', id, {
      reason: parsed.data.reason,
    });
    return { suspended: true };
  }

  @Post('tenants/:id/reactivate')
  @PlatformWrite()
  async reactivate(@Req() req: PlatformRequest, @Param('id') id: string) {
    const tenant = await this.loadTenant(id);
    if (tenant.status !== 'suspended') {
      throw new BadRequestException({ code: 'TENANT_NOT_SUSPENDED' });
    }
    await this.supabase.admin
      .from('tenants')
      .update({ status: 'live' })
      .eq('id', id);
    await this.audit(req, 'platform.tenant_reactivated', id);
    return { reactivated: true };
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
    const { data: plan } = await this.supabase.admin
      .from('plans')
      .select('id, key')
      .eq('key', parsed.data.planKey)
      .eq('is_active', true)
      .maybeSingle();
    if (!plan) throw new BadRequestException({ code: 'PLAN_NOT_FOUND' });

    const { data: sub } = await this.supabase.admin
      .from('subscriptions')
      .select('id')
      .eq('tenant_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sub) {
      await this.supabase.admin
        .from('subscriptions')
        .update({ plan_id: plan.id as string, status: 'active' })
        .eq('id', sub.id);
    } else {
      await this.supabase.admin.from('subscriptions').insert({
        tenant_id: id,
        plan_id: plan.id as string,
        status: 'active',
      });
    }
    // Entitlements are resolved per-request from the DB, so the change takes
    // effect immediately — modules, caps and access included (CTO §7).
    await this.audit(req, 'platform.plan_changed', id, {
      planKey: plan.key as string,
    });
    return { planKey: plan.key as string };
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
    const { data: sub } = await this.supabase.admin
      .from('subscriptions')
      .select('id, trial_ends_at, status')
      .eq('tenant_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!sub) throw new BadRequestException({ code: 'NO_SUBSCRIPTION' });
    const base = Math.max(
      Date.now(),
      sub.trial_ends_at ? new Date(sub.trial_ends_at as string).getTime() : 0,
    );
    const newEnd = new Date(
      base + parsed.data.days * 24 * 3600 * 1000,
    ).toISOString();
    await this.supabase.admin
      .from('subscriptions')
      .update({ trial_ends_at: newEnd, status: 'trialing' })
      .eq('id', sub.id);
    await this.audit(req, 'platform.trial_extended', id, {
      days: parsed.data.days,
      trialEndsAt: newEnd,
    });
    return { trialEndsAt: newEnd };
  }
}
