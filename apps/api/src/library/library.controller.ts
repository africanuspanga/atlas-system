import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  InternalServerErrorException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import { createBookSchema, loanBookSchema } from './library.schema';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'LIBRARY_RPC_FAILED',
    message: error.message,
  });
}

interface BookRow {
  id: string;
  code: string;
  title: string;
  author: string | null;
  copies_total: number;
  subjects: { id: string; name: string } | null;
}

interface LoanStudent {
  id: string;
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
}

interface OverdueRow {
  id: string;
  loaned_on: string;
  due_on: string;
  library_books: { code: string; title: string } | null;
  students: LoanStudent | null;
}

interface BookLoanRow {
  id: string;
  loaned_on: string;
  due_on: string;
  students: {
    id: string;
    student_number: string;
    first_name: string;
    last_name: string;
  } | null;
}

function classNameOf(student: LoanStudent | null): string | null {
  const enrolment = (student?.class_enrolments ?? []).find(
    (e) => e.status === 'active',
  );
  return enrolment?.class_sections
    ? `${enrolment.class_sections.grade_levels?.name ?? ''} ${enrolment.class_sections.name}`.trim()
    : null;
}

@Controller('library')
@UseGuards(AuthGuard, TenantGuard)
export class LibraryController {
  constructor(private readonly supabase: SupabaseService) {}

  /** Catalogue with live available-copy counts. */
  @Get()
  @RequirePermission('library.view')
  async list(@Req() req: TenantRequest) {
    const [books, loans] = await Promise.all([
      this.supabase.admin
        .from('library_books')
        .select('id, code, title, author, copies_total, subjects(id, name)')
        .eq('tenant_id', req.tenant.tenantId)
        .order('code')
        .limit(1000),
      this.supabase.admin
        .from('library_loans')
        .select('book_id')
        .eq('tenant_id', req.tenant.tenantId)
        .is('returned_on', null)
        .limit(10000),
    ]);
    const err = books.error ?? loans.error;
    if (err) {
      throw new InternalServerErrorException({
        code: 'LIBRARY_FETCH_FAILED',
        message: err.message,
      });
    }
    const loaned = new Map<string, number>();
    for (const l of loans.data ?? []) {
      const bookId = l.book_id as string;
      loaned.set(bookId, (loaned.get(bookId) ?? 0) + 1);
    }
    const rows: BookRow[] = (books.data ?? []) as unknown as BookRow[];
    return {
      data: rows.map((b) => ({
        id: b.id,
        code: b.code,
        title: b.title,
        author: b.author,
        subject: b.subjects?.name ?? null,
        copiesTotal: b.copies_total,
        activeLoans: loaned.get(b.id) ?? 0,
        available: b.copies_total - (loaned.get(b.id) ?? 0),
      })),
    };
  }

