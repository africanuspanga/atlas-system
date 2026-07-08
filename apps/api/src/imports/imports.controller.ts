import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { QueueKickService } from '../queue/queue-kick.service';
import {
  ALLOWED_EXTENSIONS,
  ImportParseError,
  parseImportFile,
  type ParsedSheet,
} from './imports.parser';
import {
  DOMAIN_FIELDS,
  DOMAIN_PERMISSION,
  type ImportDomain,
  normalizeGender,
  normalizeHeader,
  normalizePhone,
  parseAmount,
  parseDate,
  splitFullName,
  suggestField,
} from './import-domains';

const createSchema = z.object({
  domain: z.enum(['students', 'opening_balances']),
});

const mappingSchema = z.object({
  mapping: z
    .record(z.string(), z.string().nullable())
    .refine((m) => Object.keys(m).length <= 100, 'Too many columns'),
});

interface RowIssue {
  field: string;
  code: string;
  message: string;
}

interface StagingRow {
  id: string;
  row_number: number;
  raw_data: Record<string, string>;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;

@Controller('imports')
@UseGuards(AuthGuard, TenantGuard)
export class ImportsController {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly queue: QueueKickService,
  ) {}

  /** Domain-specific creation right, on top of imports.manage. */
  private assertDomainPermission(req: TenantRequest, domain: ImportDomain) {
    const needed = DOMAIN_PERMISSION[domain];
    if (!req.tenant.isOwner && !req.tenant.permissions.has(needed)) {
      throw new ForbiddenException(`Missing permission: ${needed}`);
    }
  }

