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
 * HARD-BLOCKED (never in this catalogue): DELETING students or any other
 * record, modifying/reversing payments, publishing results, changing grades,
 * payroll, suspending accounts, changing subscription plans, activating an
 * academic year, platform operations.
 *
 * setStudentStatus is the one lifecycle exception and is NOT a deletion: it
 * sets students.status (migration 0030) so a leaver stops being invoiced,
 * stops receiving absence SMS and frees a plan seat. The row and its history
 * survive, the terminal states demand `students.archive` on top of the action's
 * `students.update`, and — like every action here — nothing happens until a
 * human confirms.
 *
 * DEFERRED (allowed in principle, not proposable yet): bulk attendance
 * recording — a whole-class per-student payload does not fit the single-card
 * propose→confirm preview UX; registers stay in the attendance page.
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
  /**
   * Optional: strip secrets from the execute result BEFORE it is persisted to
   * ai_proposed_actions.result / audit_logs.after. The FULL result is still
   * returned to the HTTP caller (e.g. a one-time invite link the UI shows once).
   */
  redactForStorage?: (
    result: Record<string, unknown>,
  ) => Record<string, unknown>;
}

const fmtTZS = (n: unknown) =>
  `TZS ${new Intl.NumberFormat('en-US').format(Number(n ?? 0))}`;

/** Business-code errors from RPCs → concise message. */
function rpcThrow(error: { message: string }): never {
  const match = /[A-Z]{3,}(?:_[A-Z]+)+/.exec(error.message);
  throw new Error(match ? match[0] : error.message.slice(0, 200));
}

/**
 * Super-roles (full school access) must NEVER be granted through the AI — that
 * is a privilege-escalation vector. Defence in depth behind the schema/enum:
 * only a human owner acting through the normal UI may mint these.
 */
const AI_FORBIDDEN_ROLES = new Set(['school_owner', 'director']);
function assertNoSuperRole(ctx: TenantContext, roleKeys: string[]): void {
  void ctx; // present for symmetry / future per-tenant policy; guard is absolute
  if (roleKeys.some((k) => AI_FORBIDDEN_ROLES.has(k))) {
    throw new Error(
      'SUPER_ROLE_FORBIDDEN: the assistant cannot grant owner/director roles',
    );
  }
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

const TIMETABLE_DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
] as const;

/** Resolves the human-friendly setTimetableSlot args against live data. */
async function resolveTimetableSlot(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const section = await resolveSection(
    supabase,
    ctx,
    args.className as string,
    args.stream as string | undefined,
  );

  const { data: periods } = await supabase.admin
    .from('timetable_periods')
    .select('id, label, starts_at, ends_at, is_break')
    .eq('tenant_id', ctx.tenantId);
  const period = (periods ?? []).find(
    (p) => norm(p.label as string) === norm(args.periodLabel as string),
  );
  if (!period) {
    throw new Error(
      `PERIOD_NOT_FOUND: no period "${args.periodLabel as string}" — check the timetable setup`,
    );
  }
  if (period.is_break as boolean) {
    throw new Error(
      `TIMETABLE_PERIOD_IS_BREAK: "${period.label as string}" is a break`,
    );
  }

  const { data: subject } = await supabase.admin
    .from('subjects')
    .select('id, code, name')
    .eq('tenant_id', ctx.tenantId)
    .eq('code', String(args.subjectCode).toUpperCase().trim())
    .eq('status', 'active')
    .maybeSingle();
  if (!subject) {
    throw new Error(
      `SUBJECT_NOT_FOUND: no subject with code ${String(args.subjectCode)}`,
    );
  }

  const { data: members } = await supabase.admin
    .from('tenant_memberships')
    .select('user_id, profiles(full_name)')
    .eq('tenant_id', ctx.tenantId)
    .eq('status', 'active')
    .limit(1000);
  const matches = (members ?? []).filter((m) => {
    const name =
      (m.profiles as unknown as { full_name: string } | null)?.full_name ?? '';
    return norm(name) === norm(args.teacherName as string);
  });
  if (matches.length === 0) {
    throw new Error(
      `TEACHER_NOT_FOUND: no active staff member named "${args.teacherName as string}"`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `TEACHER_AMBIGUOUS: ${matches.length} staff members named "${args.teacherName as string}"`,
    );
  }
  const teacherName =
    (matches[0].profiles as unknown as { full_name: string } | null)
      ?.full_name ?? (args.teacherName as string);

  return {
    section,
    day: Number(args.day),
    period: {
      id: period.id as string,
      label: period.label as string,
      time: `${(period.starts_at as string).slice(0, 5)}-${(period.ends_at as string).slice(0, 5)}`,
    },
    subject: {
      id: subject.id as string,
      code: subject.code as string,
      name: subject.name as string,
    },
    teacher: { userId: matches[0].user_id as string, name: teacherName },
  };
}

/** Resolves the human-friendly assignCombination args against live data. */
async function resolveCombinationAssignment(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const { data: student } = await supabase.admin
    .from('students')
    .select('id, first_name, last_name, student_number, status')
    .eq('tenant_id', ctx.tenantId)
    .eq('student_number', String(args.studentNumber).toUpperCase().trim())
    .maybeSingle();
  if (!student) {
    throw new Error(
      `STUDENT_NOT_FOUND: no student ${String(args.studentNumber)}`,
    );
  }

  const { data: combination } = await supabase.admin
    .from('subject_combinations')
    .select(
      'id, code, name, subject_combination_subjects(is_principal, subjects(code))',
    )
    .eq('tenant_id', ctx.tenantId)
    .eq('code', String(args.combinationCode).toUpperCase().trim())
    .maybeSingle();
  if (!combination) {
    throw new Error(
      `COMBINATION_NOT_FOUND: no combination ${String(args.combinationCode)} — add it on the Academics page first`,
    );
  }

  const yearName =
    typeof args.academicYear === 'string' && args.academicYear.trim() !== ''
      ? args.academicYear.trim()
      : null;
  let yearQuery = supabase.admin
    .from('academic_years')
    .select('id, name')
    .eq('tenant_id', ctx.tenantId);
  yearQuery = yearName
    ? yearQuery.eq('name', yearName)
    : yearQuery.eq('status', 'active').order('starts_on', { ascending: false });
  const { data: years } = await yearQuery.limit(1);
  const year = (years ?? [])[0];
  if (!year) {
    throw new Error(
      `YEAR_NOT_FOUND: no ${yearName ? `academic year "${yearName}"` : 'active academic year'}`,
    );
  }

  const subjects = (
    combination.subject_combination_subjects as unknown as Array<{
      is_principal: boolean;
      subjects: { code: string } | null;
    }>
  )
    .map((s) =>
      s.is_principal ? (s.subjects?.code ?? '') : `${s.subjects?.code ?? ''}*`,
    )
    .filter((code) => code !== '' && code !== '*')
    .sort()
    .join(', ');

  return {
    student: {
      id: student.id as string,
      label: `${student.first_name as string} ${student.last_name as string} (${student.student_number as string})`,
    },
    combination: {
      id: combination.id as string,
      code: combination.code as string,
      name: combination.name as string,
      subjects,
    },
    year: { id: year.id as string, name: year.name as string },
  };
}

async function resolveStudentByNumber(
  supabase: SupabaseService,
  ctx: TenantContext,
  studentNumber: unknown,
) {
  const { data: student } = await supabase.admin
    .from('students')
    .select(
      'id, first_name, last_name, student_number, gender, boarding_status, status',
    )
    .eq('tenant_id', ctx.tenantId)
    .eq('student_number', String(studentNumber).toUpperCase().trim())
    .maybeSingle();
  if (!student) {
    throw new Error(`STUDENT_NOT_FOUND: no student ${String(studentNumber)}`);
  }
  return {
    id: student.id as string,
    label: `${student.first_name as string} ${student.last_name as string} (${student.student_number as string})`,
    gender: student.gender as string,
    boardingStatus: student.boarding_status as string,
    status: student.status as string,
  };
}

async function resolveAcademicYear(
  supabase: SupabaseService,
  ctx: TenantContext,
  yearArg: unknown,
) {
  const yearName =
    typeof yearArg === 'string' && yearArg.trim() !== ''
      ? yearArg.trim()
      : null;
  let yearQuery = supabase.admin
    .from('academic_years')
    .select('id, name')
    .eq('tenant_id', ctx.tenantId);
  yearQuery = yearName
    ? yearQuery.eq('name', yearName)
    : yearQuery.eq('status', 'active').order('starts_on', { ascending: false });
  const { data: years } = await yearQuery.limit(1);
  const year = (years ?? [])[0];
  if (!year) {
    throw new Error(
      `YEAR_NOT_FOUND: no ${yearName ? `academic year "${yearName}"` : 'active academic year'}`,
    );
  }
  return { id: year.id as string, name: year.name as string };
}

