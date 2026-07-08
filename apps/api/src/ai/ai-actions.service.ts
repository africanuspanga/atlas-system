import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SupabaseService } from '../supabase/supabase.service';
import type { TenantContext } from '../tenancy/tenant.guard';
import { resolveWebOrigin } from '../config';

/**
 * AI write-action framework (CTO §9): the model may PROPOSE these actions,
 * never execute them. Lifecycle: propose (validate + permission + server-built
 * preview → ai_proposed_actions row) → the user confirms in the UI →
 * permission RE-CHECKED with a fresh TenantContext → execute through the SAME
 * RPCs the app uses → audit. Proposals are user-bound, single-use and expire.
 *
 * HARD-BLOCKED (never in this catalogue): deleting/archiving students,
 * modifying/reversing payments, publishing results, changing grades, payroll,
 * suspending accounts, changing subscription plans, platform operations.
 */

export interface ActionPreview {
  title: string;
  lines: Array<[string, string]>;
  warnings: string[];
}

interface ActionDef {
  description: string;
  /** JSON schema handed to the model. */
  parameters: Record<string, unknown>;
  /** Permission required both at proposal AND at confirmation. */
  permission: string;
  argsSchema: z.ZodType<Record<string, unknown>>;
  /** Validates against live data and builds the human preview. Throws Error('CODE: message') on invalid input. */
  preview: (
    supabase: SupabaseService,
    ctx: TenantContext,
    args: Record<string, unknown>,
  ) => Promise<ActionPreview>;
  execute: (
    supabase: SupabaseService,
    ctx: TenantContext,
    userId: string,
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}

const fmtTZS = (n: unknown) =>
  `TZS ${new Intl.NumberFormat('en-US').format(Number(n ?? 0))}`;

/** Business-code errors from RPCs → concise message. */
function rpcThrow(error: { message: string }): never {
  const match = /[A-Z]{3,}(?:_[A-Z]+)+/.exec(error.message);
  throw new Error(match ? match[0] : error.message.slice(0, 200));
}

async function findInvoice(
  supabase: SupabaseService,
  ctx: TenantContext,
  invoiceNumber: string,
) {
  const { data: invoice } = await supabase.admin
    .from('invoices')
    .select(
      'id, invoice_number, total, status, students(first_name, last_name, student_number)',
    )
    .eq('tenant_id', ctx.tenantId)
    .eq('invoice_number', invoiceNumber.toUpperCase().trim())
    .maybeSingle();
  if (!invoice)
    throw new Error(
      `INVOICE_NOT_FOUND: no invoice ${invoiceNumber} in this school`,
    );
  const { data: payments } = await supabase.admin
    .from('payments')
    .select('amount')
    .eq('invoice_id', invoice.id as string);
  const paid = (payments ?? []).reduce((s, p) => s + Number(p.amount), 0);
  const student = invoice.students as unknown as {
    first_name: string;
    last_name: string;
    student_number: string;
  } | null;
  return {
    id: invoice.id as string,
    number: invoice.invoice_number as string,
    total: Number(invoice.total),
    balance: Number(invoice.total) - paid,
    studentName:
      `${student?.first_name ?? ''} ${student?.last_name ?? ''}`.trim(),
    studentNumber: student?.student_number ?? '',
  };
}

async function resolveSection(
  supabase: SupabaseService,
  ctx: TenantContext,
  className: string,
  stream?: string,
) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const { data: sections } = await supabase.admin
    .from('class_sections')
    .select('id, name, grade_levels(name)')
    .eq('tenant_id', ctx.tenantId);
  const match = (sections ?? []).find((s) => {
    const grade =
      (s.grade_levels as unknown as { name: string } | null)?.name ?? '';
    return (
      norm(grade) === norm(className) &&
      (!stream || norm(s.name as string) === norm(stream))
    );
  });
  if (!match) {
    throw new Error(
      `SECTION_NOT_FOUND: no class "${className}${stream ? ` ${stream}` : ''}" in this school`,
    );
  }
  const grade =
    (match.grade_levels as unknown as { name: string } | null)?.name ?? '';
  return {
    id: match.id as string,
    label: `${grade} ${match.name as string}`.trim(),
  };
}

const PAYMENT_METHODS = [
  'cash',
  'mpesa',
  'tigopesa',
  'airtel_money',
  'halopesa',
  'bank',
  'cheque',
  'other',
] as const;

