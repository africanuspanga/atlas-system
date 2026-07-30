import {
  BadRequestException,
  Body,
  Controller,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { TenantGuard, RequirePermission } from '../tenancy/tenant.guard';
import type { TenantRequest } from '../tenancy/tenant.guard';
import { SupabaseService } from '../supabase/supabase.service';
import {
  createFeeItemSchema,
  createInvoiceSchema,
  debtorsQuerySchema,
  recordPaymentSchema,
  reversePaymentSchema,
  setInstalmentsSchema,
} from './finance.schema';

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'FINANCE_RPC_FAILED',
    message: error.message,
  });
}

@Controller('finance')
@UseGuards(AuthGuard, TenantGuard)
export class FinanceController {
  constructor(private readonly supabase: SupabaseService) {}

  @Post('fee-items')
  @RequirePermission('finance.invoices.create')
  async createFeeItem(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createFeeItemSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'FEE_ITEM_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { data: year } = await this.supabase.admin
      .from('academic_years')
      .select('id')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('status', 'active')
      .order('starts_on', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!year) {
      throw new BadRequestException({ code: 'FEE_ITEM_NO_ACTIVE_YEAR' });
    }
    if (parsed.data.gradeLevelId) {
      const { data: gradeLevel } = await this.supabase.admin
        .from('grade_levels')
        .select('id')
        .eq('id', parsed.data.gradeLevelId)
        .eq('tenant_id', req.tenant.tenantId)
        .maybeSingle();
      if (!gradeLevel) {
        throw new BadRequestException({ code: 'FEE_ITEM_GRADE_NOT_FOUND' });
      }
    }
    if (parsed.data.academicTermId) {
      const { data: term } = await this.supabase.admin
        .from('academic_terms')
        .select('id')
        .eq('id', parsed.data.academicTermId)
        .eq('tenant_id', req.tenant.tenantId)
        .eq('academic_year_id', year.id)
        .maybeSingle();
      if (!term) {
        throw new BadRequestException({ code: 'FEE_ITEM_TERM_NOT_FOUND' });
      }
    }
    const { data, error } = await this.supabase.admin
      .from('fee_items')
      .insert({
        tenant_id: req.tenant.tenantId,
        academic_year_id: year.id,
        grade_level_id: parsed.data.gradeLevelId ?? null,
        academic_term_id: parsed.data.academicTermId ?? null,
        name: parsed.data.name,
        amount: parsed.data.amount,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new BadRequestException({ code: 'FEE_ITEM_DUPLICATE_NAME' });
      }
      throw new InternalServerErrorException({
        code: 'FEE_ITEM_CREATE_FAILED',
        message: error.message,
      });
    }
    return { feeItemId: data.id as string };
  }