/** Resolves the human-friendly allocateHostelBed args against live data. */
async function resolveHostelAllocation(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const student = await resolveStudentByNumber(
    supabase,
    ctx,
    args.studentNumber,
  );

  const { data: hostels } = await supabase.admin
    .from('hostels')
    .select('id, name, gender, hostel_rooms(id, name, capacity)')
    .eq('tenant_id', ctx.tenantId)
    .limit(200);
  const hostel = (hostels ?? []).find(
    (h) => norm(h.name as string) === norm(String(args.hostelName)),
  );
  if (!hostel) {
    throw new Error(
      `HOSTEL_NOT_FOUND: no hostel "${String(args.hostelName)}" in this school`,
    );
  }
  const rooms = hostel.hostel_rooms as unknown as Array<{
    id: string;
    name: string;
    capacity: number;
  }>;
  const room = rooms.find((r) => norm(r.name) === norm(String(args.roomName)));
  if (!room) {
    throw new Error(
      `ROOM_NOT_FOUND: no room "${String(args.roomName)}" in ${hostel.name as string}`,
    );
  }

  const year = await resolveAcademicYear(supabase, ctx, args.academicYear);

  const { count: occupied } = await supabase.admin
    .from('hostel_allocations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', ctx.tenantId)
    .eq('room_id', room.id)
    .is('released_at', null)
    .neq('student_id', student.id);

  return {
    student,
    hostel: {
      id: hostel.id as string,
      name: hostel.name as string,
      gender: hostel.gender as string,
    },
    room: { ...room, occupied: occupied ?? 0 },
    year,
  };
}

/** Resolves the human-friendly assignTransport args against live data. */
async function resolveTransportAssignment(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const student = await resolveStudentByNumber(
    supabase,
    ctx,
    args.studentNumber,
  );

  const { data: routes } = await supabase.admin
    .from('transport_routes')
    .select('id, name, fee_amount, transport_stops(id, name)')
    .eq('tenant_id', ctx.tenantId)
    .limit(200);
  const route = (routes ?? []).find(
    (r) => norm(r.name as string) === norm(String(args.routeName)),
  );
  if (!route) {
    throw new Error(
      `ROUTE_NOT_FOUND: no transport route "${String(args.routeName)}" in this school`,
    );
  }

  let stop: { id: string; name: string } | null = null;
  if (typeof args.stopName === 'string' && args.stopName.trim() !== '') {
    const stops = route.transport_stops as unknown as Array<{
      id: string;
      name: string;
    }>;
    stop =
      stops.find((s) => norm(s.name) === norm(args.stopName as string)) ?? null;
    if (!stop) {
      throw new Error(
        `STOP_NOT_FOUND: route ${route.name as string} has no stop "${args.stopName}"`,
      );
    }
  }

  const year = await resolveAcademicYear(supabase, ctx, args.academicYear);

  return {
    student,
    route: {
      id: route.id as string,
      name: route.name as string,
      feeAmount: Number(route.fee_amount),
    },
    stop,
    year,
  };
}

/** Resolves the human-friendly loanBook args against live data. */
async function resolveBookLoan(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const student = await resolveStudentByNumber(
    supabase,
    ctx,
    args.studentNumber,
  );

  const { data: book } = await supabase.admin
    .from('library_books')
    .select('id, code, title, copies_total')
    .eq('tenant_id', ctx.tenantId)
    .eq('code', String(args.bookCode).toUpperCase().trim())
    .maybeSingle();
  if (!book) {
    throw new Error(
      `LIBRARY_BOOK_NOT_FOUND: no book with code ${String(args.bookCode)} in this school`,
    );
  }

  const { count: activeLoans } = await supabase.admin
    .from('library_loans')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', ctx.tenantId)
    .eq('book_id', book.id as string)
    .is('returned_on', null);

  const dueOn =
    typeof args.dueOn === 'string' && args.dueOn.trim() !== ''
      ? args.dueOn.trim()
      : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);

  return {
    student,
    book: {
      id: book.id as string,
      code: book.code as string,
      title: book.title as string,
      copiesTotal: book.copies_total as number,
      available: (book.copies_total as number) - (activeLoans ?? 0),
    },
    dueOn,
  };
}

/** Resolves the human-friendly returnBook args to the student's ACTIVE loan. */
async function resolveActiveLoan(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const student = await resolveStudentByNumber(
    supabase,
    ctx,
    args.studentNumber,
  );

  const { data: book } = await supabase.admin
    .from('library_books')
    .select('id, code, title')
    .eq('tenant_id', ctx.tenantId)
    .eq('code', String(args.bookCode).toUpperCase().trim())
    .maybeSingle();
  if (!book) {
    throw new Error(
      `LIBRARY_BOOK_NOT_FOUND: no book with code ${String(args.bookCode)} in this school`,
    );
  }

  const { data: loan } = await supabase.admin
    .from('library_loans')
    .select('id, loaned_on, due_on')
    .eq('tenant_id', ctx.tenantId)
    .eq('book_id', book.id as string)
    .eq('student_id', student.id)
    .is('returned_on', null)
    .maybeSingle();
  if (!loan) {
    throw new Error(
      `LIBRARY_LOAN_NOT_FOUND: ${student.label} has no active loan of ${book.code as string}`,
    );
  }

  return {
    student,
    book: {
      id: book.id as string,
      code: book.code as string,
      title: book.title as string,
    },
    loan: {
      id: loan.id as string,
      loanedOn: loan.loaned_on as string,
      dueOn: loan.due_on as string,
    },
  };
}

/** Resolves the human-friendly recordStockMovement args against live data. */
async function resolveInventoryMovement(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const { data: items } = await supabase.admin
    .from('inventory_items')
    .select('id, name, unit, reorder_level')
    .eq('tenant_id', ctx.tenantId)
    .limit(1000);
  const item = (items ?? []).find(
    (i) => norm(i.name as string) === norm(String(args.itemName)),
  );
  if (!item) {
    throw new Error(
      `INVENTORY_ITEM_NOT_FOUND: no store item "${String(args.itemName)}" — check the Inventory page`,
    );
  }

  // Exact current stock from the SQL aggregate RPC — never sum fetched
  // movement rows in JS (Supabase caps reads at 1000).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { data: stockRows, error } = await supabase.admin.rpc(
    'inventory_stock_levels',
    { p_tenant_id: ctx.tenantId },
  );
  if (error) throw new Error(error.message.slice(0, 200));
  const stockRow = (
    (stockRows ?? []) as Array<{ item_id: string; stock: number }>
  ).find((s) => s.item_id === (item.id as string));

  return {
    item: {
      id: item.id as string,
      name: item.name as string,
      unit: item.unit as string,
      reorderLevel: item.reorder_level as number,
      stock: Number(stockRow?.stock ?? 0),
    },
    kind: String(args.kind) as 'in' | 'out',
    quantity: Number(args.quantity),
  };
}

/** Resolves the human-friendly createAssessment class + term against live
 * data, enforcing the same term/year invariant as the assessments module. */
async function resolveAssessmentTarget(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const { data: sections } = await supabase.admin
    .from('class_sections')
    .select('id, name, academic_year_id, grade_levels(name)')
    .eq('tenant_id', ctx.tenantId)
    .limit(200);
  const match = (sections ?? []).find((s) => {
    const grade =
      (s.grade_levels as unknown as { name: string } | null)?.name ?? '';
    return (
      norm(grade) === norm(args.className as string) &&
      (!args.stream || norm(s.name as string) === norm(args.stream as string))
    );
  });
  if (!match) {
    throw new Error(
      `SECTION_NOT_FOUND: no class "${args.className as string}${args.stream ? ` ${args.stream as string}` : ''}" in this school`,
    );
  }
  const grade =
    (match.grade_levels as unknown as { name: string } | null)?.name ?? '';
  const section = {
    id: match.id as string,
    label: `${grade} ${match.name as string}`.trim(),
    yearId: match.academic_year_id as string,
  };

  const { data: terms } = await supabase.admin
    .from('academic_terms')
    .select('id, name, academic_year_id')
    .eq('tenant_id', ctx.tenantId)
    .limit(50);
  const term = (terms ?? []).find(
    (t) => norm(t.name as string) === norm(String(args.termName)),
  );
  if (!term) {
    throw new Error(
      `TERM_NOT_FOUND: no academic term "${String(args.termName)}" — check the Academics page`,
    );
  }
  if ((term.academic_year_id as string) !== section.yearId) {
    throw new Error(
      `ASSESSMENT_TERM_YEAR_MISMATCH: term "${term.name as string}" is not in ${section.label}'s academic year`,
    );
  }

  return {
    section,
    term: { id: term.id as string, name: term.name as string },
  };
}

