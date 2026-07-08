import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { resolveWebOrigin } from '../config';

const INVITABLE_ROLES = [
  'director',
  'head_teacher',
  'school_admin',
  'academic_master',
  'bursar',
  'accountant',
  'cashier',
  'teacher',
  'class_teacher',
] as const;

const createInviteSchema = z.object({
  email: z.string().email(),
  roleKeys: z.array(z.enum(INVITABLE_ROLES)).min(1).max(3),
});

const acceptSchema = z.object({ token: z.string().min(32).max(128) });

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

@Controller('invitations')
export class InvitationsController {
  constructor(private readonly supabase: SupabaseService) {}

  @Post()
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.invite')
  async create(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createInviteSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVITE_INVALID',
        issues: parsed.error.issues,
      });
    }

    // Plan cap (mig 0013): staff seats.
    const { limits, usage, planKey } = req.tenant.entitlements;
    if (limits.staff !== null && usage.staff + 1 > limits.staff) {
      throw new ForbiddenException({
        code: 'PLAN_LIMIT_STAFF',
        limit: limits.staff,
        current: usage.staff,
        planKey,
      });
    }

    const token = randomBytes(24).toString('hex');
    const { error } = await this.supabase.admin.from('invitations').insert({
      tenant_id: req.tenant.tenantId,
      email: parsed.data.email,
      role_keys: parsed.data.roleKeys,
      token_hash: hashToken(token),
      invited_by: req.user.id,
      expires_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    });
    if (error) {
      throw new InternalServerErrorException({
        code: 'INVITE_FAILED',
        message: error.message,
      });
    }

    return {
      inviteUrl: `${resolveWebOrigin()}/invite/${token}`,
      email: parsed.data.email,
      roleKeys: parsed.data.roleKeys,
    };
  }

  @Get()
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.invite')
  async list(@Req() req: TenantRequest) {
    const { data } = await this.supabase.admin
      .from('invitations')
      .select('id, email, role_keys, status, expires_at, created_at')
      .eq('tenant_id', req.tenant.tenantId)
      .order('created_at', { ascending: false })
      .limit(100);
    return { data: data ?? [] };
  }

  /** No TenantGuard: the caller is not a member yet. */
  @Post('accept')
  @UseGuards(AuthGuard)
  async accept(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'INVITE_TOKEN_INVALID' });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('accept_invitation', {
      p_user_id: req.user.id,
      p_email: req.user.email ?? '',
      p_token_hash: hashToken(parsed.data.token),
    });
    if (error) {
      throw new BadRequestException({
        code: error.message.includes('EMAIL_MISMATCH')
          ? 'INVITE_EMAIL_MISMATCH'
          : 'INVITE_INVALID_OR_EXPIRED',
        message: error.message,
      });
    }
    return data as { tenantId: string };
  }
}

@Controller('staff')
export class StaffController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get()
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.manage')
  async list(@Req() req: TenantRequest) {
    const { data } = await this.supabase.admin
      .from('tenant_memberships')
      .select(
        'id, status, created_at, profiles(full_name), membership_roles(roles(name, key))',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .order('created_at');
    return { data: data ?? [] };
  }
}
