import {
  BadRequestException,
  Body,
  Controller,
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
import {
  createFeeItemSchema,
  createInvoiceSchema,
  recordPaymentSchema,
  reversePaymentSchema,
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
    const { data, error } = await this.supabase.admin.rpc('queue_fee_reminders', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
    });
    if (error) {
      throw new InternalServerErrorException({
        code: 'REMINDERS_FAILED',
        message: error.message,
      });
    }
    return data as { queued: number };
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
    return data as { paymentId: string; receiptNumber: string; balance: number };
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
      rpcError(error, [
        'REVERSAL_PAYMENT_NOT_FOUND',
        'REVERSAL_OF_REVERSAL',
        'REVERSAL_ALREADY_REVERSED',
      ]);
    }
    return data as { reversalId: string; receiptNumber: string };
  }
}
