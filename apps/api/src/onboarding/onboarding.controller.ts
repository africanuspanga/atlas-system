import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  InternalServerErrorException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { onboardingSchema } from './onboarding.schema';

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly supabase: SupabaseService) {}

  // Tenant creation is the most abusable endpoint (AUD-016): tight per-IP
  // rate limit on top of the global one. Configurable for test environments.
  @Post()
  @Throttle({
    default: {
      limit: Number(process.env.ONBOARD_RATE_LIMIT ?? 6),
      ttl: 60_000,
    },
  })
  @UseGuards(AuthGuard)
  async onboard(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const parsed = onboardingSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'ONBOARDING_INVALID_PAYLOAD',
        issues: parsed.error.issues,
      });
    }

    const slug = parsed.data.school.slug;
    const { data: existing } = await this.supabase.admin
      .from('tenants')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (existing) {
      throw new ConflictException({
        code: 'ONBOARDING_SLUG_TAKEN',
        message: `A school with the address "${slug}" already exists.`,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('onboard_school', {
      p_user_id: req.user.id,
      p_payload: parsed.data,
    });

    if (error) {
      if (error.message.includes('duplicate key')) {
        throw new ConflictException({
          code: 'ONBOARDING_SLUG_TAKEN',
          message: error.message,
        });
      }
      throw new InternalServerErrorException({
        code: 'ONBOARDING_FAILED',
        message: error.message,
      });
    }

    const result = data as {
      tenantId: string;
      campusId: string;
      academicYearId: string;
    };

    // Every new school starts on a 30-day trial subscription — this is what
    // the TenantGuard's entitlement enforcement (mig 0013) evaluates.
    const { data: trialPlan } = await this.supabase.admin
      .from('plans')
      .select('id')
      .eq('key', 'trial')
      .single();
    if (trialPlan) {
      await this.supabase.admin.from('subscriptions').insert({
        tenant_id: result.tenantId,
        plan_id: trialPlan.id as string,
        status: 'trialing',
        trial_ends_at: new Date(
          Date.now() + 30 * 24 * 3600 * 1000,
        ).toISOString(),
      });
    }

    return result;
  }
}
