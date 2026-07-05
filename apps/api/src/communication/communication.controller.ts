import {
  BadRequestException,
  Body,
  Controller,
  InternalServerErrorException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { createAnnouncementSchema } from './communication.schema';

const KNOWN_ERRORS = [
  'ANNOUNCEMENT_SECTION_NOT_FOUND',
  'ANNOUNCEMENT_BAD_AUDIENCE',
  'ANNOUNCEMENT_NO_RECIPIENTS',
];

@Controller('communication')
@UseGuards(AuthGuard, TenantGuard)
export class CommunicationController {
  constructor(private readonly supabase: SupabaseService) {}

  @Post('announcements')
  @RequirePermission('communication.send')
  async announce(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createAnnouncementSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'ANNOUNCEMENT_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'queue_announcement',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_audience_type: parsed.data.audienceType,
        p_class_section_id: parsed.data.classSectionId ?? null,
        p_body: parsed.data.body,
      },
    );
    if (error) {
      const match = KNOWN_ERRORS.find((code) => error.message.includes(code));
      if (match) {
        throw new BadRequestException({ code: match, message: error.message });
      }
      throw new InternalServerErrorException({
        code: 'ANNOUNCEMENT_FAILED',
        message: error.message,
      });
    }
    return data as { announcementId: string; recipients: number };
  }
}
