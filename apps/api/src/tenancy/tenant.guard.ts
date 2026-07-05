import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { SupabaseService } from '../supabase/supabase.service';

export const REQUIRE_PERMISSION = 'require_permission';
export const RequirePermission = (key: string) =>
  SetMetadata(REQUIRE_PERMISSION, key);

export interface TenantContext {
  tenantId: string;
  membershipId: string;
  roleKeys: string[];
  permissions: Set<string>;
  isOwner: boolean;
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
    };
    return true;
  }
}
