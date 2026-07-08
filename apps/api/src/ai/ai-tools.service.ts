import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import type { TenantContext } from '../tenancy/tenant.guard';

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

interface ToolDef {
  description: string;
  parameters: Record<string, unknown>;
  /** Permission key required, or 'OWNER' for school-owner/director only. */
  permission: string;
  execute: (
    supabase: SupabaseService,
    ctx: TenantContext,
    args: Record<string, string>,
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
};

@Injectable()
export class AiToolsService {
  constructor(private readonly supabase: SupabaseService) {}

  /** OpenAI-compatible tool schema for the provider call. */
  toolSchemas() {
    return Object.entries(AI_TOOLS).map(([name, def]) => ({
      type: 'function' as const,
      function: {
        name,
        description: def.description,
        parameters: def.parameters,
      },
    }));
  }

  /**
   * Executes one tool call with permission + tenant enforcement and audits
   * it. Unknown args are ignored; the model can never widen the scope.
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
    const def = AI_TOOLS[toolName];
    let result: AiToolResult;

    if (!def) {
      result = {
        status: 'error',
        error: `Unknown tool ${toolName}`,
        source: 'none',
      };
    } else {
      const allowed =
        def.permission === 'OWNER'
          ? ctx.isOwner
          : ctx.isOwner || ctx.permissions.has(def.permission);
      if (!allowed) {
        result = {
          status: 'denied',
          error: `PERMISSION_DENIED: your role cannot access ${toolName}`,
          source: 'permissions',
        };
      } else {
        try {
          const { data, rowCount } = await def.execute(
            this.supabase,
            ctx,
            args,
          );
          result = {
            status: 'ok',
            data,
            rowCount,
            source: `ATLAS records via ${toolName}, tenant-scoped, generated ${new Date().toISOString()}`,
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
