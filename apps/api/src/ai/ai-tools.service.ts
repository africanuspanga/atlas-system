import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import type { TenantContext } from '../tenancy/tenant.guard';
import { CATALOGUE, type ReportKey } from '../reports/reports.controller';
import { AI_ACTIONS, AiActionsService } from './ai-actions.service';

/**
 * The AI's ONLY window into ATLAS data: a fixed, read-only tool catalogue
 * (CTO §9). Every tool re-checks the caller's permission (same
 * role_permissions as the app), scopes strictly by the server-verified
 * tenant context — the model cannot supply a tenantId — and returns source
 * metadata so answers can cite scope, filters and generation time.
 * Financial tools call the SAME ledger-reconciled report_* functions as the
 * reporting module, so AI figures match reports by construction.
 */

export interface AiToolResult {
  status: 'ok' | 'denied' | 'error';
  data?: unknown;
  error?: string;
  rowCount?: number;
  source: string;
}

export interface ToolMeta {
  userId: string;
  conversationId: string | null;
}

interface ToolDef {
  description: string;
  parameters: Record<string, unknown>;
  /** Permission key required, or 'OWNER' for school-owner/director only. */
  permission: string;
  execute: (
    supabase: SupabaseService,
    ctx: TenantContext,
    args: Record<string, string>,
    meta: ToolMeta,
  ) => Promise<{ data: unknown; rowCount?: number }>;
}

const DATE = { type: 'string', description: 'Date as YYYY-MM-DD' };

