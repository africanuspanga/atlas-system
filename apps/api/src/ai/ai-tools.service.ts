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
 *
 * Platform-level data (platform_* RPCs, cross-tenant aggregates — mig 0013,
 * 0024) is deliberately ABSENT from this catalogue: tenant assistants must
 * never reach data about other schools or the platform itself.
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

/**
 * S4/L1 hardening: fragments interpolated into a PostgREST `.or()` filter
 * must not carry the filter grammar's metacharacters. Strip ilike wildcards
 * (% _) AND the tokens that could split or restructure the expression
 * (, ( ) . " \). Behaviour is unchanged for normal names/numbers/phones.
 */
const sanitizeIlikeFragment = (q: string) => q.replace(/[%_,()."\\]/g, '');

export const AI_TOOLS: Record<string, ToolDef> = {
  getSchoolOverview: {
    description:
      'Headline numbers for this school: active students (by gender), active staff, class sections, current plan and usage.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'students.view',
    execute: async (supabase, ctx) => {
      // Exact head counts — never fetch student rows and tally in JS (the
      // Supabase 1000-row cap would silently truncate large schools).
      const [activeStudents, maleStudents, femaleStudents, staff, sections] =
        await Promise.all([
          supabase.admin
            .from('students')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', ctx.tenantId)
            .eq('status', 'active'),
          supabase.admin
            .from('students')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', ctx.tenantId)
            .eq('status', 'active')
            .eq('gender', 'male'),
          supabase.admin
            .from('students')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', ctx.tenantId)
            .eq('status', 'active')
            .eq('gender', 'female'),
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
      if (activeStudents.error)
        throw new Error(activeStudents.error.message.slice(0, 200));
      if (maleStudents.error)
        throw new Error(maleStudents.error.message.slice(0, 200));
      if (femaleStudents.error)
        throw new Error(femaleStudents.error.message.slice(0, 200));
      if (staff.error) throw new Error(staff.error.message.slice(0, 200));
      if (sections.error) throw new Error(sections.error.message.slice(0, 200));
      return {
        data: {
          activeStudents: activeStudents.count ?? 0,
          studentsByGender: {
            male: maleStudents.count ?? 0,
            female: femaleStudents.count ?? 0,
          },
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
      const { count, error } = await query;
      if (error) throw new Error(error.message.slice(0, 200));
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
      // Exact head counts per status — never fetch records and tally in JS
      // (the Supabase 1000-row cap would silently truncate large date ranges).
      const STATUSES = ['present', 'absent', 'late', 'excused'] as const;
      const results = await Promise.all(
        STATUSES.map((s) =>
          supabase.admin
            .from('attendance_records')
            .select('id, attendance_sessions!inner(tenant_id, session_date)', {
              count: 'exact',
              head: true,
            })
            .eq('attendance_sessions.tenant_id', ctx.tenantId)
            .gte('attendance_sessions.session_date', args.from)
            .lte('attendance_sessions.session_date', args.to)
            .eq('status', s),
        ),
      );
      const byStatus: Record<string, number> = {};
      results.forEach((res, i) => {
        if (res.error) throw new Error(res.error.message.slice(0, 200));
        byStatus[STATUSES[i]] = res.count ?? 0;
      });
      const total = STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
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
      const { data, error } = await supabase.admin
        .from('attendance_records')
        .select(
          'students(student_number, first_name, last_name), attendance_sessions!inner(tenant_id, session_date, class_sections(name, grade_levels(name)))',
        )
        .eq('attendance_sessions.tenant_id', ctx.tenantId)
        .eq('attendance_sessions.session_date', args.date)
        .eq('status', 'absent')
        .limit(50);
      if (error) throw new Error(error.message.slice(0, 200));
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
  getDebtors: {
    description:
      'Debtors (wadaiwa) as of today: students with unpaid invoices, their class, guardian phone, balance and overdue amount (instalment-aware). Ledger-reconciled; optionally filter to one class. Returns the top overdue rows plus totals.',
    parameters: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Limit to one class, e.g. "Form 1 A" (optional)',
        },
      },
      required: [],
    },
    permission: 'finance.debtors.view',
    execute: async (supabase, ctx, args) => {
      const asOf = new Date().toISOString().slice(0, 10);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('report_debtors', {
        p_tenant_id: ctx.tenantId,
        p_as_of: asOf,
      });
      if (error) throw new Error(error.message);
      const payload = data as {
        rows: Array<{
          studentNumber: string;
          studentName: string;
          className: string;
          guardianPhone: string | null;
          invoiceNumber: string;
          total: number;
          paid: number;
          balance: number;
          overdue: number;
        }>;
        totals: Record<string, unknown>;
      };
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const rows = args.className
        ? payload.rows.filter((r) => norm(r.className) === norm(args.className))
        : payload.rows;
      const top = [...rows]
        .sort((a, b) => Number(b.overdue) - Number(a.overdue))
        .slice(0, 10);
      return {
        data: {
          totals: args.className
            ? {
                outstanding: rows.reduce(
                  (sum, r) => sum + Number(r.balance),
                  0,
                ),
                overdue: rows.reduce((sum, r) => sum + Number(r.overdue), 0),
              }
            : payload.totals,
          topOverdue: top,
          filters: { asOf, className: args.className ?? 'all' },
        },
        rowCount: rows.length,
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
      const [assessments, scores] = await Promise.all([
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
      if (assessments.error)
        throw new Error(assessments.error.message.slice(0, 200));
      if (scores.error) throw new Error(scores.error.message.slice(0, 200));
      const byStatus: Record<string, number> = {};
      for (const a of assessments.data ?? []) {
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
  getCaSummary: {
    description:
      'Cumulative Continuous Assessment (CA) summary for one class section: per-student weighted subject averages across ALL published assessments in the academic year, with overall average and rank. Figures come from the report RPC — never compute them yourself.',
    parameters: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Grade + stream, e.g. "Form 5 A"',
        },
        year: {
          type: 'string',
          description:
            'Academic year name, e.g. "2027" (optional — defaults to the active year)',
        },
      },
      required: ['className'],
    },
    permission: 'students.view',
    execute: async (supabase, ctx, args) => {
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const wanted = norm(args.className ?? '');
      if (wanted.length < 2) {
        throw new Error('SECTION_NAME_REQUIRED: give a class like "Form 5 A"');
      }
      const sectionsRes = await supabase.admin
        .from('class_sections')
        .select('id, name, grade_levels(name)')
        .eq('tenant_id', ctx.tenantId)
        .limit(200);
      if (sectionsRes.error)
        throw new Error(sectionsRes.error.message.slice(0, 200));
      const section = (sectionsRes.data ?? []).find((s) => {
        const grade =
          (s.grade_levels as unknown as { name: string } | null)?.name ?? '';
        return norm(`${grade} ${s.name as string}`) === wanted;
      });
      if (!section) {
        throw new Error(
          `SECTION_NOT_FOUND: no class "${args.className ?? ''}" in this school`,
        );
      }

      let yearQuery = supabase.admin
        .from('academic_years')
        .select('id, name')
        .eq('tenant_id', ctx.tenantId);
      yearQuery = args.year
        ? yearQuery.eq('name', args.year.trim())
        : yearQuery
            .eq('status', 'active')
            .order('starts_on', { ascending: false });
      const yearsRes = await yearQuery.limit(1);
      if (yearsRes.error) throw new Error(yearsRes.error.message.slice(0, 200));
      const year = (yearsRes.data ?? [])[0];
      if (!year) {
        throw new Error(
          `YEAR_NOT_FOUND: no ${args.year ? `academic year "${args.year}"` : 'active academic year'}`,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('report_ca_summary', {
        p_tenant_id: ctx.tenantId,
        p_section_id: section.id as string,
        p_year_id: year.id as string,
      });
      if (error) throw new Error(error.message.slice(0, 200));
      const payload = data as {
        section: string;
        educationLevel: string;
        year: { name: string };
        rows: unknown[];
        students: number;
      };
      return {
        data: {
          section: payload.section,
          educationLevel: payload.educationLevel,
          year: payload.year.name,
          students: payload.students,
          topRows: payload.rows.slice(0, 15),
        },
        rowCount: payload.rows.length,
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
      const like = `%${sanitizeIlikeFragment(q)}%`;
      const { data, error } = await supabase.admin
        .from('students')
        .select(
          'student_number, first_name, middle_name, last_name, gender, status',
        )
        .eq('tenant_id', ctx.tenantId)
        .or(
          `first_name.ilike.${like},last_name.ilike.${like},student_number.ilike.${like}`,
        )
        .limit(10);
      if (error) throw new Error(error.message.slice(0, 200));
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
  getAcademicsSetup: {
    description:
      'Academic structure of the school: subjects (with Swahili names), class sections with grade levels, and academic years with their terms.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'students.view',
    execute: async (supabase, ctx) => {
      const [subjects, sections, years] = await Promise.all([
        supabase.admin
          .from('subjects')
          .select('code, name, name_sw, education_level, status')
          .eq('tenant_id', ctx.tenantId)
          .order('code')
          .limit(100),
        supabase.admin
          .from('class_sections')
          .select('name, capacity, grade_levels(name)')
          .eq('tenant_id', ctx.tenantId)
          .limit(100),
        supabase.admin
          .from('academic_years')
          .select('name, academic_terms(name, starts_on, ends_on)')
          .eq('tenant_id', ctx.tenantId)
          .limit(10),
      ]);
      if (subjects.error) throw new Error(subjects.error.message.slice(0, 200));
      if (sections.error) throw new Error(sections.error.message.slice(0, 200));
      if (years.error) throw new Error(years.error.message.slice(0, 200));
      const sectionRows = (sections.data ?? []).map((s) => ({
        section:
          `${(s.grade_levels as unknown as { name: string } | null)?.name ?? ''} ${s.name as string}`.trim(),
        capacity: s.capacity as number | null,
      }));
      return {
        data: {
          subjects: subjects.data ?? [],
          classSections: sectionRows,
          academicYears: years.data ?? [],
        },
        rowCount: (subjects.data ?? []).length + sectionRows.length,
      };
    },
  },
  searchGuardians: {
    description:
      'Find parents/guardians by name or phone (partial match, max 10), with their linked students.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or phone fragment' },
      },
      required: ['query'],
    },
    permission: 'guardians.view',
    execute: async (supabase, ctx, args) => {
      const q = (args.query ?? '').trim().slice(0, 60);
      if (q.length < 2)
        throw new Error('QUERY_TOO_SHORT: give at least 2 characters');
      const like = `%${sanitizeIlikeFragment(q)}%`;
      const { data, error } = await supabase.admin
        .from('guardians')
        .select(
          'full_name, phone, email, student_guardians(relationship, students(student_number, first_name, last_name))',
        )
        .eq('tenant_id', ctx.tenantId)
        .or(`full_name.ilike.${like},phone.ilike.${like}`)
        .limit(10);
      if (error) throw new Error(error.message.slice(0, 200));
      const rows = (data ?? []).map((g) => ({
        name: g.full_name as string,
        phone: g.phone as string | null,
        email: g.email as string | null,
        students: (
          g.student_guardians as unknown as Array<{
            relationship: string;
            students: {
              student_number: string;
              first_name: string;
              last_name: string;
            } | null;
          }>
        ).map((sg) => ({
          studentNumber: sg.students?.student_number,
          name: `${sg.students?.first_name ?? ''} ${sg.students?.last_name ?? ''}`.trim(),
          relationship: sg.relationship,
        })),
      }));
      return { data: { guardians: rows, query: q }, rowCount: rows.length };
    },
  },
  getRecentAdmissions: {
    description:
      'Most recently admitted students (newest first) plus the total active enrolment count. Use for admissions/enrolment questions.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'string',
          description: 'How many recent students to list (default 10, max 25)',
        },
      },
      required: [],
    },
    permission: 'students.view',
    execute: async (supabase, ctx, args) => {
      const limit = Math.min(
        Math.max(Number.parseInt(args.limit ?? '10', 10) || 10, 1),
        25,
      );
      const [recent, total] = await Promise.all([
        supabase.admin
          .from('students')
          .select('student_number, first_name, last_name, created_at, status')
          .eq('tenant_id', ctx.tenantId)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase.admin
          .from('students')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId)
          .eq('status', 'active'),
      ]);
      if (recent.error) throw new Error(recent.error.message.slice(0, 200));
      if (total.error) throw new Error(total.error.message.slice(0, 200));
      const rows = (recent.data ?? []).map((s) => ({
        studentNumber: s.student_number as string,
        name: `${s.first_name as string} ${s.last_name as string}`,
        admittedOn: (s.created_at as string).slice(0, 10),
        status: s.status as string,
      }));
      return {
        data: { totalActiveStudents: total.count ?? 0, recentAdmissions: rows },
        rowCount: rows.length,
      };
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
      const { data: student, error } = await supabase.admin
        .from('students')
        .select(
          'id, student_number, first_name, middle_name, last_name, gender, date_of_birth, boarding_status, status, student_guardians(relationship, is_primary, guardians(full_name, phone)), class_enrolments(status, class_sections(name, grade_levels(name)))',
        )
        .eq('tenant_id', ctx.tenantId)
        .eq('student_number', (args.studentNumber ?? '').toUpperCase().trim())
        .maybeSingle();
      if (error) throw new Error(error.message.slice(0, 200));
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
      const { data: student, error: studentError } = await supabase.admin
        .from('students')
        .select('id, first_name, last_name, student_number')
        .eq('tenant_id', ctx.tenantId)
        .eq('student_number', (args.studentNumber ?? '').toUpperCase().trim())
        .maybeSingle();
      // Check the DB error BEFORE the null-check so a query failure can't
      // masquerade as STUDENT_NOT_FOUND.
      if (studentError) throw new Error(studentError.message.slice(0, 200));
      if (!student)
        throw new Error(
          `STUDENT_NOT_FOUND: no student ${args.studentNumber ?? ''}`,
        );
      const { data: invoices, error: invoicesError } = await supabase.admin
        .from('invoices')
        .select(
          'id, invoice_number, total, status, issued_on, payments(amount)',
        )
        .eq('tenant_id', ctx.tenantId)
        .eq('student_id', student.id as string)
        .order('issued_on', { ascending: false })
        .limit(20);
      if (invoicesError) throw new Error(invoicesError.message.slice(0, 200));
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
      // Headline outstanding total comes from the ledger-reconciled statement
      // RPC — never a JS reduce over the (capped, most-recent-20) invoice list.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data: statement, error: statementError } =
        await supabase.admin.rpc('report_student_statement', {
          p_tenant_id: ctx.tenantId,
          p_student_id: student.id as string,
        });
      if (statementError) throw new Error(statementError.message.slice(0, 200));
      const totals = (statement as { totals: { closingBalance: number } })
        .totals;
      return {
        data: {
          student: `${student.first_name} ${student.last_name} (${student.student_number})`,
          invoices: rows,
          invoicesNote: 'most recent 20 invoices only — not the full list',
          totalOutstanding: Number(totals.closingBalance),
        },
        rowCount: rows.length,
      };
    },
  },
  getTimetable: {
    description:
      'Weekly timetable grid for one class section (e.g. "Form 1 A"): rows are periods, columns Monday–Friday with subject and teacher. Optionally filter to one day (1=Monday … 5=Friday).',
    parameters: {
      type: 'object',
      properties: {
        sectionName: {
          type: 'string',
          description: 'Grade + stream, e.g. "Form 1 A" or "Darasa la 5 B"',
        },
        day: {
          type: 'string',
          enum: ['1', '2', '3', '4', '5'],
          description: 'Optional weekday filter: 1=Monday … 5=Friday',
        },
      },
      required: ['sectionName'],
    },
    permission: 'timetable.view',
    execute: async (supabase, ctx, args) => {
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const wanted = norm(args.sectionName ?? '');
      if (wanted.length < 2) {
        throw new Error('SECTION_NAME_REQUIRED: give a class like "Form 1 A"');
      }
      const sectionsRes = await supabase.admin
        .from('class_sections')
        .select('id, name, grade_levels(name)')
        .eq('tenant_id', ctx.tenantId)
        .limit(200);
      if (sectionsRes.error)
        throw new Error(sectionsRes.error.message.slice(0, 200));
      const section = (sectionsRes.data ?? []).find((s) => {
        const grade =
          (s.grade_levels as unknown as { name: string } | null)?.name ?? '';
        return norm(`${grade} ${s.name as string}`) === wanted;
      });
      if (!section) {
        throw new Error(
          `SECTION_NOT_FOUND: no class "${args.sectionName ?? ''}" in this school`,
        );
      }
      const grade =
        (section.grade_levels as unknown as { name: string } | null)?.name ??
        '';
      const day =
        args.day && /^[1-5]$/.test(args.day)
          ? Number.parseInt(args.day, 10)
          : null;

      const [periodsRes, slotsRes] = await Promise.all([
        supabase.admin
          .from('timetable_periods')
          .select('id, label, starts_at, ends_at, is_break')
          .eq('tenant_id', ctx.tenantId)
          .order('sort_order')
          .order('starts_at'),
        supabase.admin
          .from('timetable_slots')
          .select(
            'day_of_week, period_id, subjects(code, name), profiles(full_name)',
          )
          .eq('tenant_id', ctx.tenantId)
          .eq('class_section_id', section.id as string)
          .limit(500),
      ]);
      if (periodsRes.error)
        throw new Error(periodsRes.error.message.slice(0, 200));
      if (slotsRes.error) throw new Error(slotsRes.error.message.slice(0, 200));
      const periods = periodsRes.data;
      const slots = slotsRes.data;
      const DAY_NAMES = [
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
      ];
      const days = day ? [day] : [1, 2, 3, 4, 5];
      const rows = (periods ?? []).map((p) => {
        const row: Record<string, unknown> = {
          period: p.label as string,
          time: `${(p.starts_at as string).slice(0, 5)}-${(p.ends_at as string).slice(0, 5)}`,
        };
        if (p.is_break) {
          row.break = true;
          return row;
        }
        for (const d of days) {
          const slot = (slots ?? []).find(
            (s) => s.day_of_week === d && s.period_id === p.id,
          );
          const subject = slot?.subjects as unknown as {
            code: string;
            name: string;
          } | null;
          const teacher = slot?.profiles as unknown as {
            full_name: string;
          } | null;
          row[DAY_NAMES[d - 1]] = slot
            ? `${subject?.name ?? ''} (${teacher?.full_name ?? ''})`.trim()
            : null;
        }
        return row;
      });
      return {
        data: {
          section: `${grade} ${section.name as string}`.trim(),
          days: days.map((d) => DAY_NAMES[d - 1]),
          rows,
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
  getHostelOccupancy: {
    description:
      'Hostel (bweni) occupancy: every hostel with its gender, rooms, bed capacity, occupied beds and free beds, plus school-wide totals.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'hostel.view',
    execute: async (supabase, ctx) => {
      const [hostelsRes, occupancyRes] = await Promise.all([
        supabase.admin
          .from('hostels')
          .select('id, name, gender, hostel_rooms(id, name, capacity)')
          .eq('tenant_id', ctx.tenantId)
          .order('name')
          .limit(200),
        // Exact per-room occupancy from the SQL aggregate RPC — never count
        // fetched allocation rows in JS (Supabase caps reads at 1000).
        supabase.admin.rpc('hostel_occupancy', { p_tenant_id: ctx.tenantId }),
      ]);
      if (hostelsRes.error)
        throw new Error(hostelsRes.error.message.slice(0, 200));
      if (occupancyRes.error)
        throw new Error(occupancyRes.error.message.slice(0, 200));
      const hostels = hostelsRes.data;
      const occupiedByRoom = new Map<string, number>();
      for (const a of (occupancyRes.data ?? []) as Array<{
        room_id: string;
        occupied: number;
      }>) {
        occupiedByRoom.set(a.room_id, Number(a.occupied));
      }
      let totalCapacity = 0;
      let totalOccupied = 0;
      const rows = (hostels ?? []).map((h) => {
        const rooms = (
          h.hostel_rooms as unknown as Array<{
            id: string;
            name: string;
            capacity: number;
          }>
        ).map((r) => {
          const occupied = occupiedByRoom.get(r.id) ?? 0;
          totalCapacity += r.capacity;
          totalOccupied += occupied;
          return {
            room: r.name,
            capacity: r.capacity,
            occupied,
            free: r.capacity - occupied,
          };
        });
        return {
          hostel: h.name as string,
          gender: h.gender as string,
          rooms,
          capacity: rooms.reduce((s, r) => s + r.capacity, 0),
          occupied: rooms.reduce((s, r) => s + r.occupied, 0),
        };
      });
      return {
        data: {
          hostels: rows,
          totals: {
            capacity: totalCapacity,
            occupied: totalOccupied,
            free: totalCapacity - totalOccupied,
          },
        },
        rowCount: rows.length,
      };
    },
  },
  getTransportRoutes: {
    description:
      'School transport (usafiri) routes: each route with its fee, ordered stops and the number of actively assigned students. Fees are informational — invoicing happens in the finance module.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'transport.view',
    execute: async (supabase, ctx) => {
      const [routesRes, loadRes] = await Promise.all([
        supabase.admin
          .from('transport_routes')
          .select('id, name, fee_amount, transport_stops(name, sort_order)')
          .eq('tenant_id', ctx.tenantId)
          .order('name')
          .limit(200),
        // Exact per-route assigned counts from the SQL aggregate RPC — never
        // count fetched assignment rows in JS (Supabase caps reads at 1000).
        supabase.admin.rpc('transport_route_load', {
          p_tenant_id: ctx.tenantId,
        }),
      ]);
      if (routesRes.error)
        throw new Error(routesRes.error.message.slice(0, 200));
      if (loadRes.error) throw new Error(loadRes.error.message.slice(0, 200));
      const routes = routesRes.data;
      const countByRoute = new Map<string, number>();
      for (const a of (loadRes.data ?? []) as Array<{
        route_id: string;
        assigned: number;
      }>) {
        countByRoute.set(a.route_id, Number(a.assigned));
      }
      const rows = (routes ?? []).map((r) => ({
        route: r.name as string,
        feeAmount: Number(r.fee_amount),
        stops: (
          r.transport_stops as unknown as Array<{
            name: string;
            sort_order: number;
          }>
        )
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((s) => s.name),
        assignedStudents: countByRoute.get(r.id as string) ?? 0,
      }));
      return { data: { routes: rows }, rowCount: rows.length };
    },
  },
  getLibraryOverdue: {
    description:
      'Overdue library (maktaba) loans: every active loan past its due date, with the book, the student, their class and how many days late.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'library.view',
    execute: async (supabase, ctx) => {
      const today = new Date().toISOString().slice(0, 10);
      const { data: loans, error } = await supabase.admin
        .from('library_loans')
        .select(
          `id, loaned_on, due_on, library_books(code, title),
           students(student_number, first_name, last_name,
                    class_enrolments(status, class_sections(name, grade_levels(name))))`,
        )
        .eq('tenant_id', ctx.tenantId)
        .is('returned_on', null)
        .lt('due_on', today)
        .order('due_on')
        .limit(500);
      if (error) throw new Error(error.message.slice(0, 200));
      const msPerDay = 24 * 60 * 60 * 1000;
      const rows = (loans ?? []).map((l) => {
        const book = l.library_books as unknown as {
          code: string;
          title: string;
        } | null;
        const student = l.students as unknown as {
          student_number: string;
          first_name: string;
          last_name: string;
          class_enrolments: Array<{
            status: string;
            class_sections: {
              name: string;
              grade_levels: { name: string } | null;
            } | null;
          }>;
        } | null;
        const enrolment = (student?.class_enrolments ?? []).find(
          (e) => e.status === 'active',
        );
        return {
          book: `${book?.title ?? ''} (${book?.code ?? ''})`,
          student: `${student?.first_name ?? ''} ${student?.last_name ?? ''} (${student?.student_number ?? ''})`,
          className: enrolment?.class_sections
            ? `${enrolment.class_sections.grade_levels?.name ?? ''} ${enrolment.class_sections.name}`.trim()
            : null,
          dueOn: l.due_on as string,
          daysLate: Math.max(
            0,
            Math.floor(
              (Date.parse(today) - Date.parse(l.due_on as string)) / msPerDay,
            ),
          ),
        };
      });
      return { data: { overdueLoans: rows }, rowCount: rows.length };
    },
  },
  getInventoryStock: {
    description:
      'Inventory (vifaa) stock levels: every store item with its unit, current stock (sum of in minus out movements), reorder level and a low-stock flag.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'inventory.view',
    execute: async (supabase, ctx) => {
      const [itemsRes, stockRes] = await Promise.all([
        supabase.admin
          .from('inventory_items')
          .select('id, name, unit, reorder_level')
          .eq('tenant_id', ctx.tenantId)
          .order('name')
          .limit(1000),
        // Exact per-item stock from the SQL aggregate RPC — never sum fetched
        // movement rows in JS (Supabase caps reads at 1000).
        supabase.admin.rpc('inventory_stock_levels', {
          p_tenant_id: ctx.tenantId,
        }),
      ]);
      if (itemsRes.error) throw new Error(itemsRes.error.message.slice(0, 200));
      if (stockRes.error) throw new Error(stockRes.error.message.slice(0, 200));
      const items = itemsRes.data;
      const stockByItem = new Map<string, number>();
      for (const s of (stockRes.data ?? []) as Array<{
        item_id: string;
        stock: number;
      }>) {
        stockByItem.set(s.item_id, Number(s.stock));
      }
      const rows = (items ?? []).map((i) => {
        const stock = stockByItem.get(i.id as string) ?? 0;
        return {
          item: i.name as string,
          unit: i.unit as string,
          stock,
          reorderLevel: i.reorder_level as number,
          lowStock: stock <= (i.reorder_level as number),
        };
      });
      return {
        data: {
          items: rows,
          lowStockItems: rows.filter((r) => r.lowStock).map((r) => r.item),
        },
        rowCount: rows.length,
      };
    },
  },
  getClinicVisits: {
    description:
      'Clinic (zahanati) visits between two dates: each visit with the student, symptoms, treatment and whether the guardian was notified by SMS.',
    parameters: {
      type: 'object',
      properties: { from: DATE, to: DATE },
      required: ['from', 'to'],
    },
    permission: 'clinic.view',
    execute: async (supabase, ctx, args) => {
      const { data: visits, error } = await supabase.admin
        .from('clinic_visits')
        .select(
          `id, visited_at, symptoms, treatment, notify_guardian,
           students(student_number, first_name, last_name)`,
        )
        .eq('tenant_id', ctx.tenantId)
        .gte('visited_at', `${args.from}T00:00:00Z`)
        .lte('visited_at', `${args.to}T23:59:59.999Z`)
        .order('visited_at', { ascending: false })
        .limit(500);
      if (error) throw new Error(error.message.slice(0, 200));
      const rows = (visits ?? []).map((v) => {
        const student = v.students as unknown as {
          student_number: string;
          first_name: string;
          last_name: string;
        } | null;
        return {
          date: (v.visited_at as string).slice(0, 10),
          student: `${student?.first_name ?? ''} ${student?.last_name ?? ''} (${student?.student_number ?? ''})`,
          symptoms: v.symptoms as string,
          treatment: (v.treatment as string | null) ?? null,
          guardianNotified: v.notify_guardian as boolean,
        };
      });
      return {
        data: { visits: rows, filters: { from: args.from, to: args.to } },
        rowCount: rows.length,
      };
    },
  },
  getPayrollSummary: {
    description:
      'Latest payroll run (mishahara): period, status, employee count and TOTAL gross/PAYE/NSSF/HESLB/net. Aggregates only — individual salaries are never exposed.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'payroll.view',
    execute: async (supabase, ctx) => {
      // Privacy: this tool deliberately returns run-level AGGREGATES only.
      // Per-person salaries are highly sensitive and stay behind the payroll
      // API (payroll.view), never inside AI conversation transcripts.
      const { data: runs, error } = await supabase.admin
        .from('payroll_runs')
        .select(
          'period, status, posted_at, payroll_items(gross, paye, nssf_employee, heslb, net)',
        )
        .eq('tenant_id', ctx.tenantId)
        .order('period', { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message.slice(0, 200));
      const run = (runs ?? [])[0] as
        | {
            period: string;
            status: string;
            posted_at: string | null;
            payroll_items: Array<{
              gross: number;
              paye: number;
              nssf_employee: number;
              heslb: number;
              net: number;
            }>;
          }
        | undefined;
      if (!run) {
        return { data: { latestRun: null }, rowCount: 0 };
      }
      const items = run.payroll_items ?? [];
      const sum = (pick: (i: (typeof items)[number]) => number) =>
        items.reduce((s, i) => s + Number(pick(i)), 0);
      return {
        data: {
          latestRun: {
            period: run.period,
            status: run.status,
            postedAt: run.posted_at,
            employees: items.length,
            totalGross: sum((i) => i.gross),
            totalPaye: sum((i) => i.paye),
            totalNssf: sum((i) => i.nssf_employee),
            totalHeslb: sum((i) => i.heslb),
            totalNet: sum((i) => i.net),
          },
        },
        rowCount: items.length,
      };
    },
  },
  getImportJobs: {
    description:
      'Recent Excel data-import jobs (uingizaji wa data): domain (students / opening balances), status and row counts — valid, warnings, invalid, duplicates, committed, failed. Use for "did the import work / how many rows failed?" questions.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'string',
          description: 'How many recent jobs to list (default 10, max 25)',
        },
      },
      required: [],
    },
    permission: 'imports.manage',
    execute: async (supabase, ctx, args) => {
      const limit = Math.min(
        Math.max(Number.parseInt(args.limit ?? '10', 10) || 10, 1),
        25,
      );
      const { data, error } = await supabase.admin
        .from('import_jobs')
        .select(
          'domain, status, original_filename, row_count, valid_rows, warning_rows, invalid_rows, duplicate_rows, committed_rows, failed_rows, created_at, committed_at',
        )
        .eq('tenant_id', ctx.tenantId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message.slice(0, 200));
      const rows = (data ?? []).map((j) => ({
        file: j.original_filename as string,
        domain: j.domain as string,
        status: j.status as string,
        rows: j.row_count as number,
        valid: j.valid_rows as number,
        warnings: j.warning_rows as number,
        invalid: j.invalid_rows as number,
        duplicates: j.duplicate_rows as number,
        committed: j.committed_rows as number,
        failed: j.failed_rows as number,
        uploadedOn: (j.created_at as string).slice(0, 10),
        committedOn: j.committed_at
          ? (j.committed_at as string).slice(0, 10)
          : null,
      }));
      return { data: { importJobs: rows }, rowCount: rows.length };
    },
  },
  getRecentAnnouncements: {
    description:
      'Recent SMS announcements (matangazo) with audience, message, recipient count and delivery stats from the SMS outbox (sent / failed / pending). Use for "what did we send, did it deliver?" questions.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'string',
          description:
            'How many recent announcements to list (default 5, max 10)',
        },
      },
      required: [],
    },
    permission: 'communication.send',
    execute: async (supabase, ctx, args) => {
      const limit = Math.min(
        Math.max(Number.parseInt(args.limit ?? '5', 10) || 5, 1),
        10,
      );
      const { data: announcements, error } = await supabase.admin
        .from('announcements')
        .select(
          'id, audience_type, body, recipient_count, created_at, class_sections(name, grade_levels(name))',
        )
        .eq('tenant_id', ctx.tenantId)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message.slice(0, 200));
      // Exact per-announcement delivery counts via head counts — never tally
      // fetched outbox rows in JS (the Supabase 1000-row cap would silently
      // truncate whole-school announcements).
      const STATUSES = ['sent', 'failed', 'pending'] as const;
      const rows = await Promise.all(
        (announcements ?? []).map(async (a) => {
          const counts = await Promise.all(
            STATUSES.map((s) =>
              supabase.admin
                .from('notification_outbox')
                .select('id', { count: 'exact', head: true })
                .eq('tenant_id', ctx.tenantId)
                .eq('template', 'announcement')
                .eq('payload->>announcementId', a.id as string)
                .eq('status', s),
            ),
          );
          const delivery: Record<string, number> = {};
          counts.forEach((res, i) => {
            if (res.error) throw new Error(res.error.message.slice(0, 200));
            delivery[STATUSES[i]] = res.count ?? 0;
          });
          const section = a.class_sections as unknown as {
            name: string;
            grade_levels: { name: string } | null;
          } | null;
          return {
            sentOn: (a.created_at as string).slice(0, 10),
            audience:
              a.audience_type === 'class_section'
                ? `Guardians of ${section?.grade_levels?.name ?? ''} ${section?.name ?? ''}`.trim()
                : 'All guardians (whole school)',
            message: a.body as string,
            recipients: a.recipient_count as number,
            delivery,
          };
        }),
      );
      return { data: { announcements: rows }, rowCount: rows.length };
    },
  },
  searchStaff: {
    description:
      'Find or list staff members (walimu na wafanyakazi) by name or role key (e.g. teacher, bursar), with their roles and join date. NO salary data — payroll figures are aggregates via getPayrollSummary only. Use to resolve a staff member before proposing a timetable slot or an invite.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Name or role fragment, e.g. "Asha" or "bursar" (optional — omit to list all staff)',
        },
      },
      required: [],
    },
    permission: 'members.manage',
    execute: async (supabase, ctx, args) => {
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
      const q = norm((args.query ?? '').slice(0, 60));
      // Staff counts are plan-capped far below the Supabase 1000-row read
      // cap; same fetch-then-match pattern as the timetable teacher lookup.
      const { data, error } = await supabase.admin
        .from('tenant_memberships')
        .select(
          'created_at, profiles(full_name), membership_roles(roles(key, name))',
        )
        .eq('tenant_id', ctx.tenantId)
        .eq('status', 'active')
        .limit(1000);
      if (error) throw new Error(error.message.slice(0, 200));
      const rows = (data ?? [])
        .map((m) => {
          const profile = m.profiles as unknown as {
            full_name: string;
          } | null;
          const roles = (
            m.membership_roles as unknown as Array<{
              roles: { key: string; name: string } | null;
            }>
          )
            .map((r) => r.roles?.key ?? '')
            .filter(Boolean);
          return {
            name: profile?.full_name ?? '',
            roles,
            joinedOn: (m.created_at as string).slice(0, 10),
          };
        })
        .filter(
          (r) =>
            q.length === 0 ||
            norm(r.name).includes(q) ||
            r.roles.some((role) => norm(role).includes(q)),
        )
        .slice(0, 25);
      return {
        data: { staff: rows, query: q.length > 0 ? q : 'all' },
        rowCount: rows.length,
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