  private async loadJob(req: TenantRequest, id: string) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data: job, error } = await this.supabase.admin
      .from('import_jobs')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', req.tenant.tenantId)
      .maybeSingle();
    if (error) {
      throw new InternalServerErrorException({ code: 'IMPORT_LOOKUP_FAILED' });
    }
    if (!job) throw new NotFoundException({ code: 'IMPORT_JOB_NOT_FOUND' });
    return job as Record<string, unknown> & {
      id: string;
      domain: ImportDomain;
      status: string;
      file_path: string;
      row_count: number;
      column_mapping: Record<string, string | null>;
      summary: Record<string, unknown>;
    };
  }

  /** Reads all staging rows past PostgREST's 1000-row page limit. */
  private async loadStagingRows(jobId: string): Promise<StagingRow[]> {
    const rows: StagingRow[] = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const { data, error } = await this.supabase.admin
        .from('import_staging_rows')
        .select('id, row_number, raw_data')
        .eq('import_job_id', jobId)
        .order('row_number')
        .range(from, from + page - 1);
      if (error) {
        throw new InternalServerErrorException({
          code: 'IMPORT_ROWS_READ_FAILED',
        });
      }
      rows.push(...((data ?? []) as StagingRow[]));
      if (!data || data.length < page) break;
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // 1. Upload: store privately, parse, stage raw rows, suggest a mapping.
  // -------------------------------------------------------------------------
  @Post()
  @RequirePermission('imports.manage')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }),
  )
  async create(
    @Req() req: TenantRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'IMPORT_INVALID',
        issues: parsed.error.issues,
      });
    }
    const domain = parsed.data.domain;
    this.assertDomainPermission(req, domain);

    if (!file) throw new BadRequestException({ code: 'IMPORT_FILE_MISSING' });
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new BadRequestException({
        code: 'IMPORT_FILE_TYPE',
        message: `Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
      });
    }

    let sheet: ParsedSheet;
    try {
      sheet = parseImportFile(file.buffer, file.originalname);
    } catch (err) {
      if (err instanceof ImportParseError) {
        throw new BadRequestException({ code: err.code, message: err.message });
      }
      throw err;
    }

    const fingerprint = createHash('md5')
      .update(sheet.headers.map(normalizeHeader).join('|'))
      .digest('hex');

    const { data: job, error: jobError } = await this.supabase.admin
      .from('import_jobs')
      .insert({
        tenant_id: req.tenant.tenantId,
        domain,
        status: 'uploaded',
        file_path: 'pending',
        original_filename: file.originalname.slice(0, 200),
        file_size: file.size,
        row_count: sheet.rows.length,
        summary: { headers: sheet.headers, headersFingerprint: fingerprint },
        created_by: req.user.id,
      })
      .select('id')
      .single();
    if (jobError) {
      throw new InternalServerErrorException({
        code: 'IMPORT_CREATE_FAILED',
        message: jobError.message,
      });
    }
    const jobId = job.id as string;

    // Private bucket, tenant-prefixed path; original filename is metadata only.
    const filePath = `${req.tenant.tenantId}/${jobId}/original${ext}`;
    const { error: uploadError } = await this.supabase.admin.storage
      .from('imports')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype || 'application/octet-stream',
        upsert: false,
      });
    if (uploadError) {
      await this.supabase.admin
        .from('import_jobs')
        .update({ status: 'failed', summary: { error: 'upload failed' } })
        .eq('id', jobId);
      throw new InternalServerErrorException({
        code: 'IMPORT_UPLOAD_FAILED',
        message: uploadError.message,
      });
    }
    await this.supabase.admin
      .from('import_jobs')
      .update({ file_path: filePath })
      .eq('id', jobId);

    // Stage raw rows in chunks (5000 rows max → ≤10 inserts).
    for (let i = 0; i < sheet.rows.length; i += 500) {
      const chunk = sheet.rows.slice(i, i + 500).map((row, j) => ({
        tenant_id: req.tenant.tenantId,
        import_job_id: jobId,
        row_number: i + j + 1,
        raw_data: row,
      }));
      const { error } = await this.supabase.admin
        .from('import_staging_rows')
        .insert(chunk);
      if (error) {
        await this.supabase.admin
          .from('import_jobs')
          .update({ status: 'failed' })
          .eq('id', jobId);
        throw new InternalServerErrorException({
          code: 'IMPORT_STAGE_FAILED',
          message: error.message,
        });
      }
    }

    // Saved mapping from a previous import with the same headers?
    const { data: saved } = await this.supabase.admin
      .from('import_column_mappings')
      .select('mapping')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('domain', domain)
      .eq('headers_fingerprint', fingerprint)
      .maybeSingle();

    const taken = new Set<string>();
    const suggestedMapping = Object.fromEntries(
      sheet.headers.map((h) => {
        const s = suggestField(h, domain, taken);
        if (s.field && s.confidence === 'high') taken.add(s.field);
        return [h, s];
      }),
    );

    return {
      jobId,
      domain,
      rowCount: sheet.rows.length,
      headers: sheet.headers,
      sampleRows: sheet.rows.slice(0, 5),
      suggestedMapping,
      savedMapping: (saved?.mapping as Record<string, string | null>) ?? null,
      fields: DOMAIN_FIELDS[domain].map(({ key, label, required }) => ({
        key,
        label,
        required,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // 2. Mapping + validation (the dry run). Idempotent: can be re-run with a
  //    corrected mapping until the school approves.
  // -------------------------------------------------------------------------
  @Put(':id/mapping')
  @RequirePermission('imports.manage')
  async setMapping(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = mappingSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'IMPORT_MAPPING_INVALID',
        issues: parsed.error.issues,
      });
    }
    const job = await this.loadJob(req, id);
    if (!['uploaded', 'validated'].includes(job.status)) {
      throw new BadRequestException({ code: 'IMPORT_JOB_NOT_MAPPABLE' });
    }
    const domain = job.domain;
    const fieldKeys = new Set(DOMAIN_FIELDS[domain].map((f) => f.key));
    const mapping: Record<string, string | null> = {};
    for (const [header, field] of Object.entries(parsed.data.mapping)) {
      if (field !== null && !fieldKeys.has(field)) {
        throw new BadRequestException({
          code: 'IMPORT_UNKNOWN_FIELD',
          message: field,
        });
      }
      mapping[header] = field;
    }
    const mapped = new Set(Object.values(mapping).filter(Boolean) as string[]);
    const missing: string[] = [];
    if (domain === 'students') {
      if (!mapped.has('gender')) missing.push('gender');
      if (
        !mapped.has('fullName') &&
        !(mapped.has('firstName') && mapped.has('lastName'))
      ) {
        missing.push('fullName (or firstName + lastName)');
      }
    } else {
      for (const f of ['studentNumber', 'amount'])
        if (!mapped.has(f)) missing.push(f);
    }
    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'IMPORT_MAPPING_INCOMPLETE',
        missing,
      });
    }

    const rows = await this.loadStagingRows(job.id);
    const validated =
      domain === 'students'
        ? await this.validateStudents(req, rows, mapping)
        : await this.validateOpeningBalances(req, rows, mapping);

    // Write back in chunks via upsert-by-id.
    for (let i = 0; i < validated.length; i += 500) {
      const chunk = validated.slice(i, i + 500).map((v) => ({
        id: v.id,
        tenant_id: req.tenant.tenantId,
        import_job_id: job.id,
        row_number: v.row_number,
        raw_data: v.raw_data,
        mapped_data: v.mapped_data,
        validation_status: v.validation_status,
        validation_errors: v.issues,
        duplicate_status: v.duplicate_status,
      }));
      const { error } = await this.supabase.admin
        .from('import_staging_rows')
        .upsert(chunk, { onConflict: 'id' });
      if (error) {
        throw new InternalServerErrorException({
          code: 'IMPORT_VALIDATE_WRITE_FAILED',
          message: error.message,
        });
      }
    }

    const counts = {
      valid: validated.filter((v) => v.validation_status === 'valid').length,
      warnings: validated.filter((v) => v.validation_status === 'warning')
        .length,
      invalid: validated.filter((v) => v.validation_status === 'invalid')
        .length,
      duplicates: validated.filter((v) => v.duplicate_status !== 'none').length,
    };
    await this.supabase.admin
      .from('import_jobs')
      .update({
        status: 'validated',
        column_mapping: mapping,
        valid_rows: counts.valid,
        warning_rows: counts.warnings,
        invalid_rows: counts.invalid,
        duplicate_rows: counts.duplicates,
      })
      .eq('id', job.id);

    // Remember this mapping for the school's next file with the same headers.
    const fingerprint = (job.summary as { headersFingerprint?: string })
      .headersFingerprint;
    if (fingerprint) {
      await this.supabase.admin.from('import_column_mappings').upsert(
        {
          tenant_id: req.tenant.tenantId,
          domain,
          headers_fingerprint: fingerprint,
          mapping,
        },
        { onConflict: 'tenant_id,domain,headers_fingerprint' },
      );
    }

    return {
      jobId: job.id,
      rowCount: validated.length,
      ...counts,
      issues: validated
        .filter((v) => v.validation_status !== 'valid')
        .slice(0, 20)
        .map((v) => ({
          rowNumber: v.row_number,
          status: v.validation_status,
          duplicate: v.duplicate_status,
          errors: v.issues,
        })),
    };
  }

  // -------------------------------------------------------------------------
  // 3. Approve → queue for the worker. 4. Cancel.
  // -------------------------------------------------------------------------
  @Post(':id/approve')
  @RequirePermission('imports.manage')
  async approve(@Req() req: TenantRequest, @Param('id') id: string) {
    const job = await this.loadJob(req, id);
    this.assertDomainPermission(req, job.domain);
    if (job.status !== 'validated') {
      throw new BadRequestException({ code: 'IMPORT_JOB_NOT_VALIDATED' });
    }
    const committable =
      Number(job.valid_rows ?? 0) + Number(job.warning_rows ?? 0);
    if (committable === 0) {
      throw new BadRequestException({ code: 'IMPORT_NOTHING_TO_COMMIT' });
    }
    // Plan cap (mig 0013): a bulk import may not blow past the student limit.
    if (job.domain === 'students') {
      const { limits, usage, planKey } = req.tenant.entitlements;
      if (
        limits.students !== null &&
        usage.students + committable > limits.students
      ) {
        throw new ForbiddenException({
          code: 'PLAN_LIMIT_STUDENTS',
          limit: limits.students,
          current: usage.students,
          adding: committable,
          planKey,
        });
      }
    }
    const { data: updated } = await this.supabase.admin
      .from('import_jobs')
      .update({ status: 'queued' })
      .eq('id', job.id)
      .eq('status', 'validated') // guard against double-approve races
      .select('id');
    if (!updated || updated.length === 0) {
      throw new BadRequestException({ code: 'IMPORT_JOB_NOT_VALIDATED' });
    }
    await this.supabase.admin.from('audit_logs').insert({
      tenant_id: req.tenant.tenantId,
      actor_user_id: req.user.id,
      action: 'import.approved',
      entity_type: 'import_job',
      entity_id: job.id,
      after: { domain: job.domain, rows: committable },
    });
    await this.queue.kick(
      'imports',
      'commit-import',
      job.id,
      { tenantId: req.tenant.tenantId, actorUserId: req.user.id },
      { importJobId: job.id },
    );
    return { queued: true, rows: committable };
  }

  @Post(':id/cancel')
  @RequirePermission('imports.manage')
  async cancel(@Req() req: TenantRequest, @Param('id') id: string) {
    const job = await this.loadJob(req, id);
    if (!['uploaded', 'validated', 'queued'].includes(job.status)) {
      throw new BadRequestException({ code: 'IMPORT_JOB_NOT_CANCELLABLE' });
    }
    await this.supabase.admin
      .from('import_jobs')
      .update({ status: 'cancelled' })
      .eq('id', job.id)
      .in('status', ['uploaded', 'validated', 'queued']);
    await this.supabase.admin.from('audit_logs').insert({
      tenant_id: req.tenant.tenantId,
      actor_user_id: req.user.id,
      action: 'import.cancelled',
      entity_type: 'import_job',
      entity_id: job.id,
    });
    return { cancelled: true };
  }

  // -------------------------------------------------------------------------
  // History + detail + private downloads
  // -------------------------------------------------------------------------
  @Get()
  @RequirePermission('imports.manage')
  async list(@Req() req: TenantRequest) {
    const { data, error } = await this.supabase.admin
      .from('import_jobs')
      .select(
        'id, domain, status, original_filename, row_count, valid_rows, warning_rows, invalid_rows, duplicate_rows, committed_rows, failed_rows, created_at, committed_at',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error)
      throw new InternalServerErrorException({ code: 'IMPORT_LIST_FAILED' });
    return { jobs: data ?? [] };
  }

  @Get(':id')
  @RequirePermission('imports.manage')
  async detail(@Req() req: TenantRequest, @Param('id') id: string) {
    const job = await this.loadJob(req, id);
    const { data: problems } = await this.supabase.admin
      .from('import_staging_rows')
      .select(
        'row_number, validation_status, validation_errors, duplicate_status, commit_error',
      )
      .eq('import_job_id', job.id)
      .or('validation_status.in.(invalid,warning),commit_error.not.is.null')
      .order('row_number')
      .limit(100);
    return { job, problems: problems ?? [] };
  }

  @Get(':id/download')
  @RequirePermission('imports.manage')
  async download(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Query('target') target: string,
  ) {
    const job = await this.loadJob(req, id);
    const path =
      target === 'errors'
        ? (job.error_report_path as string | null)
        : job.file_path;
    if (!path || path === 'pending') {
      throw new NotFoundException({ code: 'IMPORT_FILE_NOT_AVAILABLE' });
    }
    const { data, error } = await this.supabase.admin.storage
      .from('imports')
      .createSignedUrl(path, 300);
    if (error || !data) {
      throw new InternalServerErrorException({ code: 'IMPORT_SIGN_FAILED' });
    }
    return { url: data.signedUrl, expiresInSec: 300 };
  }

  // -------------------------------------------------------------------------
  // Domain validators
  // -------------------------------------------------------------------------
  private applyMapping(
    raw: Record<string, string>,
    mapping: Record<string, string | null>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [header, field] of Object.entries(mapping)) {
      if (!field) continue;
      const value = raw[header];
      if (value !== undefined && value !== '') out[field] = value;
    }
    return out;
  }

  private async validateStudents(
    req: TenantRequest,
    rows: StagingRow[],
    mapping: Record<string, string | null>,
  ) {
    // Tenant context: class sections + existing students for duplicate checks.
    // class_sections.name holds the stream label ("A", "B") — see mig 0002.
    const { data: sections } = await this.supabase.admin
      .from('class_sections')
      .select('id, name, grade_levels(name)')
      .eq('tenant_id', req.tenant.tenantId);
    const sectionByKey = new Map<string, string>();
    for (const s of sections ?? []) {
      const grade =
        (s.grade_levels as unknown as { name: string } | null)?.name ?? '';
      sectionByKey.set(
        `${normalizeHeader(grade)}|${normalizeHeader((s.name as string) ?? '')}`,
        s.id as string,
      );
    }
    const { data: existing } = await this.supabase.admin
      .from('students')
      .select('first_name, last_name, date_of_birth')
      .eq('tenant_id', req.tenant.tenantId)
      .limit(10000);
    const existingKeys = new Set(
      (existing ?? []).map(
        (s) =>
          `${normalizeHeader(s.first_name as string)}|${normalizeHeader(s.last_name as string)}|${s.date_of_birth ?? ''}`,
      ),
    );

    const inFile = new Map<string, number>();
    const prepared = rows.map((row) => {
      const data = this.applyMapping(row.raw_data, mapping);
      const issues: RowIssue[] = [];
      let duplicate: 'none' | 'in_file' | 'existing' = 'none';

      if (data.fullName && !data.firstName && !data.lastName) {
        const split = splitFullName(data.fullName);
        if (!split) {
          issues.push({
            field: 'fullName',
            code: 'NAME_INCOMPLETE',
            message: 'Need at least two names',
          });
        } else {
          data.firstName = split.firstName;
          if (split.middleName) data.middleName = split.middleName;
          data.lastName = split.lastName;
        }
      }
      if (!data.firstName || !data.lastName) {
        issues.push({
          field: 'name',
          code: 'NAME_REQUIRED',
          message: 'First and last name required',
        });
      }

      const gender = data.gender ? normalizeGender(data.gender) : null;
      if (!gender) {
        issues.push({
          field: 'gender',
          code: 'GENDER_INVALID',
          message: `Unrecognised gender "${data.gender ?? ''}"`,
        });
      } else {
        data.gender = gender;
      }

      if (data.dateOfBirth) {
        const iso = parseDate(data.dateOfBirth);
        if (!iso) {
          issues.push({
            field: 'dateOfBirth',
            code: 'DOB_UNPARSEABLE',
            message: `Cannot read date "${data.dateOfBirth}"`,
          });
        } else {
          data.dateOfBirth = iso;
          const age =
            (Date.now() - new Date(iso).getTime()) / (365.25 * 86400e3);
          if (age < 3 || age > 30) {
            issues.push({
              field: 'dateOfBirth',
              code: 'DOB_IMPLAUSIBLE',
              message: `Age ${Math.round(age)} looks wrong`,
            });
          }
        }
      }

      if (data.boardingStatus) {
        const b = normalizeHeader(data.boardingStatus);
        data.boardingStatus = ['boarding', 'bweni', 'boarder'].includes(b)
          ? 'boarding'
          : 'day';
      }

      if (data.className || data.stream) {
        const key = `${normalizeHeader(data.className ?? '')}|${normalizeHeader(data.stream ?? '')}`;
        const sectionId = sectionByKey.get(key);
        if (!sectionId) {
          issues.push({
            field: 'className',
            code: 'SECTION_UNMATCHED',
            message: `No class "${data.className ?? ''} ${data.stream ?? ''}" in this school`,
          });
        } else {
          data.classSectionId = sectionId;
        }
      }

      if (data.guardianPhone) {
        const { phone, valid } = normalizePhone(data.guardianPhone);
        data.guardianPhone = phone;
        if (!valid) {
          issues.push({
            field: 'guardianPhone',
            code: 'PHONE_INVALID',
            message: `"${phone}" is not a valid TZ number`,
          });
        }
      }
      if (data.guardianName && !data.guardianPhone) {
        issues.push({
          field: 'guardianPhone',
          code: 'GUARDIAN_NO_PHONE',
          message: 'Guardian has no phone — SMS will not reach them',
        });
      }

      // Duplicates: same first+last+dob within the file or already enrolled.
      const dupKey = `${normalizeHeader(data.firstName ?? '')}|${normalizeHeader(data.lastName ?? '')}|${data.dateOfBirth ?? ''}`;
      if (data.firstName && data.lastName) {
        const count = (inFile.get(dupKey) ?? 0) + 1;
        inFile.set(dupKey, count);
        if (count > 1) {
          duplicate = 'in_file';
          issues.push({
            field: 'name',
            code: 'DUP_IN_FILE',
            message: 'Same name + date of birth appears earlier in this file',
          });
        } else if (existingKeys.has(dupKey)) {
          duplicate = 'existing';
          issues.push({
            field: 'name',
            code: 'DUP_EXISTING',
            message: 'A student with this name + date of birth already exists',
          });
        }
      }

      const hard = issues.some((i) =>
        [
          'NAME_REQUIRED',
          'NAME_INCOMPLETE',
          'GENDER_INVALID',
          'DOB_UNPARSEABLE',
          'SECTION_UNMATCHED',
          'DUP_IN_FILE',
        ].includes(i.code),
      );
      return {
        ...row,
        mapped_data: data,
        issues,
        duplicate_status: duplicate,
        validation_status: hard
          ? 'invalid'
          : issues.length > 0
            ? 'warning'
            : 'valid',
      };
    });
    return prepared;
  }

  private async validateOpeningBalances(
    req: TenantRequest,
    rows: StagingRow[],
    mapping: Record<string, string | null>,
  ) {
    const { data: students } = await this.supabase.admin
      .from('students')
      .select('id, student_number')
      .eq('tenant_id', req.tenant.tenantId)
      .limit(10000);
    const byNumber = new Map(
      (students ?? []).map((s) => [
        String(s.student_number).toUpperCase(),
        s.id as string,
      ]),
    );

    // Students that already received an opening balance from a committed job.
    const alreadyImported = new Set<string>();
    const { data: priorJobs } = await this.supabase.admin
      .from('import_jobs')
      .select('id')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('domain', 'opening_balances')
      .in('status', ['committing', 'committed']);
    if (priorJobs && priorJobs.length > 0) {
      const { data: priorRows } = await this.supabase.admin
        .from('import_staging_rows')
        .select('mapped_data')
        .in(
          'import_job_id',
          priorJobs.map((j) => j.id as string),
        )
        .not('final_record_id', 'is', null)
        .limit(20000);
      for (const r of priorRows ?? []) {
        const sid = (r.mapped_data as { studentId?: string } | null)?.studentId;
        if (sid) alreadyImported.add(sid);
      }
    }

    const inFile = new Set<string>();
    return rows.map((row) => {
      const data = this.applyMapping(row.raw_data, mapping);
      const issues: RowIssue[] = [];
      let duplicate: 'none' | 'in_file' | 'existing' = 'none';

      const number = (data.studentNumber ?? '').toUpperCase();
      const studentId = number ? byNumber.get(number) : undefined;
      if (!studentId) {
        issues.push({
          field: 'studentNumber',
          code: 'STUDENT_NOT_FOUND',
          message: `No student "${data.studentNumber ?? ''}"`,
        });
      } else {
        data.studentId = studentId;
        if (inFile.has(studentId)) {
          duplicate = 'in_file';
          issues.push({
            field: 'studentNumber',
            code: 'DUP_IN_FILE',
            message: 'Student appears twice in this file',
          });
        } else if (alreadyImported.has(studentId)) {
          duplicate = 'existing';
          issues.push({
            field: 'studentNumber',
            code: 'ALREADY_IMPORTED',
            message: 'An opening balance was already imported for this student',
          });
        }
        inFile.add(studentId);
      }

      const amount = data.amount ? parseAmount(data.amount) : null;
      if (amount === null || amount <= 0) {
        issues.push({
          field: 'amount',
          code: 'AMOUNT_INVALID',
          message: `Cannot read amount "${data.amount ?? ''}"`,
        });
      } else {
        data.amount = String(amount);
      }

      if (data.asOfDate) {
        const iso = parseDate(data.asOfDate);
        if (iso) data.asOfDate = iso;
        else {
          delete data.asOfDate;
          issues.push({
            field: 'asOfDate',
            code: 'DATE_UNPARSEABLE',
            message: 'As-of date unreadable — today will be used',
          });
        }
      }

      // Money: every anomaly is a hard stop except the as-of-date fallback.
      const hard = issues.some((i) => i.code !== 'DATE_UNPARSEABLE');
      return {
        ...row,
        mapped_data: data,
        issues,
        duplicate_status: duplicate,
        validation_status: hard
          ? 'invalid'
          : issues.length > 0
            ? 'warning'
            : 'valid',
      };
    });
  }
}
