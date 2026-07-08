import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { SupabaseService } from '../supabase/supabase.service';

export const REQUIRE_PERMISSION = 'require_permission';
export const RequirePermission = (key: string) =>
  SetMetadata(REQUIRE_PERMISSION, key);

/** Resolved plan/subscription document (app.tenant_entitlements, mig 0013). */
export interface TenantEntitlements {
  tenantStatus: string;
  planKey: string;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  limits: {
    students: number | null;
    staff: number | null;
    campuses: number | null;
    smsMonthly: number | null;
  };
  features: Record<string, boolean>;
  usage: {
    students: number;
    staff: number;
    campuses: number;
    smsThisMonth: number;
  };
}

export interface TenantContext {
  tenantId: string;
  membershipId: string;
  roleKeys: string[];
  permissions: Set<string>;
  isOwner: boolean;
  entitlements: TenantEntitlements;
}

export interface TenantRequest extends AuthenticatedRequest {
  tenant: TenantContext;
}

/** Roles with full access to their school (blueprint: School Owner/Director). */
const SUPER_ROLES = ['school_owner', 'director'];

/**
 * Resolves the active tenant from the x-tenant-id header, verifies the
 * caller's membership, loads role permissions and enforces the permission
 * declared with @RequirePermission. Runs after AuthGuard.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const tenantId = request.headers['x-tenant-id'];
    if (typeof tenantId !== 'string' || !/^[0-9a-f-]{36}$/.test(tenantId)) {
      throw new UnauthorizedException('Missing or invalid x-tenant-id header');
    }

    const { data: membership } = await this.supabase.admin
      .from('tenant_memberships')
      .select('id, status')
      .eq('tenant_id', tenantId)
      .eq('user_id', request.user.id)
      .eq('status', 'active')
      .maybeSingle();
    if (!membership) {
      throw new ForbiddenException('Not an active member of this school');
    }

    // Subscription enforcement (mig 0013): suspension blocks everything; an
    // expired trial / cancelled subscription blocks mutations but leaves
    // reads open so a school is never locked away from its own data.
    // Fails CLOSED — no entitlement document, no access (cf. AUD-004).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: entData, error: entError } = await this.supabase.admin.rpc(
      'tenant_entitlements',
      { p_tenant_id: tenantId },
    );
    if (entError || !entData) {
      throw new InternalServerErrorException({
        code: 'ENTITLEMENTS_LOOKUP_FAILED',
      });
    }
    const entitlements = entData as TenantEntitlements;
    if (
      entitlements.tenantStatus === 'suspended' ||
      entitlements.subscriptionStatus === 'suspended'
    ) {
      throw new ForbiddenException({ code: 'TENANT_SUSPENDED' });
    }
    if (entitlements.tenantStatus === 'archived') {
      throw new ForbiddenException({ code: 'TENANT_ARCHIVED' });
    }
    const trialExpired =
      entitlements.subscriptionStatus === 'trialing' &&
      entitlements.trialEndsAt !== null &&
      new Date(entitlements.trialEndsAt).getTime() < Date.now();
    if (
      request.method !== 'GET' &&
      (trialExpired ||
        ['cancelled', 'expired'].includes(entitlements.subscriptionStatus))
    ) {
      throw new ForbiddenException({ code: 'SUBSCRIPTION_EXPIRED' });
    }

    const { data: roleRows } = await this.supabase.admin
      .from('membership_roles')
      .select('roles(key, id)')
      .eq('membership_id', membership.id);
    const roles = (roleRows ?? [])
      .map((r) => r.roles as unknown as { key: string; id: string } | null)
      .filter((r): r is { key: string; id: string } => r !== null);
    const roleKeys = roles.map((r) => r.key);
    const isOwner = roleKeys.some((k) => SUPER_ROLES.includes(k));

    const permissions = new Set<string>();
    if (!isOwner && roles.length > 0) {
      const { data: perms } = await this.supabase.admin
        .from('role_permissions')
        .select('permission_key')
        .in(
          'role_id',
          roles.map((r) => r.id),
        );
      for (const p of perms ?? []) permissions.add(p.permission_key as string);
    }

    const required = this.reflector.get<string | undefined>(
      REQUIRE_PERMISSION,
      context.getHandler(),
    );
    if (required && !isOwner && !permissions.has(required)) {
      throw new ForbiddenException(`Missing permission: ${required}`);
    }

    request.tenant = {
      tenantId,
      membershipId: membership.id as string,
      roleKeys,
      permissions,
      isOwner,
      entitlements,
    };
    return true;
  }
}
