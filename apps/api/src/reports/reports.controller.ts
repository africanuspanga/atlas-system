import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Body,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { QueueKickService } from '../queue/queue-kick.service';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/**
 * Report catalogue. Numbers are calculated (and ledger-reconciled) by the
 * report_* SQL functions — the API only creates jobs, the worker only
 * formats. Every key declares which permission it needs beyond the general
 * reports.generate gate.
 */
export const CATALOGUE = {
  fee_collection: {
    title: 'Fee collection',
    formats: ['csv', 'xlsx', 'pdf'],
    permission: 'finance.reports.view',
    params: z.object({ from: dateStr, to: dateStr }),
  },
  outstanding_balances: {
    title: 'Outstanding fee balances',
    formats: ['csv', 'xlsx', 'pdf'],
    permission: 'finance.reports.view',
    params: z.object({}),
  },
  trial_balance: {
    title: 'Trial balance',
    formats: ['pdf', 'csv', 'xlsx'],
    permission: 'finance.reports.view',
    params: z.object({}),
  },
  student_statement: {
    title: 'Student fee statement',
    formats: ['pdf'],
    permission: 'finance.reports.view',
    params: z.object({ studentId: z.string().uuid() }),
  },
  report_card: {
    title: 'Student report card',
    formats: ['pdf'],
    permission: 'students.view',
    params: z.object({
      studentId: z.string().uuid(),
      termId: z.string().uuid(),
    }),
  },
} as const;

export type ReportKey = keyof typeof CATALOGUE;

const createSchema = z.object({
  reportKey: z.enum(Object.keys(CATALOGUE) as [ReportKey, ...ReportKey[]]),
  format: z.enum(['pdf', 'csv', 'xlsx']),
  params: z.record(z.string(), z.unknown()).default({}),
});

@Controller('reports')
@UseGuards(AuthGuard, TenantGuard)
export class ReportsController {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly queue: QueueKickService,
  ) {}

  @Get('catalogue')
  @RequirePermission('reports.generate')
  catalogue(@Req() req: TenantRequest) {
    const available = Object.entries(CATALOGUE)
      .filter(
        ([, def]) =>
          req.tenant.isOwner || req.tenant.permissions.has(def.permission),
      )
      .map(([key, def]) => ({ key, title: def.title, formats: def.formats }));
    return { reports: available };
  }

  @Post()
  @RequirePermission('reports.generate')
  async create(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'REPORT_INVALID',
        issues: parsed.error.issues,
      });
    }
    const def = CATALOGUE[parsed.data.reportKey];
    if (!req.tenant.isOwner && !req.tenant.permissions.has(def.permission)) {
      throw new ForbiddenException(`Missing permission: ${def.permission}`);
    }
    if (!(def.formats as readonly string[]).includes(parsed.data.format)) {
      throw new BadRequestException({ code: 'REPORT_FORMAT_UNSUPPORTED' });
    }
    const params = def.params.safeParse(parsed.data.params);
    if (!params.success) {
      throw new BadRequestException({
        code: 'REPORT_PARAMS_INVALID',
        issues: params.error.issues,
      });
    }

    // Unique per tenant (DB constraint); time-ordered and unguessable enough
    // for a reference printed on the document (downloads are signed URLs).
    const reference = `RPT-${Date.now().toString(36).toUpperCase()}${randomBytes(
      2,
    )
      .toString('hex')
      .toUpperCase()}`;

    const { data: job, error } = await this.supabase.admin
      .from('report_jobs')
      .insert({
        tenant_id: req.tenant.tenantId,
        report_key: parsed.data.reportKey,
        format: parsed.data.format,
        params: params.data,
        reference,
        requested_by: req.user.id,
      })
      .select('id')
      .single();
    if (error) {
      throw new InternalServerErrorException({
        code: 'REPORT_CREATE_FAILED',
        message: error.message,
      });
    }

    await this.supabase.admin.from('audit_logs').insert({
      tenant_id: req.tenant.tenantId,
      actor_user_id: req.user.id,
      action: 'report.requested',
      entity_type: 'report_job',
      entity_id: job.id as string,
      after: { reportKey: parsed.data.reportKey, format: parsed.data.format },
    });
    await this.queue.kick(
      'reports',
      'generate-report',
      job.id as string,
      { tenantId: req.tenant.tenantId, actorUserId: req.user.id },
      { reportJobId: job.id as string },
    );
    return { jobId: job.id as string, reference };
  }

  @Get()
  @RequirePermission('reports.generate')
  async list(@Req() req: TenantRequest) {
    const { data, error } = await this.supabase.admin
      .from('report_jobs')
      .select(
        'id, report_key, format, status, reference, params, error, created_at, completed_at',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      throw new InternalServerErrorException({ code: 'REPORT_LIST_FAILED' });
    }
    return { jobs: data ?? [] };
  }

  @Get(':id')
  @RequirePermission('reports.generate')
  async detail(@Req() req: TenantRequest, @Param('id') id: string) {
    const { data: job, error } = await this.supabase.admin
      .from('report_jobs')
      .select(
        'id, report_key, format, status, reference, params, totals, error, created_at, completed_at',
      )
      .eq('id', id)
      .eq('tenant_id', req.tenant.tenantId)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException({ code: 'REPORT_LOOKUP_FAILED' });
    }
    if (!job) throw new NotFoundException({ code: 'REPORT_JOB_NOT_FOUND' });
    return { job };
  }

  @Get(':id/download')
  @RequirePermission('reports.generate')
  async download(@Req() req: TenantRequest, @Param('id') id: string) {
    const { data: job } = await this.supabase.admin
      .from('report_jobs')
      .select('id, status, file_path, report_key')
      .eq('id', id)
      .eq('tenant_id', req.tenant.tenantId)
      .maybeSingle();
    if (!job) throw new NotFoundException({ code: 'REPORT_JOB_NOT_FOUND' });
    if (job.status !== 'completed' || !job.file_path) {
      throw new BadRequestException({
        code: 'REPORT_NOT_READY',
        status: job.status as string,
      });
    }
    const def = CATALOGUE[job.report_key as ReportKey];
    if (
      def &&
      !req.tenant.isOwner &&
      !req.tenant.permissions.has(def.permission)
    ) {
      throw new ForbiddenException(`Missing permission: ${def.permission}`);
    }
    const { data, error } = await this.supabase.admin.storage
      .from('reports')
      .createSignedUrl(job.file_path as string, 300);
    if (error || !data) {
      throw new InternalServerErrorException({ code: 'REPORT_SIGN_FAILED' });
    }
    await this.supabase.admin.from('audit_logs').insert({
      tenant_id: req.tenant.tenantId,
      actor_user_id: req.user.id,
      action: 'report.downloaded',
      entity_type: 'report_job',
      entity_id: job.id as string,
    });
    return { url: data.signedUrl, expiresInSec: 300 };
  }
}