  @Post('books')
  @RequirePermission('library.manage')
  async createBook(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createBookSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'LIBRARY_BOOK_INVALID',
        issues: parsed.error.issues,
      });
    }
    if (parsed.data.subjectId) {
      const { data: subject } = await this.supabase.admin
        .from('subjects')
        .select('id')
        .eq('tenant_id', req.tenant.tenantId)
        .eq('id', parsed.data.subjectId)
        .maybeSingle();
      if (!subject) {
        throw new BadRequestException({ code: 'LIBRARY_SUBJECT_NOT_FOUND' });
      }
    }
    const { data, error } = await this.supabase.admin
      .from('library_books')
      .insert({
        tenant_id: req.tenant.tenantId,
        code: parsed.data.code.toUpperCase(),
        title: parsed.data.title,
        author: parsed.data.author ?? null,
        subject_id: parsed.data.subjectId ?? null,
        copies_total: parsed.data.copiesTotal,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({ code: 'LIBRARY_BOOK_DUPLICATE' });
      }
      throw new InternalServerErrorException({
        code: 'LIBRARY_BOOK_CREATE_FAILED',
        message: error.message,
      });
    }
    return { bookId: data.id as string };
  }

  @Post('loans')
  @RequirePermission('library.manage')
  async loan(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = loanBookSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'LIBRARY_LOAN_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('loan_book', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_book_id: parsed.data.bookId,
      p_student_id: parsed.data.studentId,
      p_due_on: parsed.data.dueOn,
    });
    if (error) {
      rpcError(error, [
        'LIBRARY_BOOK_NOT_FOUND',
        'LIBRARY_STUDENT_NOT_FOUND',
        'LIBRARY_ALREADY_LOANED',
        'LIBRARY_NO_COPIES',
      ]);
    }
    return data as {
      loanId: string;
      bookId: string;
      studentId: string;
      dueOn: string;
    };
  }

  @Post('loans/:id/return')
  @RequirePermission('library.manage')
  async returnBook(@Req() req: TenantRequest, @Param('id') id: string) {
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({ code: 'LIBRARY_LOAN_INVALID' });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('return_book', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_loan_id: id,
    });
    if (error) {
      rpcError(error, ['LIBRARY_LOAN_NOT_FOUND']);
    }
    return data as { returned: boolean };
  }

  /** Active loans past their due date, with student and class. */
  @Get('overdue')
  @RequirePermission('library.view')
  async overdue(@Req() req: TenantRequest) {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await this.supabase.admin
      .from('library_loans')
      .select(
        `id, loaned_on, due_on, library_books(code, title),
         students(id, student_number, first_name, last_name,
                  class_enrolments(status, class_sections(name, grade_levels(name))))`,
      )
      .eq('tenant_id', req.tenant.tenantId)
      .is('returned_on', null)
      .lt('due_on', today)
      .order('due_on')
      .limit(1000);
    if (error) {
      throw new InternalServerErrorException({
        code: 'LIBRARY_OVERDUE_FAILED',
        message: error.message,
      });
    }
    const rows: OverdueRow[] = (data ?? []) as unknown as OverdueRow[];
    const msPerDay = 24 * 60 * 60 * 1000;
    return {
      data: rows.map((l) => ({
        loanId: l.id,
        bookCode: l.library_books?.code ?? '',
        bookTitle: l.library_books?.title ?? '',
        studentId: l.students?.id ?? null,
        studentNumber: l.students?.student_number ?? '',
        studentName:
          `${l.students?.first_name ?? ''} ${l.students?.last_name ?? ''}`.trim(),
        className: classNameOf(l.students),
        loanedOn: l.loaned_on,
        dueOn: l.due_on,
        daysLate: Math.max(
          0,
          Math.floor((Date.parse(today) - Date.parse(l.due_on)) / msPerDay),
        ),
      })),
    };
  }

  /** Active loans of one book (mirrors hostel room occupants). */
  @Get('books/:id/loans')
  @RequirePermission('library.view')
  async bookLoans(@Req() req: TenantRequest, @Param('id') id: string) {
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({ code: 'LIBRARY_BOOK_INVALID' });
    }
    const { data, error } = await this.supabase.admin
      .from('library_loans')
      .select(
        'id, loaned_on, due_on, students(id, student_number, first_name, last_name)',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .eq('book_id', id)
      .is('returned_on', null)
      .order('loaned_on')
      .limit(500);
    if (error) {
      throw new InternalServerErrorException({
        code: 'LIBRARY_LOANS_FAILED',
        message: error.message,
      });
    }
    const rows: BookLoanRow[] = (data ?? []) as unknown as BookLoanRow[];
    return {
      data: rows.map((l) => ({
        loanId: l.id,
        studentId: l.students?.id ?? null,
        studentNumber: l.students?.student_number ?? '',
        studentName:
          `${l.students?.first_name ?? ''} ${l.students?.last_name ?? ''}`.trim(),
        loanedOn: l.loaned_on,
        dueOn: l.due_on,
      })),
    };
  }
}
