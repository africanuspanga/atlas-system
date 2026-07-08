import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { SupabaseService } from '../supabase/supabase.service';

export const PLATFORM_WRITE = 'platform_write';
/** Marks an endpoint as mutating platform state → super_admin only. */
export const PlatformWrite = () => SetMetadata(PLATFORM_WRITE, true);

export interface PlatformRequest extends AuthenticatedRequest {
  platformRole: string;
}

/**
 * Platform-staff identity, entirely separate from tenant membership:
 * profiles.platform_role (super_admin, support, finance, implementation,
 * auditor). Any role may read; only super_admin may act. Runs after
 * AuthGuard. A tenant school-owner WITHOUT a platform_role gets 403 here —
 * proven by smoke-platform.mjs.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    const { data: profile } = await this.supabase.admin
      .from('profiles')
      .select('platform_role')
      .eq('id', request.user.id)
      .maybeSingle();
    const role = profile?.platform_role as string | null | undefined;
    if (!role) {
      throw new ForbiddenException({ code: 'NOT_PLATFORM_STAFF' });
    }
    const needsWrite = this.reflector.get<boolean | undefined>(
      PLATFORM_WRITE,
      context.getHandler(),
    );
    if (needsWrite && role !== 'super_admin') {
      throw new ForbiddenException({ code: 'PLATFORM_READ_ONLY_ROLE' });
    }
    request.platformRole = role;
    return true;
  }
}