const GUARDIAN_RELATIONSHIPS = [
  'mother',
  'father',
  'guardian',
  'sponsor',
  'other',
] as const;

/** Resolves the human-friendly linkGuardian args: both the student AND the
 * guardian must already exist IN THIS TENANT (the 0026 same-tenant trigger
 * is the DB backstop). Guardians are identified by phone (unique per tenant). */
async function resolveGuardianLink(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const student = await resolveStudentByNumber(
    supabase,
    ctx,
    args.studentNumber,
  );

  const phone = String(args.guardianPhone).trim();
  const { data: guardian } = await supabase.admin
    .from('guardians')
    .select('id, full_name, phone')
    .eq('tenant_id', ctx.tenantId)
    .eq('phone', phone)
    .maybeSingle();
  if (!guardian) {
    throw new Error(
      `GUARDIAN_NOT_FOUND: no guardian with phone ${phone} in this school — use searchGuardians to find the exact phone, or admit via createStudent to create a new guardian`,
    );
  }

  const [{ data: existing }, { data: primaries }] = await Promise.all([
    supabase.admin
      .from('student_guardians')
      .select('relationship')
      .eq('student_id', student.id)
      .eq('guardian_id', guardian.id as string)
      .maybeSingle(),
    supabase.admin
      .from('student_guardians')
      .select('guardian_id')
      .eq('student_id', student.id)
      .eq('is_primary', true)
      .limit(1),
  ]);

  return {
    student,
    guardian: {
      id: guardian.id as string,
      name: guardian.full_name as string,
      phone: guardian.phone as string | null,
    },
    alreadyLinked: existing !== null,
    hasPrimary: (primaries ?? []).length > 0,
  };
}

/** Lifecycle states of a pupil (migration 0030). */
const STUDENT_STATUSES = [
  'active',
  'transferred',
  'withdrawn',
  'graduated',
  'archived',
] as const;

/**
 * Business exceptions raised by the 0030 lifecycle RPCs. Mapped to exactly the
 * same stable codes students.controller / academics.controller return, so the
 * assistant and the app speak one error vocabulary.
 */
const LIFECYCLE_RPC_ERRORS = [
  'STUDENT_NOT_FOUND',
  'STUDENT_STATUS_INVALID',
  'ENROLMENT_STUDENT_NOT_FOUND',
  'ENROLMENT_SECTION_NOT_FOUND',
  'ENROLMENT_YEAR_MISMATCH',
  'YEAR_NAME_REQUIRED',
  'YEAR_NAME_TAKEN',
  'YEAR_TERMS_REQUIRED',
  'YEAR_CLONE_SOURCE_NOT_FOUND',
] as const;

function lifecycleRpcThrow(error: { message: string }): never {
  const known = LIFECYCLE_RPC_ERRORS.find((code) =>
    error.message.includes(code),
  );
  if (known) throw new Error(known);
  rpcThrow(error);
}

/**
 * Retiring a pupil is a heavier act than a plain correction: students.controller
 * requires `students.archive` ON TOP OF the route's `students.update` for every
 * non-active status. The AI path applies the SAME rule — at propose time AND
 * again at execute time, because roles can change while a proposal sits.
 */
function assertStudentStatusRight(ctx: TenantContext, status: string): void {
  if (status === 'active') return;
  if (ctx.isOwner || ctx.permissions.has('students.archive')) return;
  throw new Error(
    `PERMISSION_DENIED: students.archive is required to mark a pupil ${status}`,
  );
}

/**
 * Student lookup for the lifecycle actions: FULL name (middle name included)
 * plus admission number, so the confirmation card names the human being
 * affected. Tenant-scoped — the model supplies an admission number, never an id.
 */
async function resolveStudentForLifecycle(
  supabase: SupabaseService,
  ctx: TenantContext,
  studentNumber: unknown,
) {
  const { data: student } = await supabase.admin
    .from('students')
    .select('id, first_name, middle_name, last_name, student_number, status')
    .eq('tenant_id', ctx.tenantId)
    .eq('student_number', String(studentNumber).toUpperCase().trim())
    .maybeSingle();
  if (!student) {
    throw new Error(`STUDENT_NOT_FOUND: no student ${String(studentNumber)}`);
  }
  const fullName = [student.first_name, student.middle_name, student.last_name]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' ');
  return {
    id: student.id as string,
    fullName,
    number: student.student_number as string,
    label: `${fullName} (${student.student_number as string})`,
    status: student.status as string,
  };
}

/**
 * The pupil's placement for one academic year, rendered as
 * "<grade_levels.name> <class_sections.name>" — class_sections.name IS the
 * stream label ("A"); there is no stream column.
 */
async function currentPlacement(
  supabase: SupabaseService,
  ctx: TenantContext,
  studentId: string,
  yearId: string,
) {
  const { data: enrolment } = await supabase.admin
    .from('class_enrolments')
    .select(
      'id, status, class_section_id, class_sections(name, grade_levels(name))',
    )
    .eq('tenant_id', ctx.tenantId)
    .eq('student_id', studentId)
    .eq('academic_year_id', yearId)
    .maybeSingle();
  if (!enrolment) return null;
  const section = enrolment.class_sections as unknown as {
    name: string;
    grade_levels: { name: string } | null;
  } | null;
  return {
    sectionId: enrolment.class_section_id as string,
    status: enrolment.status as string,
    label:
      `${section?.grade_levels?.name ?? ''} ${section?.name ?? ''}`.trim() ||
      'Unknown class',
  };
}

/**
 * Resolves the human-friendly assignOrTransferClass args against live data.
 * The target section is looked up INSIDE the target academic year — a school
 * with several years has "Form 1 A" in each of them.
 */
