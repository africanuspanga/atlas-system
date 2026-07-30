import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  InternalServerErrorException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { registerDeviceSchema, unregisterDeviceSchema } from './devices.schema';

/**
 * Mobile push-token registry (public.device_tokens, migration 0028).
 *
 * AuthGuard ONLY — deliberately no TenantGuard: parents/guardians sign in
 * without any tenant membership, and a push token belongs to the user, not
 * to a school. tenantId is optional routing context carried in the body.
 * Storing tokens is all this does; sending pushes is a future worker.
 */
@Controller('devices')
@UseGuards(AuthGuard)
export class DevicesController {
  constructor(private readonly supabase: SupabaseService) {}

  /** Upsert this device's Expo push token for the signed-in user. */
  @Post()
  async register(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = registerDeviceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'DEVICE_INVALID',
        issues: parsed.error.issues,
      });
    }
    if (parsed.data.tenantId) {
      const { data: tenant } = await this.supabase.admin
        .from('tenants')
        .select('id')
        .eq('id', parsed.data.tenantId)
        .maybeSingle();
      if (!tenant) {
        throw new BadRequestException({ code: 'DEVICE_TENANT_NOT_FOUND' });
      }
    }
    // A device token is unique per device: whoever signed in last owns it,
    // so conflicts re-point user_id/tenant_id (shared-phone handover).
    const { data, error } = await this.supabase.admin
      .from('device_tokens')
      .upsert(
        {
          user_id: req.user.id,
          tenant_id: parsed.data.tenantId ?? null,
          expo_push_token: parsed.data.token,
          platform: parsed.data.platform,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'expo_push_token' },
      )
      .select('id')
      .single();
    if (error) {
      throw new InternalServerErrorException({
        code: 'DEVICE_REGISTER_FAILED',
        message: error.message,
      });
    }
    return { deviceId: data.id as string };
  }

  /** Remove a token — only the user who currently owns it may delete it. */
  @Delete()
  async unregister(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = unregisterDeviceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'DEVICE_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { error, count } = await this.supabase.admin
      .from('device_tokens')
      .delete({ count: 'exact' })
      .eq('expo_push_token', parsed.data.token)
      .eq('user_id', req.user.id);
    if (error) {
      throw new InternalServerErrorException({
        code: 'DEVICE_UNREGISTER_FAILED',
        message: error.message,
      });
    }
    return { removed: count ?? 0 };
  }
}