export const AI_TOOLS: Record<string, ToolDef> = {
  getSchoolOverview: {
    description:
      'Headline numbers for this school: active students (by gender), active staff, class sections, current plan and usage.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'students.view',
    execute: async (supabase, ctx) => {
      const [students, staff, sections] = await Promise.all([
        supabase.admin
          .from('students')
          .select('gender')
          .eq('tenant_id', ctx.tenantId)
          .eq('status', 'active')
          .limit(10000),
        supabase.admin
          .from('tenant_memberships')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId)
          .eq('status', 'active'),
        supabase.admin
          .from('class_sections')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId),
      ]);
      const byGender: Record<string, number> = {};
      for (const s of students.data ?? []) {
        byGender[s.gender as string] = (byGender[s.gender as string] ?? 0) + 1;
      }
      return {
        data: {
          activeStudents: (students.data ?? []).length,
          studentsByGender: byGender,
          activeStaff: staff.count ?? 0,
          classSections: sections.count ?? 0,
          plan: ctx.entitlements.planKey,
          usage: ctx.entitlements.usage,
        },
      };
    },
  },
  getStudentCount: {
    description: 'Number of active students, optionally filtered by gender.',
    parameters: {
      type: 'object',
      properties: {
        gender: { type: 'string', enum: ['male', 'female'] },
      },
      required: [],
    },
    permission: 'students.view',
    execute: async (supabase, ctx, args) => {
      let query = supabase.admin
        .from('students')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', ctx.tenantId)
        .eq('status', 'active');
      if (args.gender === 'male' || args.gender === 'female') {
        query = query.eq('gender', args.gender);
      }
      const { count } = await query;
      return {
        data: { count: count ?? 0, filters: { gender: args.gender ?? 'all' } },
      };
    },
  },
  getAttendanceSummary: {
    description:
      'Attendance between two dates: sessions submitted and record counts by status (present/absent/late/excused), with the attendance rate.',
    parameters: {
      type: 'object',
      properties: { from: DATE, to: DATE },
      required: ['from', 'to'],
    },
    permission: 'attendance.view',
    execute: async (supabase, ctx, args) => {
      const { data: records } = await supabase.admin
        .from('attendance_records')
        .select('status, attendance_sessions!inner(tenant_id, session_date)')
        .eq('attendance_sessions.tenant_id', ctx.tenantId)
        .gte('attendance_sessions.session_date', args.from)
        .lte('attendance_sessions.session_date', args.to)
        .limit(50000);
      const byStatus: Record<string, number> = {};
      for (const r of records ?? []) {
        byStatus[r.status as string] = (byStatus[r.status as string] ?? 0) + 1;
      }
      const total = (records ?? []).length;
      return {
        data: {
          totalRecords: total,
          byStatus,
          attendanceRate:
            total > 0
              ? Math.round(((byStatus.present ?? 0) / total) * 1000) / 10
              : null,
          filters: { from: args.from, to: args.to },
        },
        rowCount: total,
      };
    },
  },
  getAbsentStudents: {
    description:
      'Students marked absent on a given date, with their class (max 50).',
    parameters: {
      type: 'object',
      properties: { date: DATE },
      required: ['date'],
    },
    permission: 'attendance.view',
    execute: async (supabase, ctx, args) => {
      const { data } = await supabase.admin
        .from('attendance_records')
        .select(
          'students(student_number, first_name, last_name), attendance_sessions!inner(tenant_id, session_date, class_sections(name, grade_levels(name)))',
        )
        .eq('attendance_sessions.tenant_id', ctx.tenantId)
        .eq('attendance_sessions.session_date', args.date)
        .eq('status', 'absent')
        .limit(50);
      const rows = (data ?? []).map((r) => {
        const student = r.students as unknown as {
          student_number: string;
          first_name: string;
          last_name: string;
        } | null;
        const session = r.attendance_sessions as unknown as {
          class_sections: {
            name: string;
            grade_levels: { name: string } | null;
          } | null;
        };
        return {
          studentNumber: student?.student_number,
          name: `${student?.first_name ?? ''} ${student?.last_name ?? ''}`.trim(),
          class:
            `${session.class_sections?.grade_levels?.name ?? ''} ${session.class_sections?.name ?? ''}`.trim(),
        };
      });
      return { data: { absent: rows, date: args.date }, rowCount: rows.length };
    },
  },
  getFeeCollectionSummary: {
    description:
      'Money collected between two dates: total and breakdown by payment method. Ledger-reconciled (same numbers as the fee collection report).',
    parameters: {
      type: 'object',
      properties: { from: DATE, to: DATE },
      required: ['from', 'to'],
    },
    permission: 'finance.reports.view',
    execute: async (supabase, ctx, args) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc(
        'report_fee_collection',
        {
          p_tenant_id: ctx.tenantId,
          p_from: args.from,
          p_to: args.to,
        },
      );
      if (error) throw new Error(error.message);
      const payload = data as {
        rows: unknown[];
        totals: Record<string, unknown>;
      };
      return {
        data: {
          totals: payload.totals,
          paymentCount: payload.rows.length,
          filters: { from: args.from, to: args.to },
        },
        rowCount: payload.rows.length,
      };
    },
  },
  getOutstandingFees: {
    description:
      'Unpaid fee balances: school-wide total (reconciled to the ledger) and the top 10 largest balances with student and class.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'finance.reports.view',
    execute: async (supabase, ctx) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc(
        'report_outstanding_balances',
        {
          p_tenant_id: ctx.tenantId,
        },
      );
      if (error) throw new Error(error.message);
      const payload = data as {
        rows: unknown[];
        totals: Record<string, unknown>;
      };
      return {
        data: { totals: payload.totals, top10: payload.rows.slice(0, 10) },
        rowCount: payload.rows.length,
      };
    },
  },
  getTrialBalance: {
    description:
      'Trial balance by ledger account (debits, credits, balance). Always balances or the tool errors.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'finance.reports.view',
    execute: async (supabase, ctx) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('report_trial_balance', {
        p_tenant_id: ctx.tenantId,
      });
      if (error) throw new Error(error.message);
      return { data };
    },
  },
  getAssessmentProgress: {
    description:
      'Assessment/exam progress: how many assessments exist by status (draft/published) and how many marks have been entered.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'students.view',
    execute: async (supabase, ctx) => {
      const [{ data: assessments }, scores] = await Promise.all([
        supabase.admin
          .from('assessments')
          .select('status')
          .eq('tenant_id', ctx.tenantId)
          .limit(1000),
        supabase.admin
          .from('assessment_scores')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId),
      ]);
      const byStatus: Record<string, number> = {};
      for (const a of assessments ?? []) {
        byStatus[a.status as string] = (byStatus[a.status as string] ?? 0) + 1;
      }
      return {
        data: {
          assessmentsByStatus: byStatus,
          marksEntered: scores.count ?? 0,
        },
      };
    },
  },
  getSubscriptionUsage: {
    description:
      "This school's ATLAS plan, subscription status and usage against limits (students, staff, SMS). School owner/director only.",
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'OWNER',
    execute: (_supabase, ctx) =>
      Promise.resolve({
        data: {
          plan: ctx.entitlements.planKey,
          subscriptionStatus: ctx.entitlements.subscriptionStatus,
          trialEndsAt: ctx.entitlements.trialEndsAt,
          limits: ctx.entitlements.limits,
          usage: ctx.entitlements.usage,
        },
      }),
  },
  searchStudents: {
    description:
      'Find students by name or student number (partial match, max 10). Use this to resolve a student before proposing an action.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Name or student number fragment',
        },
      },
      required: ['query'],
    },
    permission: 'students.view',
    execute: async (supabase, ctx, args) => {
      const q = (args.query ?? '').trim().slice(0, 60);
      if (q.length < 2)
        throw new Error('QUERY_TOO_SHORT: give at least 2 characters');
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const { data } = await supabase.admin
        .from('students')
        .select(
          'student_number, first_name, middle_name, last_name, gender, status',
        )
        .eq('tenant_id', ctx.tenantId)
        .or(
          `first_name.ilike.${like},last_name.ilike.${like},student_number.ilike.${like}`,
        )
        .limit(10);
      const rows = (data ?? []).map((s) => ({
        studentNumber: s.student_number as string,
        name: [s.first_name, s.middle_name, s.last_name]
          .filter(Boolean)
          .join(' '),
        gender: s.gender as string,
        status: s.status as string,
      }));
      return { data: { students: rows, query: q }, rowCount: rows.length };
    },
  },
  getStudentProfile: {
    description:
      'One student by student number: bio, class, guardians. (Fee balances live in getStudentInvoices.)',
    parameters: {
      type: 'object',
      properties: { studentNumber: { type: 'string' } },
      required: ['studentNumber'],
    },
    permission: 'students.view',
    execute: async (supabase, ctx, args) => {
      const { data: student } = await supabase.admin
        .from('students')
        .select(
          'id, student_number, first_name, middle_name, last_name, gender, date_of_birth, boarding_status, status, student_guardians(relationship, is_primary, guardians(full_name, phone)), class_enrolments(status, class_sections(name, grade_levels(name)))',
        )
        .eq('tenant_id', ctx.tenantId)
        .eq('student_number', (args.studentNumber ?? '').toUpperCase().trim())
        .maybeSingle();
      if (!student)
        throw new Error(
          `STUDENT_NOT_FOUND: no student ${args.studentNumber ?? ''}`,
        );
      const enrolment = (
        student.class_enrolments as unknown as Array<{
          status: string;
          class_sections: {
            name: string;
            grade_levels: { name: string } | null;
          } | null;
        }>
      ).find((e) => e.status === 'active');
      return {
        data: {
          studentNumber: student.student_number as string,
          name: [student.first_name, student.middle_name, student.last_name]
            .filter(Boolean)
            .join(' '),
          gender: student.gender as string,
          dateOfBirth: student.date_of_birth as string | null,
          boardingStatus: student.boarding_status as string,
          status: student.status as string,
          class: enrolment
            ? `${enrolment.class_sections?.grade_levels?.name ?? ''} ${enrolment.class_sections?.name ?? ''}`.trim()
            : null,
          guardians: (
            student.student_guardians as unknown as Array<{
              relationship: string;
              is_primary: boolean;
              guardians: { full_name: string; phone: string | null } | null;
            }>
          ).map((g) => ({
            name: g.guardians?.full_name,
            phone: g.guardians?.phone,
            relationship: g.relationship,
            isPrimary: g.is_primary,
          })),
        },
      };
    },
  },
  getStudentInvoices: {
    description:
      "One student's invoices with paid amounts and open balances, by student number. Use before proposing a payment.",
    parameters: {
      type: 'object',
      properties: { studentNumber: { type: 'string' } },
      required: ['studentNumber'],
    },
    permission: 'finance.invoices.view',
    execute: async (supabase, ctx, args) => {
      const { data: student } = await supabase.admin
        .from('students')
        .select('id, first_name, last_name, student_number')
        .eq('tenant_id', ctx.tenantId)
        .eq('student_number', (args.studentNumber ?? '').toUpperCase().trim())
        .maybeSingle();
      if (!student)
        throw new Error(
          `STUDENT_NOT_FOUND: no student ${args.studentNumber ?? ''}`,
        );
      const { data: invoices } = await supabase.admin
        .from('invoices')
        .select(
          'id, invoice_number, total, status, issued_on, payments(amount)',
        )
        .eq('tenant_id', ctx.tenantId)
        .eq('student_id', student.id as string)
        .order('issued_on', { ascending: false })
        .limit(20);
      const rows = (invoices ?? []).map((i) => {
        const paid = (
          (i.payments as unknown as Array<{ amount: number }>) ?? []
        ).reduce((s, p) => s + Number(p.amount), 0);
        return {
          invoiceNumber: i.invoice_number as string,
          total: Number(i.total),
          paid,
          balance: Number(i.total) - paid,
          status: i.status as string,
          issuedOn: i.issued_on as string,
        };
      });
      return {
        data: {
          student: `${student.first_name} ${student.last_name} (${student.student_number})`,
          invoices: rows,
          totalOutstanding: rows.reduce((s, r) => s + r.balance, 0),
        },
        rowCount: rows.length,
      };
    },
  },
  generateReport: {
    description:
      'Queue a real downloadable report (PDF/CSV/XLSX) from the reporting module. Figures are calculated and ledger-reconciled by the system, never by you. The file appears on the Reports page within seconds.',
    parameters: {
      type: 'object',
      properties: {
        reportKey: {
          type: 'string',
          enum: [
            'fee_collection',
            'outstanding_balances',
            'trial_balance',
            'student_statement',
            'report_card',
          ],
        },
        format: { type: 'string', enum: ['pdf', 'csv', 'xlsx'] },
        params: {
          type: 'object',
          description:
            'fee_collection: {from,to} dates. student_statement/report_card: {studentId} (+termId for report_card). Others: {}.',
        },
      },
      required: ['reportKey', 'format'],
    },
    permission: 'reports.generate',
    execute: async (supabase, ctx, args, meta) => {
      const def = CATALOGUE[args.reportKey as ReportKey];
      if (!def) throw new Error(`UNKNOWN_REPORT: ${args.reportKey ?? ''}`);
      if (!ctx.isOwner && !ctx.permissions.has(def.permission)) {
        throw new Error(
          `PERMISSION_DENIED: your role cannot generate ${args.reportKey}`,
        );
      }
      if (!(def.formats as readonly string[]).includes(args.format)) {
        throw new Error(
          `FORMAT_UNSUPPORTED: ${args.reportKey} supports ${def.formats.join(', ')}`,
        );
      }
      const params = def.params.safeParse(args.params ?? {});
      if (!params.success) {
        throw new Error(
          `PARAMS_INVALID: ${params.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; ')
            .slice(0, 150)}`,
        );
      }
      const reference = `RPT-${Date.now().toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
      const { data: job, error } = await supabase.admin
        .from('report_jobs')
        .insert({
          tenant_id: ctx.tenantId,
          report_key: args.reportKey,
          format: args.format,
          params: params.data,
          reference,
          requested_by: meta.userId,
        })
        .select('id')
        .single();
      if (error) throw new Error(error.message.slice(0, 200));
      return {
        data: {
          jobId: job.id as string,
          reference,
          status: 'queued',
          note: 'The report is being generated; download it from the Reports page shortly.',
        },
      };
    },
  },
};

/**
 * Proposal tools — one per AI_ACTIONS entry, named propose<ActionName>.
 * Same permission as the action; execution only STORES a proposal that the
 * user must confirm in the UI (see AiActionsService).
 */
export const PROPOSAL_TOOL_PREFIX = 'propose';
export const proposalToolName = (action: string) =>
  `${PROPOSAL_TOOL_PREFIX}${action[0].toUpperCase()}${action.slice(1)}`;
const actionFromToolName = new Map(
  Object.keys(AI_ACTIONS).map((a) => [proposalToolName(a), a]),
);

@Injectable()
export class AiToolsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly actions: AiActionsService,
  ) {}

  /** OpenAI-compatible tool schemas: read tools + proposal tools. */
  toolSchemas() {
    return [
      ...Object.entries(AI_TOOLS).map(([name, def]) => ({
        type: 'function' as const,
        function: {
          name,
          description: def.description,
          parameters: def.parameters,
        },
      })),
      ...Object.entries(AI_ACTIONS).map(([name, def]) => ({
        type: 'function' as const,
        function: {
          name: proposalToolName(name),
          description: def.description,
          parameters: def.parameters,
        },
      })),
    ];
  }

  /**
   * Executes one tool call with permission + tenant enforcement and audits
   * it. Unknown args are ignored; the model can never widen the scope.
   * Proposal tools only STORE a proposal — nothing is written to school data
   * until the user confirms through /ai/actions/:id/confirm.
   */
  async execute(
    ctx: TenantContext,
    userId: string,
    conversationId: string | null,
    toolName: string,
    args: Record<string, string>,
    model: string,
  ): Promise<AiToolResult> {
    const startedAt = Date.now();
    const actionName = actionFromToolName.get(toolName);
    const permission = actionName
      ? AI_ACTIONS[actionName].permission
      : AI_TOOLS[toolName]?.permission;
    let result: AiToolResult;

    if (!permission) {
      result = {
        status: 'error',
        error: `Unknown tool ${toolName}`,
        source: 'none',
      };
    } else {
      const allowed =
        permission === 'OWNER'
          ? ctx.isOwner
          : ctx.isOwner || ctx.permissions.has(permission);
      if (!allowed) {
        result = {
          status: 'denied',
          error: `PERMISSION_DENIED: your role cannot access ${toolName}`,
          source: 'permissions',
        };
      } else {
        try {
          const data = actionName
            ? await this.actions.propose(
                ctx,
                userId,
                conversationId,
                actionName,
                args,
              )
            : undefined;
          const outcome = actionName
            ? { data, rowCount: undefined }
            : await AI_TOOLS[toolName].execute(this.supabase, ctx, args, {
                userId,
                conversationId,
              });
          result = {
            status: 'ok',
            data: outcome.data,
            rowCount: outcome.rowCount,
            source: actionName
              ? `Proposal stored — awaiting user confirmation (${toolName})`
              : `ATLAS records via ${toolName}, tenant-scoped, generated ${new Date().toISOString()}`,
          };
        } catch (err) {
          result = {
            status: 'error',
            error: (err as Error).message.slice(0, 300),
            source: toolName,
          };
        }
      }
    }

    await this.supabase.admin.from('ai_tool_calls').insert({
      tenant_id: ctx.tenantId,
      conversation_id: conversationId,
      user_id: userId,
      role_keys: ctx.roleKeys,
      tool_name: toolName,
      arguments: args,
      status: result.status,
      row_count: result.rowCount ?? null,
      duration_ms: Date.now() - startedAt,
      model,
      error: result.error ?? null,
    });
    return result;
  }
}