export const AI_ACTIONS: Record<string, ActionDef> = {
  recordPayment: {
    description:
      'PROPOSE recording a fee payment against an invoice (by invoice number). The user must confirm before anything is recorded.',
    parameters: {
      type: 'object',
      properties: {
        invoiceNumber: { type: 'string', description: 'e.g. INV-00012' },
        amount: { type: 'number', description: 'Amount in TZS' },
        method: { type: 'string', enum: [...PAYMENT_METHODS] },
        reference: {
          type: 'string',
          description: 'Transaction reference (optional)',
        },
      },
      required: ['invoiceNumber', 'amount', 'method'],
    },
    permission: 'finance.payments.receive',
    argsSchema: z.object({
      invoiceNumber: z.string().min(3).max(20),
      amount: z.coerce.number().positive().max(1e9),
      method: z.enum(PAYMENT_METHODS),
      reference: z.string().max(100).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const invoice = await findInvoice(
        supabase,
        ctx,
        args.invoiceNumber as string,
      );
      const amount = Number(args.amount);
      const warnings: string[] = [];
      if (amount > invoice.balance) {
        warnings.push(
          `Amount exceeds the open balance of ${fmtTZS(invoice.balance)} — execution will be rejected.`,
        );
      }
      return {
        title: `Record payment of ${fmtTZS(amount)}`,
        lines: [
          ['Student', `${invoice.studentName} (${invoice.studentNumber})`],
          ['Invoice', `${invoice.number} — balance ${fmtTZS(invoice.balance)}`],
          ['Amount', fmtTZS(amount)],
          ['Method', args.method as string],
          ...(args.reference
            ? ([['Reference', args.reference as string]] as Array<
                [string, string]
              >)
            : []),
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const invoice = await findInvoice(
        supabase,
        ctx,
        args.invoiceNumber as string,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('record_payment', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_invoice_id: invoice.id,
        p_amount: Number(args.amount),
        p_method: args.method,
        p_reference: (args.reference as string | undefined) ?? null,
        p_paid_on: null,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { paymentId, receiptNumber, balance }
    },
  },

  createInvoice: {
    description:
      'PROPOSE issuing a fee invoice to a student (by student number) with one or more line items. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              amount: { type: 'number', description: 'TZS' },
            },
            required: ['description', 'amount'],
          },
        },
      },
      required: ['studentNumber', 'lines'],
    },
    permission: 'finance.invoices.create',
    argsSchema: z.object({
      studentNumber: z.string().min(3).max(20),
      lines: z
        .array(
          z.object({
            description: z.string().min(2).max(120),
            amount: z.coerce.number().positive().max(1e9),
          }),
        )
        .min(1)
        .max(10),
    }),
    preview: async (supabase, ctx, args) => {
      const { data: student } = await supabase.admin
        .from('students')
        .select('id, first_name, last_name, student_number')
        .eq('tenant_id', ctx.tenantId)
        .eq('student_number', String(args.studentNumber).toUpperCase().trim())
        .maybeSingle();
      if (!student)
        throw new Error(
          `STUDENT_NOT_FOUND: no student ${String(args.studentNumber)}`,
        );
      const lines = args.lines as Array<{
        description: string;
        amount: number;
      }>;
      const total = lines.reduce((s, l) => s + Number(l.amount), 0);
      return {
        title: `Issue invoice of ${fmtTZS(total)}`,
        lines: [
          [
            'Student',
            `${student.first_name} ${student.last_name} (${student.student_number})`,
          ],
          ...lines.map((l): [string, string] => [
            l.description,
            fmtTZS(l.amount),
          ]),
          ['Total', fmtTZS(total)],
        ],
        warnings: [],
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const { data: student } = await supabase.admin
        .from('students')
        .select('id')
        .eq('tenant_id', ctx.tenantId)
        .eq('student_number', String(args.studentNumber).toUpperCase().trim())
        .maybeSingle();
      if (!student) throw new Error('STUDENT_NOT_FOUND');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('create_invoice', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_student_id: student.id as string,
        p_term_id: null,
        p_due_on: null,
        p_lines: args.lines,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { invoiceId, invoiceNumber, total }
    },
  },

  createStudent: {
    description:
      'PROPOSE admitting a new student (optionally with class and guardian). The user must confirm before the record is created.',
    parameters: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        middleName: { type: 'string' },
        lastName: { type: 'string' },
        gender: { type: 'string', enum: ['male', 'female'] },
        dateOfBirth: { type: 'string', description: 'YYYY-MM-DD (optional)' },
        className: { type: 'string', description: 'e.g. Form 1 (optional)' },
        stream: { type: 'string', description: 'e.g. A (optional)' },
        guardianName: { type: 'string' },
        guardianPhone: { type: 'string' },
      },
      required: ['firstName', 'lastName', 'gender'],
    },
    permission: 'students.create',
    argsSchema: z.object({
      firstName: z.string().min(2).max(60),
      middleName: z.string().max(60).optional(),
      lastName: z.string().min(2).max(60),
      gender: z.enum(['male', 'female']),
      dateOfBirth: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      className: z.string().max(40).optional(),
      stream: z.string().max(20).optional(),
      guardianName: z.string().max(120).optional(),
      guardianPhone: z.string().max(20).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const warnings: string[] = [];
      const lines: Array<[string, string]> = [
        [
          'Name',
          [args.firstName, args.middleName, args.lastName]
            .filter(Boolean)
            .join(' '),
        ],
        ['Gender', String(args.gender)],
      ];
      if (args.dateOfBirth)
        lines.push(['Date of birth', args.dateOfBirth as string]);
      if (args.className) {
        const section = await resolveSection(
          supabase,
          ctx,
          args.className as string,
          args.stream as string | undefined,
        );
        lines.push(['Class', section.label]);
      }
      if (args.guardianName) {
        lines.push([
          'Guardian',
          `${args.guardianName as string}${args.guardianPhone ? ` (${args.guardianPhone as string})` : ''}`,
        ]);
        if (!args.guardianPhone)
          warnings.push('Guardian has no phone — SMS will not reach them.');
      }
      const { limits, usage } = ctx.entitlements;
      if (limits.students !== null && usage.students + 1 > limits.students) {
        warnings.push(
          `Plan limit reached (${usage.students}/${limits.students} students) — execution will be rejected.`,
        );
      }
      return { title: 'Admit new student', lines, warnings };
    },
    execute: async (supabase, ctx, userId, args) => {
      const { limits, usage } = ctx.entitlements;
      if (limits.students !== null && usage.students + 1 > limits.students) {
        throw new Error('PLAN_LIMIT_STUDENTS');
      }
      let classSectionId: string | undefined;
      if (args.className) {
        classSectionId = (
          await resolveSection(
            supabase,
            ctx,
            args.className as string,
            args.stream as string | undefined,
          )
        ).id;
      }

      const [{ data: campus }, { data: year }] = await Promise.all([
        supabase.admin
          .from('campuses')
          .select('id')
          .eq('tenant_id', ctx.tenantId)
          .eq('is_main', true)
          .maybeSingle(),
        supabase.admin
          .from('academic_years')
          .select('id')
          .eq('tenant_id', ctx.tenantId)
          .eq('status', 'active')
          .order('starts_on', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('import_students', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_campus_id: (campus?.id as string | undefined) ?? null,
        p_year_id: (year?.id as string | undefined) ?? null,
        p_rows: [
          {
            firstName: args.firstName,
            middleName: args.middleName,
            lastName: args.lastName,
            gender: args.gender,
            dateOfBirth: args.dateOfBirth,
            classSectionId,
            ...(args.guardianName
              ? {
                  guardian: {
                    fullName: args.guardianName,
                    phone: args.guardianPhone,
                  },
                }
              : {}),
          },
        ],
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { imported: 1 }
    },
  },

  inviteStaff: {
    description:
      'PROPOSE inviting a staff member by email with one or more roles (teacher, bursar, school_admin, …). The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        roleKeys: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'director',
              'head_teacher',
              'school_admin',
              'academic_master',
              'bursar',
              'accountant',
              'cashier',
              'teacher',
              'class_teacher',
            ],
          },
        },
      },
      required: ['email', 'roleKeys'],
    },
    permission: 'members.invite',
    argsSchema: z.object({
      email: z.string().email(),
      roleKeys: z
        .array(
          z.enum([
            'director',
            'head_teacher',
            'school_admin',
            'academic_master',
            'bursar',
            'accountant',
            'cashier',
            'teacher',
            'class_teacher',
          ]),
        )
        .min(1)
        .max(3),
    }),
    preview: (_supabase, ctx, args) => {
      const warnings: string[] = [];
      const { limits, usage } = ctx.entitlements;
      if (limits.staff !== null && usage.staff + 1 > limits.staff) {
        warnings.push(
          `Plan staff limit reached (${usage.staff}/${limits.staff}) — execution will be rejected.`,
        );
      }
      return Promise.resolve({
        title: 'Invite staff member',
        lines: [
          ['Email', args.email as string],
          ['Roles', (args.roleKeys as string[]).join(', ')],
        ],
        warnings,
      });
    },
    execute: async (supabase, ctx, userId, args) => {
      const { limits, usage } = ctx.entitlements;
      if (limits.staff !== null && usage.staff + 1 > limits.staff) {
        throw new Error('PLAN_LIMIT_STAFF');
      }
      const token = randomBytes(24).toString('hex');
      const { error } = await supabase.admin.from('invitations').insert({
        tenant_id: ctx.tenantId,
        email: args.email,
        role_keys: args.roleKeys,
        token_hash: createHash('sha256').update(token).digest('hex'),
        invited_by: userId,
        expires_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
      });
      if (error) rpcThrow(error);
      return {
        inviteUrl: `${resolveWebOrigin()}/invite/${token}`,
        email: args.email,
      };
    },
  },

  sendAnnouncement: {
    description:
      'PROPOSE an SMS announcement to guardians (whole school or one class). Shows the recipient count before anything is sent. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'SMS text, max 480 chars' },
        className: {
          type: 'string',
          description: 'Limit to one class, e.g. Form 4 (optional)',
        },
        stream: {
          type: 'string',
          description: 'Stream when className is set (optional)',
        },
      },
      required: ['body'],
    },
    permission: 'communication.send',
    argsSchema: z.object({
      body: z.string().min(5).max(480),
      className: z.string().max(40).optional(),
      stream: z.string().max(20).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      let scope = 'All guardians (whole school)';
      let recipientEstimate: number;
      if (args.className) {
        const section = await resolveSection(
          supabase,
          ctx,
          args.className as string,
          args.stream as string | undefined,
        );
        scope = `Guardians of ${section.label}`;
        const { count } = await supabase.admin
          .from('class_enrolments')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId)
          .eq('class_section_id', section.id)
          .eq('status', 'active');
        recipientEstimate = count ?? 0;
      } else {
        const { count } = await supabase.admin
          .from('guardians')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId)
          .not('phone', 'is', null);
        recipientEstimate = count ?? 0;
      }
      return {
        title: 'Send SMS announcement',
        lines: [
          ['Audience', scope],
          ['Estimated recipients', `~${recipientEstimate} (deduped by phone)`],
          ['Message', args.body as string],
        ],
        warnings: ['Sending SMS costs money and cannot be recalled.'],
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      let sectionId: string | null = null;
      if (args.className) {
        sectionId = (
          await resolveSection(
            supabase,
            ctx,
            args.className as string,
            args.stream as string | undefined,
          )
        ).id;
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('queue_announcement', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_audience_type: sectionId ? 'class_section' : 'all_guardians',
        p_class_section_id: sectionId,
        p_body: args.body,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { announcementId, queued }
    },
  },

  sendFeeReminders: {
    description:
      'PROPOSE sending SMS fee reminders to the primary guardian of every student with an unpaid invoice. The user must confirm.',
    parameters: { type: 'object', properties: {}, required: [] },
    permission: 'finance.invoices.create',
    argsSchema: z.object({}),
    preview: async (supabase, ctx) => {
      const { count } = await supabase.admin
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', ctx.tenantId)
        .in('status', ['issued', 'partially_paid']);
      return {
        title: 'Send fee reminders',
        lines: [
          [
            'Unpaid invoices',
            `${count ?? 0} (one SMS each, deduped while a reminder is pending)`,
          ],
        ],
        warnings: ['Sending SMS costs money and cannot be recalled.'],
      };
    },
    execute: async (supabase, ctx, userId) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('queue_fee_reminders', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { queued }
    },
  },
};

