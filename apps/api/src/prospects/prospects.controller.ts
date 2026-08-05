import {
  BadRequestException,
  Body,
  Controller,
  InternalServerErrorException,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Public prospect capture for the marketing funnel.
 *
 * Deliberately has NO AuthGuard: it exists to serve anonymous visitors who
 * arrived from a cold SMS. Every input is length-capped and a honeypot field
 * is accepted so the caller can discard obvious bots.
 *
 * The school is re-resolved from its id by the CALLER before it reaches here,
 * and the name is stored only as a denormalised copy for the sales inbox.
 */
const prospectSchema = z.object({
  schoolId: z.string().trim().max(120).optional(),
  schoolName: z.string().trim().max(200).optional(),
  district: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  outreachCode: z.string().trim().max(40).optional(),
  usesSystem: z.boolean().optional(),
  contactName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  preferredDay: z.string().trim().max(40).optional(),
  intent: z.enum(['demo', 'self_tour']),
});

@Controller('prospects')
export class ProspectsController {
  constructor(private readonly supabase: SupabaseService) {}

  // A cold lead costs real money per SMS and arrives once, so the limit is
  // generous enough not to drop a genuine retry but tight enough to blunt a
  // script.
  @Post()
  @Throttle({
    default: {
      limit: Number(process.env.PROSPECT_RATE_LIMIT ?? 20),
      ttl: 60_000,
    },
  })
  async capture(@Body() body: unknown) {
    const parsed = prospectSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'PROSPECT_INVALID_PAYLOAD',
        issues: parsed.error.issues,
      });
    }

    const d = parsed.data;
    const { data, error } = await this.supabase.admin
      .from('prospect_submissions')
      .insert({
        school_id: d.schoolId ?? null,
        school_name: d.schoolName ?? null,
        district: d.district ?? null,
        region: d.region ?? null,
        outreach_code: d.outreachCode ?? null,
        uses_system: d.usesSystem ?? null,
        contact_name: d.contactName ?? null,
        phone: d.phone ?? null,
        preferred_day: d.preferredDay ?? null,
        intent: d.intent,
      })
      .select('id')
      .single();

    if (error) {
      // The caller still emails the record, so the lead is not lost — but it
      // must be told the truth about storage.
      throw new InternalServerErrorException({ code: 'PROSPECT_NOT_STORED' });
    }

    return { stored: true, id: data.id as string };
  }
}