async function resolveClassPlacement(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const student = await resolveStudentForLifecycle(
    supabase,
    ctx,
    args.studentNumber,
  );
  const year = await resolveAcademicYear(supabase, ctx, args.academicYear);

  const { data: sections } = await supabase.admin
    .from('class_sections')
    .select('id, name, capacity, grade_levels(name)')
    .eq('tenant_id', ctx.tenantId)
    .eq('academic_year_id', year.id)
    .eq('status', 'active')
    .limit(1000);
  const stream =
    typeof args.stream === 'string' && args.stream.trim() !== ''
      ? args.stream.trim()
      : null;
  const matches = (sections ?? []).filter((s) => {
    const grade =
      (s.grade_levels as unknown as { name: string } | null)?.name ?? '';
    return (
      norm(grade) === norm(String(args.className)) &&
      (!stream || norm(s.name as string) === norm(stream))
    );
  });
  if (matches.length === 0) {
    throw new Error(
      `ENROLMENT_SECTION_NOT_FOUND: no class "${String(args.className)}${stream ? ` ${stream}` : ''}" in ${year.name}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `SECTION_AMBIGUOUS: ${matches.length} streams match "${String(args.className)}" in ${year.name} — name the stream (e.g. A)`,
    );
  }
  const match = matches[0];
  const grade =
    (match.grade_levels as unknown as { name: string } | null)?.name ?? '';
  const [placement, occupancyResult] = await Promise.all([
    currentPlacement(supabase, ctx, student.id, year.id),
    supabase.admin
      .from('class_enrolments')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('class_section_id', match.id as string)
      .eq('status', 'active'),
  ]);

  return {
    student,
    year,
    target: {
      id: match.id as string,
      label: `${grade} ${match.name as string}`.trim(),
      capacity: (match.capacity as number | null) ?? null,
      occupancy: occupancyResult.count ?? 0,
    },
    current: placement,
  };
}

/**
 * Resolves the human-friendly createAcademicYear args: the clone source is
 * given by year NAME (the model never handles ids) and is resolved to an id
 * tenant-scoped, so a year from another school can never be copied.
 */
async function resolveYearCreation(
  supabase: SupabaseService,
  ctx: TenantContext,
  args: Record<string, unknown>,
) {
  const name = String(args.name).trim();
  const { data: existing } = await supabase.admin
    .from('academic_years')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('name', name)
    .maybeSingle();

  let clone: { id: string; name: string; sections: number } | null = null;
  if (
    typeof args.cloneSectionsFromYear === 'string' &&
    args.cloneSectionsFromYear.trim() !== ''
  ) {
    const sourceName = args.cloneSectionsFromYear.trim();
    const { data: source } = await supabase.admin
      .from('academic_years')
      .select('id, name')
      .eq('tenant_id', ctx.tenantId)
      .eq('name', sourceName)
      .maybeSingle();
    if (!source) {
      throw new Error(
        `YEAR_CLONE_SOURCE_NOT_FOUND: no academic year "${sourceName}" to copy classes from`,
      );
    }
    const { count } = await supabase.admin
      .from('class_sections')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', ctx.tenantId)
      .eq('academic_year_id', source.id as string)
      .eq('status', 'active');
    clone = {
      id: source.id as string,
      name: source.name as string,
      sections: count ?? 0,
    };
  }

  return { name, nameTaken: existing !== null, clone };
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

  setInvoiceInstalments: {
    description:
      'PROPOSE setting the instalment payment plan for an invoice (by invoice number): up to 6 instalments whose amounts must sum to the invoice total exactly, with strictly ascending due dates. Replaces any existing schedule. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        invoiceNumber: { type: 'string', description: 'e.g. INV-00012' },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              amount: { type: 'number', description: 'TZS' },
              dueOn: { type: 'string', description: 'Due date YYYY-MM-DD' },
            },
            required: ['amount', 'dueOn'],
          },
        },
      },
      required: ['invoiceNumber', 'rows'],
    },
    permission: 'finance.invoices.create',
    argsSchema: z.object({
      invoiceNumber: z.string().min(3).max(20),
      rows: z
        .array(
          z.object({
            amount: z.coerce.number().positive().max(1e9),
            dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          }),
        )
        .min(1)
        .max(6),
    }),
    preview: async (supabase, ctx, args) => {
      const invoice = await findInvoice(
        supabase,
        ctx,
        args.invoiceNumber as string,
      );
      const rows = args.rows as Array<{ amount: number; dueOn: string }>;
      const total = rows.reduce((s, r) => s + Number(r.amount), 0);
      const warnings: string[] = [];
      if (invoice.balance <= 0) {
        warnings.push(
          'The invoice is already fully paid — execution will be rejected.',
        );
      }
      if (total !== invoice.total) {
        warnings.push(
          `Instalments sum to ${fmtTZS(total)} but the invoice total is ${fmtTZS(invoice.total)} — execution will be rejected.`,
        );
      }
      const { count } = await supabase.admin
        .from('invoice_instalments')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', ctx.tenantId)
        .eq('invoice_id', invoice.id);
      if ((count ?? 0) > 0) {
        warnings.push(
          `This REPLACES the existing schedule of ${count} instalment(s).`,
        );
      }
      return {
        title: `Set ${rows.length}-instalment plan for ${invoice.number}`,
        lines: [
          ['Student', `${invoice.studentName} (${invoice.studentNumber})`],
          ['Invoice', `${invoice.number} — total ${fmtTZS(invoice.total)}`],
          ...rows.map((r, i): [string, string] => [
            `Instalment ${i + 1} — due ${r.dueOn}`,
            fmtTZS(r.amount),
          ]),
          ['Total', fmtTZS(total)],
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
      const { data, error } = await supabase.admin.rpc(
        'set_invoice_instalments',
        {
          p_tenant_id: ctx.tenantId,
          p_actor: userId,
          p_invoice_id: invoice.id,
          p_rows: args.rows,
        },
      );
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { invoiceId, instalments, total }
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
    // The AI must never mint a super-role. The schema/enum already exclude
    // them; this rejects any that slip through (e.g. legacy stored args).
    preview: (_supabase, ctx, args) => {
      assertNoSuperRole(ctx, args.roleKeys as string[]);
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
      assertNoSuperRole(ctx, args.roleKeys as string[]);
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
    // The plaintext invite token (inviteUrl) is a one-time secret shown to the
    // caller; never persist it at rest (defeats the hash-only-at-rest design).
    redactForStorage: (result) => ({
      email: result.email,
      invited: true,
    }),
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

  setTimetableSlot: {
    description:
      'PROPOSE placing (or replacing) one timetable lesson: class + weekday + period + subject + teacher. Rejected on teacher clashes. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'e.g. Form 1' },
        stream: { type: 'string', description: 'e.g. A (optional)' },
        day: {
          type: 'number',
          description: 'Weekday: 1=Monday … 5=Friday',
        },
        periodLabel: { type: 'string', description: 'Period label, e.g. P1' },
        subjectCode: { type: 'string', description: 'Subject code, e.g. MATH' },
        teacherName: { type: 'string', description: 'Staff member full name' },
      },
      required: [
        'className',
        'day',
        'periodLabel',
        'subjectCode',
        'teacherName',
      ],
    },
    permission: 'timetable.manage',
    argsSchema: z.object({
      className: z.string().min(1).max(40),
      stream: z.string().max(20).optional(),
      day: z.coerce.number().int().min(1).max(5),
      periodLabel: z.string().min(1).max(40),
      subjectCode: z.string().min(1).max(10),
      teacherName: z.string().min(2).max(120),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveTimetableSlot(supabase, ctx, args);
      const warnings: string[] = [];
      const { data: clash } = await supabase.admin
        .from('timetable_slots')
        .select('id, class_section_id')
        .eq('tenant_id', ctx.tenantId)
        .eq('teacher_user_id', resolved.teacher.userId)
        .eq('day_of_week', resolved.day)
        .eq('period_id', resolved.period.id)
        .neq('class_section_id', resolved.section.id)
        .limit(1);
      if ((clash ?? []).length > 0) {
        warnings.push(
          `${resolved.teacher.name} already teaches another class at this time — execution will be rejected.`,
        );
      }
      return {
        title: 'Set timetable lesson',
        lines: [
          ['Class', resolved.section.label],
          ['Day', TIMETABLE_DAYS[resolved.day - 1]],
          ['Period', `${resolved.period.label} (${resolved.period.time})`],
          ['Subject', `${resolved.subject.name} (${resolved.subject.code})`],
          ['Teacher', resolved.teacher.name],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveTimetableSlot(supabase, ctx, args);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('set_timetable_slot', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_section_id: resolved.section.id,
        p_day: resolved.day,
        p_period_id: resolved.period.id,
        p_subject_id: resolved.subject.id,
        p_teacher_user_id: resolved.teacher.userId,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { slotId }
    },
  },

  assignCombination: {
    description:
      'PROPOSE assigning an A-Level subject combination (e.g. PCM, HGE) to a student (by student number) for an academic year. Rejected for students not enrolled in an A-Level class. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
        combinationCode: {
          type: 'string',
          description: 'Combination code, e.g. PCM',
        },
        academicYear: {
          type: 'string',
          description:
            'Academic year name, e.g. "2027" (optional — defaults to the active year)',
        },
      },
      required: ['studentNumber', 'combinationCode'],
    },
    permission: 'academics.combinations.manage',
    argsSchema: z.object({
      studentNumber: z.string().min(3).max(20),
      combinationCode: z.string().min(2).max(10),
      academicYear: z.string().max(20).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveCombinationAssignment(supabase, ctx, args);
      const warnings: string[] = [];
      const { data: enrolment } = await supabase.admin
        .from('class_enrolments')
        .select('status, class_sections(grade_levels(education_level))')
        .eq('tenant_id', ctx.tenantId)
        .eq('student_id', resolved.student.id)
        .eq('academic_year_id', resolved.year.id)
        .eq('status', 'active')
        .maybeSingle();
      const level = (
        enrolment?.class_sections as unknown as {
          grade_levels: { education_level: string } | null;
        } | null
      )?.grade_levels?.education_level;
      if (level !== 'a_level') {
        warnings.push(
          `The student is not actively enrolled in an A-Level class for ${resolved.year.name} — execution will be rejected.`,
        );
      }
      const { data: existing } = await supabase.admin
        .from('student_combinations')
        .select('subject_combinations(code)')
        .eq('tenant_id', ctx.tenantId)
        .eq('student_id', resolved.student.id)
        .eq('academic_year_id', resolved.year.id)
        .maybeSingle();
      const currentCode = (
        existing?.subject_combinations as unknown as { code: string } | null
      )?.code;
      if (currentCode && currentCode !== resolved.combination.code) {
        warnings.push(
          `This REPLACES the student's current combination ${currentCode}.`,
        );
      }
      return {
        title: `Assign combination ${resolved.combination.code}`,
        lines: [
          ['Student', resolved.student.label],
          [
            'Combination',
            `${resolved.combination.code} — ${resolved.combination.name}`,
          ],
          ['Subjects', `${resolved.combination.subjects} (* = subsidiary)`],
          ['Academic year', resolved.year.name],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveCombinationAssignment(supabase, ctx, args);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc(
        'assign_student_combination',
        {
          p_tenant_id: ctx.tenantId,
          p_actor: userId,
          p_student_id: resolved.student.id,
          p_combination_id: resolved.combination.id,
          p_year_id: resolved.year.id,
        },
      );
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { studentCombinationId, combinationCode }
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

  allocateHostelBed: {
    description:
      'PROPOSE allocating a hostel bed to a boarding student (by student number, hostel name and room name). A student with an existing bed is transferred. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
        hostelName: { type: 'string', description: 'e.g. "Bweni A"' },
        roomName: {
          type: 'string',
          description: 'Room within the hostel, e.g. "Room 1"',
        },
        academicYear: {
          type: 'string',
          description:
            'Academic year name, e.g. "2027" (optional — defaults to the active year)',
        },
      },
      required: ['studentNumber', 'hostelName', 'roomName'],
    },
    permission: 'hostel.manage',
    argsSchema: z.object({
      studentNumber: z.string().min(3).max(20),
      hostelName: z.string().min(1).max(80),
      roomName: z.string().min(1).max(40),
      academicYear: z.string().max(20).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveHostelAllocation(supabase, ctx, args);
      const warnings: string[] = [];
      if (resolved.student.boardingStatus !== 'boarding') {
        warnings.push(
          'The student is a DAY student, not a boarder — execution will be rejected.',
        );
      }
      if (
        resolved.hostel.gender !== 'mixed' &&
        resolved.hostel.gender !== resolved.student.gender
      ) {
        warnings.push(
          `Gender mismatch: ${resolved.hostel.name} is a ${resolved.hostel.gender} hostel but the student is ${resolved.student.gender} — execution will be rejected.`,
        );
      }
      if (resolved.room.occupied >= resolved.room.capacity) {
        warnings.push(
          `${resolved.room.name} is full (${resolved.room.occupied}/${resolved.room.capacity} beds) — execution will be rejected.`,
        );
      }
      const { data: existing } = await supabase.admin
        .from('hostel_allocations')
        .select('id, hostel_rooms(name, hostels(name))')
        .eq('tenant_id', ctx.tenantId)
        .eq('student_id', resolved.student.id)
        .eq('academic_year_id', resolved.year.id)
        .is('released_at', null)
        .maybeSingle();
      if (existing) {
        const prevRoom = existing.hostel_rooms as unknown as {
          name: string;
          hostels: { name: string } | null;
        } | null;
        warnings.push(
          `This TRANSFERS the student from ${prevRoom?.hostels?.name ?? '?'} / ${prevRoom?.name ?? '?'}.`,
        );
      }
      return {
        title: 'Allocate hostel bed',
        lines: [
          ['Student', resolved.student.label],
          ['Hostel', `${resolved.hostel.name} (${resolved.hostel.gender})`],
          [
            'Room',
            `${resolved.room.name} — ${resolved.room.occupied}/${resolved.room.capacity} beds occupied`,
          ],
          ['Academic year', resolved.year.name],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveHostelAllocation(supabase, ctx, args);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('allocate_hostel_bed', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_student_id: resolved.student.id,
        p_room_id: resolved.room.id,
        p_year_id: resolved.year.id,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { allocationId, roomId, hostelId, transferredFromRoomId }
    },
  },

  assignTransport: {
    description:
      'PROPOSE assigning a student (by student number) to a school transport route, optionally at a named stop. A student already on a route is moved. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
        routeName: { type: 'string', description: 'e.g. "Njia ya Mbezi"' },
        stopName: {
          type: 'string',
          description: 'Stop on the route (optional)',
        },
        academicYear: {
          type: 'string',
          description:
            'Academic year name, e.g. "2027" (optional — defaults to the active year)',
        },
      },
      required: ['studentNumber', 'routeName'],
    },
    permission: 'transport.manage',
    argsSchema: z.object({
      studentNumber: z.string().min(3).max(20),
      routeName: z.string().min(1).max(80),
      stopName: z.string().max(80).optional(),
      academicYear: z.string().max(20).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveTransportAssignment(supabase, ctx, args);
      const warnings: string[] = [];
      const { data: existing } = await supabase.admin
        .from('transport_assignments')
        .select('id, transport_routes(name)')
        .eq('tenant_id', ctx.tenantId)
        .eq('student_id', resolved.student.id)
        .eq('academic_year_id', resolved.year.id)
        .eq('active', true)
        .maybeSingle();
      const prevRoute = (
        existing?.transport_routes as unknown as { name: string } | null
      )?.name;
      if (prevRoute && prevRoute !== resolved.route.name) {
        warnings.push(`This MOVES the student off route ${prevRoute}.`);
      }
      return {
        title: 'Assign transport route',
        lines: [
          ['Student', resolved.student.label],
          ['Route', resolved.route.name],
          ['Stop', resolved.stop?.name ?? '—'],
          [
            'Route fee',
            `${fmtTZS(resolved.route.feeAmount)} (informational — invoice separately in Finance)`,
          ],
          ['Academic year', resolved.year.name],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveTransportAssignment(supabase, ctx, args);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('assign_transport', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_student_id: resolved.student.id,
        p_route_id: resolved.route.id,
        p_stop_id: resolved.stop?.id ?? null,
        p_year_id: resolved.year.id,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { assignmentId, routeId, stopId, previousRouteId }
    },
  },

  loanBook: {
    description:
      'PROPOSE loaning a library book (by book code) to a student (by student number), with a due date. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        bookCode: { type: 'string', description: 'e.g. "KIS-F1"' },
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
        dueOn: {
          type: 'string',
          description:
            'Due date as YYYY-MM-DD (optional — defaults to 14 days from today)',
        },
      },
      required: ['bookCode', 'studentNumber'],
    },
    permission: 'library.manage',
    argsSchema: z.object({
      bookCode: z.string().min(1).max(40),
      studentNumber: z.string().min(3).max(20),
      dueOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
        .optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveBookLoan(supabase, ctx, args);
      const warnings: string[] = [];
      if (resolved.student.status !== 'active') {
        warnings.push(
          'The student is not active — execution will be rejected.',
        );
      }
      if (resolved.book.available <= 0) {
        warnings.push(
          `No copies of ${resolved.book.title} are available (${resolved.book.copiesTotal} total, all on loan) — execution will be rejected.`,
        );
      }
      const { data: existing } = await supabase.admin
        .from('library_loans')
        .select('id')
        .eq('tenant_id', ctx.tenantId)
        .eq('book_id', resolved.book.id)
        .eq('student_id', resolved.student.id)
        .is('returned_on', null)
        .maybeSingle();
      if (existing) {
        warnings.push(
          'The student already holds an active loan of this book — execution will be rejected.',
        );
      }
      return {
        title: 'Loan library book',
        lines: [
          ['Student', resolved.student.label],
          ['Book', `${resolved.book.title} (${resolved.book.code})`],
          [
            'Copies available',
            `${resolved.book.available} of ${resolved.book.copiesTotal}`,
          ],
          ['Due date', resolved.dueOn],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveBookLoan(supabase, ctx, args);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('loan_book', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_book_id: resolved.book.id,
        p_student_id: resolved.student.id,
        p_due_on: resolved.dueOn,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { loanId, bookId, studentId, dueOn }
    },
  },

  recordClinicVisit: {
    description:
      'PROPOSE recording a clinic (zahanati) visit for a student (by student number) with symptoms, optional treatment and an optional SMS notification to the primary guardian. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
        symptoms: {
          type: 'string',
          description: 'What the student presented with',
        },
        treatment: {
          type: 'string',
          description: 'Treatment given (optional)',
        },
        notify: {
          type: 'boolean',
          description:
            'Send an SMS to the primary guardian after recording (optional, default false)',
        },
      },
      required: ['studentNumber', 'symptoms'],
    },
    permission: 'clinic.manage',
    argsSchema: z.object({
      studentNumber: z.string().min(3).max(20),
      symptoms: z.string().min(2).max(1000),
      treatment: z.string().max(1000).optional(),
      notify: z
        .preprocess((v) => v === true || v === 'true', z.boolean())
        .optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const student = await resolveStudentByNumber(
        supabase,
        ctx,
        args.studentNumber,
      );
      const notify = args.notify === true;
      const warnings: string[] = [];
      if (student.status !== 'active') {
        warnings.push(
          'The student is not active — execution will be rejected.',
        );
      }
      let guardianLine = 'No';
      if (notify) {
        const { data: guardians } = await supabase.admin
          .from('student_guardians')
          .select('is_primary, guardians(full_name, phone)')
          .eq('student_id', student.id)
          .eq('is_primary', true)
          .limit(1);
        const guardian = ((guardians ?? [])[0]?.guardians ??
          null) as unknown as {
          full_name: string;
          phone: string | null;
        } | null;
        if (guardian?.phone) {
          guardianLine = `Yes — ${guardian.full_name} (${guardian.phone})`;
          warnings.push(
            `An SMS WILL be sent to the primary guardian ${guardian.full_name} on confirmation.`,
          );
        } else {
          guardianLine = 'Requested — but no primary guardian with a phone';
          warnings.push(
            'Notification was requested but the student has no primary guardian with a phone number — no SMS will be sent.',
          );
        }
      }
      return {
        title: 'Record clinic visit',
        lines: [
          ['Student', student.label],
          ['Symptoms', String(args.symptoms)],
          ['Treatment', (args.treatment as string | undefined) ?? '—'],
          ['Notify guardian', guardianLine],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const student = await resolveStudentByNumber(
        supabase,
        ctx,
        args.studentNumber,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('record_clinic_visit', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_student_id: student.id,
        p_symptoms: args.symptoms,
        p_treatment: (args.treatment as string | undefined) ?? null,
        p_notes: null,
        p_notify: args.notify === true,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { visitId, notified }
    },
  },

  returnBook: {
    description:
      'PROPOSE returning a library book (kurudisha kitabu, by book code) currently on loan to a student (by student number). Completes the loanBook loop. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        bookCode: { type: 'string', description: 'e.g. "KIS-F1"' },
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
      },
      required: ['bookCode', 'studentNumber'],
    },
    permission: 'library.manage',
    argsSchema: z.object({
      bookCode: z.string().min(1).max(40),
      studentNumber: z.string().min(3).max(20),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveActiveLoan(supabase, ctx, args);
      const today = new Date().toISOString().slice(0, 10);
      const daysLate = Math.max(
        0,
        Math.floor(
          (Date.parse(today) - Date.parse(resolved.loan.dueOn)) /
            (24 * 60 * 60 * 1000),
        ),
      );
      return {
        title: 'Return library book',
        lines: [
          ['Student', resolved.student.label],
          ['Book', `${resolved.book.title} (${resolved.book.code})`],
          ['Loaned on', resolved.loan.loanedOn],
          [
            'Due date',
            daysLate > 0
              ? `${resolved.loan.dueOn} — ${daysLate} day(s) late`
              : resolved.loan.dueOn,
          ],
        ],
        warnings: [],
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveActiveLoan(supabase, ctx, args);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('return_book', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_loan_id: resolved.loan.id,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { returned }
    },
  },

  recordStockMovement: {
    description:
      'PROPOSE recording an inventory (vifaa) stock movement for a store item by name: "in" (receive) or "out" (issue) a quantity, with an optional note. Rejected when issuing more than the current stock. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        itemName: {
          type: 'string',
          description: 'Store item name, e.g. "Chaki"',
        },
        kind: {
          type: 'string',
          enum: ['in', 'out'],
          description: '"in" = stock received, "out" = stock issued',
        },
        quantity: { type: 'number', description: 'Whole units to move' },
        note: { type: 'string', description: 'Reason/reference (optional)' },
      },
      required: ['itemName', 'kind', 'quantity'],
    },
    permission: 'inventory.manage',
    argsSchema: z.object({
      itemName: z.string().min(2).max(120),
      kind: z.enum(['in', 'out']),
      quantity: z.coerce.number().int().min(1).max(1000000),
      note: z.string().max(300).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveInventoryMovement(supabase, ctx, args);
      const after =
        resolved.kind === 'in'
          ? resolved.item.stock + resolved.quantity
          : resolved.item.stock - resolved.quantity;
      const warnings: string[] = [];
      if (resolved.kind === 'out' && resolved.quantity > resolved.item.stock) {
        warnings.push(
          `Only ${resolved.item.stock} ${resolved.item.unit} in stock — execution will be rejected.`,
        );
      } else if (after <= resolved.item.reorderLevel) {
        warnings.push(
          `Stock after this movement (${after} ${resolved.item.unit}) is at or below the reorder level of ${resolved.item.reorderLevel}.`,
        );
      }
      return {
        title: `Record stock ${resolved.kind === 'in' ? 'IN' : 'OUT'}: ${resolved.item.name}`,
        lines: [
          ['Item', `${resolved.item.name} (${resolved.item.unit})`],
          [
            'Movement',
            `${resolved.kind === 'in' ? 'Receive' : 'Issue'} ${resolved.quantity} ${resolved.item.unit}`,
          ],
          ['Current stock', `${resolved.item.stock} ${resolved.item.unit}`],
          ['Stock after', `${after} ${resolved.item.unit}`],
          ...(args.note
            ? ([['Note', args.note as string]] as Array<[string, string]>)
            : []),
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveInventoryMovement(supabase, ctx, args);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('move_inventory', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_item_id: resolved.item.id,
        p_kind: resolved.kind,
        p_quantity: resolved.quantity,
        p_note: (args.note as string | undefined) ?? null,
      });
      if (error) rpcThrow(error);
      return data as Record<string, unknown>; // { movementId, itemId, kind, quantity, stock }
    },
  },

  createAssessment: {
    description:
      'PROPOSE creating a new DRAFT assessment/exam container (mtihani) for a class and term — name, type (test/midterm/terminal/mock/other) and weight only. It does NOT enter marks and can NEVER publish results or change grades; those stay in the app. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'e.g. Form 1' },
        stream: { type: 'string', description: 'e.g. A (optional)' },
        termName: {
          type: 'string',
          description: 'Academic term name, e.g. "Muhula wa Kwanza"',
        },
        name: {
          type: 'string',
          description: 'Assessment name, e.g. "Midterm Exam"',
        },
        type: {
          type: 'string',
          enum: ['test', 'midterm', 'terminal', 'mock', 'other'],
          description: 'Assessment type (optional, default "test")',
        },
        weight: {
          type: 'number',
          description:
            'Relative weight when combining into term results (optional, default 1)',
        },
      },
      required: ['className', 'termName', 'name'],
    },
    permission: 'exams.create',
    argsSchema: z.object({
      className: z.string().min(1).max(40),
      stream: z.string().max(20).optional(),
      termName: z.string().min(1).max(60),
      name: z.string().trim().min(1).max(100),
      type: z.enum(['test', 'midterm', 'terminal', 'mock', 'other']).optional(),
      weight: z.coerce.number().positive().max(10).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveAssessmentTarget(supabase, ctx, args);
      const warnings: string[] = [];
      const { data: duplicate } = await supabase.admin
        .from('assessments')
        .select('id')
        .eq('tenant_id', ctx.tenantId)
        .eq('class_section_id', resolved.section.id)
        .eq('academic_term_id', resolved.term.id)
        .eq('name', args.name as string)
        .maybeSingle();
      if (duplicate) {
        warnings.push(
          `An assessment named "${args.name as string}" already exists for this class and term — execution will be rejected.`,
        );
      }
      return {
        title: `Create assessment "${args.name as string}"`,
        lines: [
          ['Class', resolved.section.label],
          ['Term', resolved.term.name],
          ['Type', (args.type as string | undefined) ?? 'test'],
          ['Weight', String(Number(args.weight ?? 1))],
          [
            'Status',
            'Created as DRAFT — mark entry and publishing stay in the app',
          ],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveAssessmentTarget(supabase, ctx, args);
      // Same direct insert as the assessments controller (no RPC exists);
      // the 0026 term/year trigger and the unique constraint are the DB
      // backstops. status defaults to 'draft' — publishing is hard-blocked.
      const { data, error } = await supabase.admin
        .from('assessments')
        .insert({
          tenant_id: ctx.tenantId,
          class_section_id: resolved.section.id,
          academic_term_id: resolved.term.id,
          name: args.name,
          type: (args.type as string | undefined) ?? 'test',
          weight: Number(args.weight ?? 1),
          created_by: userId,
        })
        .select('id')
        .single();
      if (error) {
        if (error.code === '23505')
          throw new Error('ASSESSMENT_DUPLICATE_NAME');
        rpcThrow(error);
      }
      return { assessmentId: data.id as string, status: 'draft' };
    },
  },

  linkGuardian: {
    description:
      'PROPOSE linking an EXISTING guardian (mzazi/mlezi, found by phone number) to an EXISTING student (by student number) with a relationship. Both must already be in this school — use searchGuardians/searchStudents first; a brand-new guardian is created via createStudent instead. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
        guardianPhone: {
          type: 'string',
          description: 'Exact guardian phone as stored, e.g. 0712345678',
        },
        relationship: {
          type: 'string',
          enum: [...GUARDIAN_RELATIONSHIPS],
          description: 'Optional, default "guardian"',
        },
        isPrimary: {
          type: 'boolean',
          description:
            'Make this the primary guardian for SMS (optional, default false)',
        },
      },
      required: ['studentNumber', 'guardianPhone'],
    },
    permission: 'students.create',
    argsSchema: z.object({
      studentNumber: z.string().min(3).max(20),
      guardianPhone: z.string().min(6).max(30),
      relationship: z.enum(GUARDIAN_RELATIONSHIPS).optional(),
      isPrimary: z
        .preprocess((v) => v === true || v === 'true', z.boolean())
        .optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveGuardianLink(supabase, ctx, args);
      const warnings: string[] = [];
      if (resolved.alreadyLinked) {
        warnings.push(
          'This guardian is already linked to the student — execution will be rejected.',
        );
      }
      if (args.isPrimary === true && resolved.hasPrimary) {
        warnings.push(
          'The student already has a primary guardian — adding a second primary; SMS reminders pick one primary only.',
        );
      }
      return {
        title: 'Link guardian to student',
        lines: [
          ['Student', resolved.student.label],
          [
            'Guardian',
            `${resolved.guardian.name}${resolved.guardian.phone ? ` (${resolved.guardian.phone})` : ''}`,
          ],
          [
            'Relationship',
            (args.relationship as string | undefined) ?? 'guardian',
          ],
          ['Primary contact', args.isPrimary === true ? 'Yes' : 'No'],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      void userId; // link rows carry no actor column; the proposal row is the audit anchor
      const resolved = await resolveGuardianLink(supabase, ctx, args);
      if (resolved.alreadyLinked) throw new Error('GUARDIAN_ALREADY_LINKED');
      // Both sides resolved tenant-scoped above; the 0026 same-tenant trigger
      // on student_guardians is the DB backstop.
      const { error } = await supabase.admin.from('student_guardians').insert({
        student_id: resolved.student.id,
        guardian_id: resolved.guardian.id,
        relationship: (args.relationship as string | undefined) ?? 'guardian',
        is_primary: args.isPrimary === true,
      });
      if (error) {
        if (error.code === '23505') throw new Error('GUARDIAN_ALREADY_LINKED');
        rpcThrow(error);
      }
      return {
        linked: true,
        student: resolved.student.label,
        guardian: resolved.guardian.name,
      };
    },
  },

  setStudentStatus: {
    description:
      "PROPOSE changing a student's lifecycle status (by student number): active, transferred, withdrawn, graduated or archived. NOTHING is deleted — the record and its history stay for audit — but a non-active status closes the pupil's open class enrolment, so they stop being invoiced, stop receiving absence SMS and free a plan seat. Use it when a pupil leaves, transfers to another school or finishes Form 4/6. The user must confirm.",
    parameters: {
      type: 'object',
      properties: {
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
        status: {
          type: 'string',
          enum: [...STUDENT_STATUSES],
          description:
            '"active" restores a pupil to the roster; the other four retire them',
        },
        reason: {
          type: 'string',
          description: 'Why (optional) — stored on the audit trail',
        },
      },
      required: ['studentNumber', 'status'],
    },
    // Route-level key, mirroring PATCH /students/:id/status. The heavier
    // students.archive right is additionally required for every non-active
    // status — checked in preview AND execute (see assertStudentStatusRight).
    permission: 'students.update',
    argsSchema: z.object({
      studentNumber: z.string().min(3).max(20),
      status: z.enum(STUDENT_STATUSES),
      reason: z.string().max(500).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const status = String(args.status);
      assertStudentStatusRight(ctx, status);
      const student = await resolveStudentForLifecycle(
        supabase,
        ctx,
        args.studentNumber,
      );
      const warnings: string[] = [];
      const lines: Array<[string, string]> = [
        ['Student', `${student.fullName} — admission number ${student.number}`],
        ['Current status', student.status],
        ['New status', status],
        ...(args.reason
          ? ([['Reason', args.reason as string]] as Array<[string, string]>)
          : []),
      ];
      if (student.status === status) {
        warnings.push(
          `${student.fullName} is already ${status} — confirming changes nothing.`,
        );
      }

      const { limits, usage } = ctx.entitlements;
      if (status !== 'active') {
        lines.push([
          'What this does',
          `${student.fullName} stops being invoiced, stops receiving absence SMS, and frees one plan seat`,
        ]);
        lines.push([
          'Plan seats',
          limits.students === null
            ? `${usage.students} active students (no seat limit on this plan)`
            : `${usage.students} of ${limits.students} used — this frees one`,
        ]);
        warnings.push(
          `${student.fullName} (${student.number}) comes off the class register: no more fee invoices, no more absence SMS to the guardian, and the plan seat is freed. Nothing is deleted — the record and its history stay for audit.`,
        );
        const { count: openInvoices } = await supabase.admin
          .from('invoices')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', ctx.tenantId)
          .eq('student_id', student.id)
          .in('status', ['issued', 'partially_paid']);
        if ((openInvoices ?? 0) > 0) {
          warnings.push(
            `${openInvoices} unpaid invoice(s) stay on the books — settle or reverse them in Finance separately.`,
          );
        }
      } else if (student.status !== 'active') {
        lines.push([
          'What this does',
          'Puts the pupil back on the roster and re-occupies a plan seat',
        ]);
        warnings.push(
          'Restoring does NOT bring back the old class enrolment — assign a class afterwards.',
        );
        if (limits.students !== null && usage.students + 1 > limits.students) {
          warnings.push(
            `Plan seat limit reached (${usage.students}/${limits.students} students) — free a seat before restoring this pupil.`,
          );
        }
      }
      return { title: `Set student status to ${status}`, lines, warnings };
    },
    execute: async (supabase, ctx, userId, args) => {
      const status = String(args.status);
      // Re-checked here, not just at propose time: the proposal has been at
      // rest and the confirming user's roles may have changed since.
      assertStudentStatusRight(ctx, status);
      const student = await resolveStudentForLifecycle(
        supabase,
        ctx,
        args.studentNumber,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('set_student_status', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_student_id: student.id,
        p_status: status,
        p_reason: (args.reason as string | undefined) ?? null,
      });
      if (error) lifecycleRpcThrow(error);
      return data as Record<string, unknown>; // { studentId, status, changed }
    },
  },

  assignOrTransferClass: {
    description:
      'PROPOSE giving a student a class for an academic year — either their FIRST placement (a pupil imported without a class is invisible to every register, mark sheet and report card) or a correction/transfer to a different class or stream. One enrolment per student per year: this replaces it. The user must confirm.',
    parameters: {
      type: 'object',
      properties: {
        studentNumber: { type: 'string', description: 'e.g. STU-00042' },
        className: {
          type: 'string',
          description: 'Grade/class name, e.g. Form 1',
        },
        stream: {
          type: 'string',
          description:
            'Stream label, e.g. A (optional when the grade has one stream only)',
        },
        academicYear: {
          type: 'string',
          description:
            'Academic year name, e.g. "2027" (optional — defaults to the active year)',
        },
      },
      required: ['studentNumber', 'className'],
    },
    permission: 'students.update',
    argsSchema: z.object({
      studentNumber: z.string().min(3).max(20),
      className: z.string().min(1).max(40),
      stream: z.string().max(20).optional(),
      academicYear: z.string().max(20).optional(),
    }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveClassPlacement(supabase, ctx, args);
      const warnings: string[] = [];
      const currentLabel = resolved.current
        ? `${resolved.current.label}${
            resolved.current.status !== 'active'
              ? ` (${resolved.current.status})`
              : ''
          }`
        : 'Not assigned';
      if (
        resolved.current?.sectionId === resolved.target.id &&
        resolved.current.status === 'active'
      ) {
        warnings.push(
          `${resolved.student.fullName} is already in ${resolved.target.label} — confirming changes nothing.`,
        );
      }
      if (resolved.student.status !== 'active') {
        warnings.push(
          `The pupil is ${resolved.student.status}, not active — set the status back to active first, or they stay off the register anyway.`,
        );
      }
      if (
        resolved.target.capacity !== null &&
        resolved.target.occupancy >= resolved.target.capacity
      ) {
        warnings.push(
          `${resolved.target.label} is already at capacity (${resolved.target.occupancy}/${resolved.target.capacity}) — the placement is still recorded.`,
        );
      }
      return {
        title: resolved.current
          ? 'Transfer student to another class'
          : 'Assign student to a class',
        lines: [
          [
            'Student',
            `${resolved.student.fullName} — admission number ${resolved.student.number}`,
          ],
          ['Academic year', resolved.year.name],
          ['Current class', currentLabel],
          ['New class', resolved.target.label],
          [
            'New class size',
            resolved.target.capacity === null
              ? `${resolved.target.occupancy} enrolled`
              : `${resolved.target.occupancy} of ${resolved.target.capacity} enrolled`,
          ],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveClassPlacement(supabase, ctx, args);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('set_class_enrolment', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_student_id: resolved.student.id,
        p_section_id: resolved.target.id,
        p_year_id: resolved.year.id,
      });
      if (error) lifecycleRpcThrow(error);
      return data as Record<string, unknown>; // { enrolmentId, changed }
    },
  },

  createAcademicYear: {
    description:
      "PROPOSE opening the next academic year: its name, start/end dates, its terms, and optionally a copy of an existing year's class/stream grid so the school does not retype every stream. The year is created as a DRAFT — making it the active year stays in the app. The user must confirm.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Year name, e.g. "2027"' },
        startsOn: { type: 'string', description: 'YYYY-MM-DD' },
        endsOn: { type: 'string', description: 'YYYY-MM-DD' },
        terms: {
          type: 'array',
          description: '1-6 terms, in order',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'e.g. "Muhula wa Kwanza"',
              },
              startsOn: { type: 'string', description: 'YYYY-MM-DD' },
              endsOn: { type: 'string', description: 'YYYY-MM-DD' },
            },
            required: ['name', 'startsOn', 'endsOn'],
          },
        },
        cloneSectionsFromYear: {
          type: 'string',
          description:
            'Name of an existing year whose classes should be copied, e.g. "2026" (optional)',
        },
      },
      required: ['name', 'startsOn', 'endsOn', 'terms'],
    },
    permission: 'academics.manage',
    argsSchema: z
      .object({
        name: z.string().trim().min(1).max(50),
        startsOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
        endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
        cloneSectionsFromYear: z.string().trim().max(50).optional(),
        terms: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(50),
              startsOn: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
              endsOn: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
            }),
          )
          .min(1)
          .max(6),
      })
      .refine((v) => v.endsOn > v.startsOn, {
        message: 'endsOn must be after startsOn',
        path: ['endsOn'],
      })
      .refine((v) => v.terms.every((t) => t.endsOn > t.startsOn), {
        message: 'each term must end after it starts',
        path: ['terms'],
      }),
    preview: async (supabase, ctx, args) => {
      const resolved = await resolveYearCreation(supabase, ctx, args);
      const terms = args.terms as Array<{
        name: string;
        startsOn: string;
        endsOn: string;
      }>;
      const warnings: string[] = [];
      if (resolved.nameTaken) {
        warnings.push(
          `An academic year named "${resolved.name}" already exists — execution will be rejected.`,
        );
      }
      if (resolved.clone && resolved.clone.sections === 0) {
        warnings.push(
          `${resolved.clone.name} has no active classes to copy — the new year would start with none.`,
        );
      }
      if (
        terms.some(
          (t, i) =>
            t.startsOn < String(args.startsOn) ||
            t.endsOn > String(args.endsOn) ||
            (i > 0 && t.startsOn <= terms[i - 1].endsOn),
        )
      ) {
        warnings.push(
          'Term dates overlap each other or fall outside the year — check them before confirming.',
        );
      }
      return {
        title: `Open academic year ${resolved.name}`,
        lines: [
          ['Academic year', resolved.name],
          ['Runs', `${String(args.startsOn)} → ${String(args.endsOn)}`],
          ...terms.map((t, i): [string, string] => [
            `Term ${i + 1} — ${t.name}`,
            `${t.startsOn} → ${t.endsOn}`,
          ]),
          [
            'Classes',
            resolved.clone
              ? `${resolved.clone.sections} section(s) copied from ${resolved.clone.name}`
              : 'None copied — add classes on the Academics page afterwards',
          ],
          [
            'Status',
            'Created as DRAFT — making it the active year stays in the app',
          ],
        ],
        warnings,
      };
    },
    execute: async (supabase, ctx, userId, args) => {
      const resolved = await resolveYearCreation(supabase, ctx, args);
      // No `status` is ever passed: the RPC defaults to 'draft' and activating
      // a year (which closes the current one) is not an AI-reachable act.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.admin.rpc('create_academic_year', {
        p_tenant_id: ctx.tenantId,
        p_actor: userId,
        p_payload: {
          name: resolved.name,
          startsOn: args.startsOn,
          endsOn: args.endsOn,
          terms: args.terms,
          ...(resolved.clone
            ? { cloneSectionsFromYearId: resolved.clone.id }
            : {}),
        },
      });
      if (error) lifecycleRpcThrow(error);
      return data as Record<string, unknown>; // { academicYearId, terms, sectionsCloned }
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
   * claimed atomically so a proposal can only ever execute once.
   *
   * Lifecycle: the row is claimed into 'executing' (resolved_at still null)
   * BEFORE the RPC runs; only AFTER the RPC succeeds is it flipped to
   * 'executed' with the result + resolved_at. On failure it becomes 'failed'.
   * Every lifecycle write and audit insert is error-checked and fails loudly —
   * we never report success for an action whose bookkeeping did not land.
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
    // Atomic claim: flip proposed → executing (NOT executed) so the row is
    // marked in-flight but not yet recorded as done. resolved_at stays null.
    interface ClaimedProposal {
      id: string;
      action_name: string;
      arguments: Record<string, unknown>;
    }
    const claimResult: { data: ClaimedProposal[] | null; error: unknown } =
      await this.supabase.admin
        .from('ai_proposed_actions')
        .update({ status: 'executing' })
        .eq('id', actionId)
        .eq('tenant_id', ctx.tenantId)
        .eq('user_id', userId) // only the proposer may confirm
        .eq('status', 'proposed')
        .gt('expires_at', new Date().toISOString())
        .select('id, action_name, arguments');
    // A DB error on the claim is a distinct 500 — do NOT conflate it with the
    // legitimate "zero rows matched" (already-confirmed/expired) case below.
    if (claimResult.error) {
      throw new Error('CLAIM_FAILED');
    }
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
      const { error: denyError } = await this.supabase.admin
        .from('ai_proposed_actions')
        .update({
          status: 'failed',
          error: 'PERMISSION_DENIED',
          resolved_at: new Date().toISOString(),
        })
        .eq('id', proposal.id);
      if (denyError) {
        throw new Error(
          'LIFECYCLE_WRITE_FAILED: could not mark proposal failed',
        );
      }
      throw new Error('PERMISSION_DENIED');
    }

    try {
      // Re-validate the STORED arguments before executing. Propose-time
      // validation is not enough: the row has been at rest between propose and
      // confirm, so execute must re-derive its inputs from the schema (unknown
      // keys are stripped, types re-checked) rather than trust what it finds.
      // Each action additionally re-resolves every entity tenant-scoped and
      // re-checks any extra right it requires.
      const revalidated = def.argsSchema.safeParse(proposal.arguments);
      if (!revalidated.success) {
        throw new Error(
          `INVALID_ARGUMENTS: ${revalidated.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; ')
            .slice(0, 200)}`,
        );
      }
      const result = await def.execute(
        this.supabase,
        ctx,
        userId,
        revalidated.data,
      );
      // Redact secrets (e.g. one-time invite links) from the AT-REST copy; the
      // FULL result is still returned to the HTTP caller below.
      const stored = def.redactForStorage
        ? def.redactForStorage(result)
        : result;
      // Only NOW — after the RPC succeeded — record the action as executed.
      const { error: doneError } = await this.supabase.admin
        .from('ai_proposed_actions')
        .update({
          status: 'executed',
          result: stored,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', proposal.id);
      if (doneError) {
        throw new Error(
          'LIFECYCLE_WRITE_FAILED: action executed but could not be recorded',
        );
      }
      const { error: auditError } = await this.supabase.admin
        .from('audit_logs')
        .insert({
          tenant_id: ctx.tenantId,
          actor_user_id: userId,
          action: 'ai.action_executed',
          entity_type: 'ai_proposed_action',
          entity_id: proposal.id,
          after: { actionName: proposal.action_name, result: stored },
        });
      if (auditError) {
        throw new Error(
          'AUDIT_WRITE_FAILED: action executed but audit trail missing',
        );
      }
      return { status: 'executed', result };
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      // Bookkeeping-failure codes escape as-is (already logged loudly); they
      // are not RPC/business failures and must not be recorded as 'failed'.
      if (
        message.startsWith('LIFECYCLE_WRITE_FAILED') ||
        message.startsWith('AUDIT_WRITE_FAILED')
      ) {
        throw err;
      }
      const { error: failError } = await this.supabase.admin
        .from('ai_proposed_actions')
        .update({
          status: 'failed',
          error: message,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', proposal.id);
      if (failError) {
        throw new Error(
          'LIFECYCLE_WRITE_FAILED: could not mark proposal failed',
        );
      }
      const { error: auditError } = await this.supabase.admin
        .from('audit_logs')
        .insert({
          tenant_id: ctx.tenantId,
          actor_user_id: userId,
          action: 'ai.action_failed',
          entity_type: 'ai_proposed_action',
          entity_id: proposal.id,
          after: { actionName: proposal.action_name, error: message },
        });
      if (auditError) {
        throw new Error(
          'AUDIT_WRITE_FAILED: action failed but audit trail missing',
        );
      }
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