export interface ProposalRecord {
  id: string;
  action_name: string;
  arguments: Record<string, unknown>;
  preview: ActionPreview;
  status: string;
  expires_at: string;
}

@Injectable()
export class AiActionsService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Called from the AI tool loop. Permission was already checked by the tool
   * wrapper (same key). Validates args, builds the preview from live data and
   * stores the proposal. Returns what the model may tell the user.
   */
  async propose(
    ctx: TenantContext,
    userId: string,
    conversationId: string | null,
    actionName: string,
    rawArgs: Record<string, unknown>,
  ): Promise<{
    actionId: string;
    requiresConfirmation: true;
    preview: ActionPreview;
    expiresAt: string;
  }> {
    const def = AI_ACTIONS[actionName];
    if (!def) throw new Error(`UNKNOWN_ACTION: ${actionName}`);
    const parsed = def.argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      throw new Error(
        `INVALID_ARGUMENTS: ${parsed.error.issues
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')
          .slice(0, 200)}`,
      );
    }
    const preview = await def.preview(this.supabase, ctx, parsed.data);
    const { data: row, error } = await this.supabase.admin
      .from('ai_proposed_actions')
      .insert({
        tenant_id: ctx.tenantId,
        conversation_id: conversationId,
        user_id: userId,
        action_name: actionName,
        arguments: parsed.data,
        preview,
      })
      .select('id, expires_at')
      .single();
    if (error) throw new Error(`PROPOSAL_STORE_FAILED: ${error.message}`);
    return {
      actionId: row.id as string,
      requiresConfirmation: true,
      preview,
      expiresAt: row.expires_at as string,
    };
  }

  /**
   * Confirmation path (never reachable by the model). The caller guarantees a
   * fresh TenantContext for the CONFIRMING user; permission is re-checked
   * here, state is re-validated by the underlying RPCs, and the row is
   * resolved atomically so a proposal can only ever execute once.
   */
  async confirm(
    ctx: TenantContext,
    userId: string,
    actionId: string,
  ): Promise<{
    status: string;
    result?: Record<string, unknown>;
    error?: string;
  }> {
    // Atomic claim: only one confirm can flip proposed → executing path.
    interface ClaimedProposal {
      id: string;
      action_name: string;
      arguments: Record<string, unknown>;
    }
    const claimResult: { data: ClaimedProposal[] | null } =
      await this.supabase.admin
        .from('ai_proposed_actions')
        .update({ status: 'executed', resolved_at: new Date().toISOString() })
        .eq('id', actionId)
        .eq('tenant_id', ctx.tenantId)
        .eq('user_id', userId) // only the proposer may confirm
        .eq('status', 'proposed')
        .gt('expires_at', new Date().toISOString())
        .select('id, action_name, arguments');
    const claimed = claimResult.data;
    if (!claimed || claimed.length === 0) {
      // Distinguish expiry for a better message (and mark it).
      await this.supabase.admin
        .from('ai_proposed_actions')
        .update({ status: 'expired', resolved_at: new Date().toISOString() })
        .eq('id', actionId)
        .eq('tenant_id', ctx.tenantId)
        .eq('user_id', userId)
        .eq('status', 'proposed')
        .lte('expires_at', new Date().toISOString());
      throw new Error('ACTION_NOT_CONFIRMABLE');
    }
    const proposal = claimed[0];
    const def = AI_ACTIONS[proposal.action_name];

    // Permission re-check at confirmation time (roles may have changed).
    if (!def || (!ctx.isOwner && !ctx.permissions.has(def.permission))) {
      await this.supabase.admin
        .from('ai_proposed_actions')
        .update({ status: 'failed', error: 'PERMISSION_DENIED' })
        .eq('id', proposal.id);
      throw new Error('PERMISSION_DENIED');
    }

    try {
      const result = await def.execute(
        this.supabase,
        ctx,
        userId,
        proposal.arguments,
      );
      await this.supabase.admin
        .from('ai_proposed_actions')
        .update({ result })
        .eq('id', proposal.id);
      await this.supabase.admin.from('audit_logs').insert({
        tenant_id: ctx.tenantId,
        actor_user_id: userId,
        action: 'ai.action_executed',
        entity_type: 'ai_proposed_action',
        entity_id: proposal.id,
        after: { actionName: proposal.action_name, result },
      });
      return { status: 'executed', result };
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      await this.supabase.admin
        .from('ai_proposed_actions')
        .update({ status: 'failed', error: message })
        .eq('id', proposal.id);
      await this.supabase.admin.from('audit_logs').insert({
        tenant_id: ctx.tenantId,
        actor_user_id: userId,
        action: 'ai.action_failed',
        entity_type: 'ai_proposed_action',
        entity_id: proposal.id,
        after: { actionName: proposal.action_name, error: message },
      });
      return { status: 'failed', error: message };
    }
  }

  async reject(
    ctx: TenantContext,
    userId: string,
    actionId: string,
  ): Promise<void> {
    const { data: updated } = await this.supabase.admin
      .from('ai_proposed_actions')
      .update({ status: 'rejected', resolved_at: new Date().toISOString() })
      .eq('id', actionId)
      .eq('tenant_id', ctx.tenantId)
      .eq('user_id', userId)
      .eq('status', 'proposed')
      .select('id');
    if (!updated || updated.length === 0)
      throw new Error('ACTION_NOT_CONFIRMABLE');
  }
}