  @Post('invoices')
  @RequirePermission('finance.invoices.create')
  async createInvoice(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createInvoiceSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVOICE_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('create_invoice', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_student_id: parsed.data.studentId,
      p_term_id: parsed.data.academicTermId ?? null,
      p_due_on: parsed.data.dueOn ?? null,
      p_lines: parsed.data.lines,
    });
    if (error) {
      rpcError(error, [
        'INVOICE_STUDENT_NOT_FOUND',
        'INVOICE_TERM_NOT_FOUND',
        'INVOICE_NO_ACTIVE_YEAR',
        'INVOICE_FEE_ITEM_NOT_FOUND',
        'INVOICE_BAD_LINE',
        'INVOICE_EMPTY',
      ]);
    }
    return data as { invoiceId: string; invoiceNumber: string; total: number };
  }

  /** Queues one SMS per unpaid invoice to the primary guardian (deduped). */
  @Post('reminders')
  @RequirePermission('finance.invoices.create')
  async sendReminders(@Req() req: TenantRequest) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'queue_fee_reminders',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
      },
    );
    if (error) {
      throw new InternalServerErrorException({
        code: 'REMINDERS_FAILED',
        message: error.message,
      });
    }
    return data as { queued: number };
  }

  /** Replaces the instalment plan for an invoice (max 6, sums to total). */
  @Post('invoices/:id/instalments')
  @RequirePermission('finance.invoices.create')
  async setInstalments(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = setInstalmentsSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INSTALMENTS_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'set_invoice_instalments',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_invoice_id: id,
        p_rows: parsed.data.rows,
      },
    );
    if (error) {
      rpcError(error, [
        'INSTALMENTS_INVOICE_NOT_FOUND',
        'INSTALMENTS_INVOICE_PAID',
        'INSTALMENTS_BAD_ROWS',
        'INSTALMENTS_SUM_MISMATCH',
        'INSTALMENTS_DATES_INVALID',
      ]);
    }
    return data as { invoiceId: string; instalments: number; total: number };
  }

  /** Instalment schedule with the paid amount waterfalled across seq. */
  @Get('invoices/:id/instalments')
  @RequirePermission('finance.invoices.view')
  async getInstalments(@Req() req: TenantRequest, @Param('id') id: string) {
    const {
      data: invoice,
      error,
    }: {
      data: {
        id: string;
        total: number;
        status: string;
        invoice_instalments: Array<{
          seq: number;
          amount: number;
          due_on: string;
        }>;
        payments: Array<{ amount: number }>;
      } | null;
      error: { message: string } | null;
    } = await this.supabase.admin
      .from('invoices')
      .select(
        'id, total, status, invoice_instalments(seq, amount, due_on), payments(amount)',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .eq('id', id)
      .maybeSingle();
    // Distinguish a genuine miss (404) from a transient DB error (500) so a
    // flaky read never masquerades as "invoice not found".
    if (error) {
      throw new InternalServerErrorException({
        code: 'INSTALMENTS_LOOKUP_FAILED',
      });
    }
    if (!invoice) {
      throw new NotFoundException({ code: 'INSTALMENTS_INVOICE_NOT_FOUND' });
    }
    const paid = (invoice.payments ?? []).reduce(
      (sum, p) => sum + Number(p.amount),
      0,
    );
    const today = new Date().toISOString().slice(0, 10);
    let remaining = paid;
    let dueSeen = false;
    const rows = (invoice.invoice_instalments ?? [])
      .sort((a, b) => a.seq - b.seq)
      .map((row) => {
        const amount = Number(row.amount);
        const rowPaid = Math.min(Math.max(remaining, 0), amount);
        remaining -= rowPaid;
        let state: 'paid' | 'overdue' | 'due' | 'upcoming';
        if (rowPaid >= amount) {
          state = 'paid';
        } else if (row.due_on < today) {
          state = 'overdue';
        } else if (!dueSeen) {
          state = 'due';
          dueSeen = true;
        } else {
          state = 'upcoming';
        }
        return {
          seq: row.seq,
          amount,
          dueOn: row.due_on,
          paid: rowPaid,
          balance: amount - rowPaid,
          state,
        };
      });
    return {
      invoiceId: invoice.id,
      total: Number(invoice.total),
      paid,
      rows,
    };
  }

  /** Ledger-reconciled trial balance — raises REPORT_RECONCILE_FAILED on mismatch. */
  @Get('trial-balance')
  @RequirePermission('finance.reports.view')
  async trialBalance(@Req() req: TenantRequest) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'report_trial_balance',
      { p_tenant_id: req.tenant.tenantId },
    );
    if (error) {
      rpcError(error, ['REPORT_RECONCILE_FAILED']);
    }
    return data as {
      rows: Array<{
        code: string;
        name: string;
        type: string;
        debits: number;
        credits: number;
        balance: number;
      }>;
      totals: { debits: number; credits: number };
      generatedAt: string;
    };
  }

  /** Debtors (wadaiwa) as of a date, grouped by class section. */
  @Get('debtors')
  @RequirePermission('finance.debtors.view')
  async debtors(@Req() req: TenantRequest, @Query() query: unknown) {
    const parsed = debtorsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'DEBTORS_QUERY_INVALID',
        issues: parsed.error.issues,
      });
    }
    const asOf = parsed.data.asOf ?? new Date().toISOString().slice(0, 10);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('report_debtors', {
      p_tenant_id: req.tenant.tenantId,
      p_as_of: asOf,
    });
    if (error) {
      rpcError(error, ['REPORT_BAD_DATE', 'REPORT_RECONCILE_FAILED']);
    }
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
      totals: { outstanding: number; overdue: number; ledgerAR: number };
      generatedAt: string;
    };
    const byClass = new Map<string, typeof payload.rows>();
    for (const row of payload.rows) {
      const rows = byClass.get(row.className) ?? [];
      rows.push(row);
      byClass.set(row.className, rows);
    }
    return {
      asOf,
      generatedAt: payload.generatedAt,
      totals: payload.totals,
      classes: [...byClass.entries()].map(([className, rows]) => ({
        className,
        rows,
        subtotal: {
          balance: rows.reduce((sum, r) => sum + Number(r.balance), 0),
          overdue: rows.reduce((sum, r) => sum + Number(r.overdue), 0),
        },
      })),
    };
  }

  @Post('invoices/:id/payments')
  @RequirePermission('finance.payments.receive')
  async recordPayment(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = recordPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'PAYMENT_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('record_payment', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_invoice_id: id,
      p_amount: parsed.data.amount,
      p_method: parsed.data.method,
      p_reference: parsed.data.reference ?? null,
      p_paid_on: parsed.data.paidOn ?? null,
    });
    if (error) {
      rpcError(error, [
        'PAYMENT_INVOICE_NOT_FOUND',
        'PAYMENT_BAD_AMOUNT',
        'PAYMENT_EXCEEDS_BALANCE',
      ]);
    }
    return data as {
      paymentId: string;
      receiptNumber: string;
      balance: number;
    };
  }

  @Post('payments/:id/reverse')
  @RequirePermission('finance.refunds.approve')
  async reversePayment(
    @Req() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = reversePaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'REVERSAL_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('reverse_payment', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_payment_id: id,
      p_reason: parsed.data.reason,
    });
    if (error) {
      if (error.message.includes('payments_one_reversal_idx')) {
        throw new BadRequestException({
          code: 'REVERSAL_ALREADY_REVERSED',
          message: error.message,
        });
      }
      rpcError(error, [
        'REVERSAL_PAYMENT_NOT_FOUND',
        'REVERSAL_OF_REVERSAL',
        'REVERSAL_ALREADY_REVERSED',
      ]);
    }
    return data as { reversalId: string; receiptNumber: string };
  }
}
