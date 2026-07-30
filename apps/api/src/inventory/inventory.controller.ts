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
import { createItemSchema, moveInventorySchema } from './inventory.schema';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'INVENTORY_RPC_FAILED',
    message: error.message,
  });
}

interface ItemRow {
  id: string;
  name: string;
  unit: string;
  reorder_level: number;
}

interface MovementRow {
  id: string;
  kind: string;
  quantity: number;
  note: string | null;
  moved_on: string;
  created_at: string;
}

@Controller('inventory')
@UseGuards(AuthGuard, TenantGuard)
export class InventoryController {
  constructor(private readonly supabase: SupabaseService) {}

  /** Items with computed stock (sum in - sum out) and a low-stock flag. */
  @Get()
  @RequirePermission('inventory.view')
  async list(@Req() req: TenantRequest) {
    const [items, levels] = await Promise.all([
      this.supabase.admin
        .from('inventory_items')
        .select('id, name, unit, reorder_level')
        .eq('tenant_id', req.tenant.tenantId)
        .order('name')
        .limit(1000),
      this.supabase.admin.rpc('inventory_stock_levels', {
        p_tenant_id: req.tenant.tenantId,
      }),
    ]);
    const err = items.error ?? levels.error;
    if (err) {
      throw new InternalServerErrorException({
        code: 'INVENTORY_FETCH_FAILED',
        message: err.message,
      });
    }
    const stock = new Map<string, number>();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const levelRows: Array<{ item_id: string; stock: number }> =
      levels.data ?? [];
    for (const l of levelRows) {
      stock.set(l.item_id, Number(l.stock));
    }
    const rows: ItemRow[] = items.data ?? [];
    return {
      data: rows.map((i) => ({
        id: i.id,
        name: i.name,
        unit: i.unit,
        reorderLevel: i.reorder_level,
        stock: stock.get(i.id) ?? 0,
        lowStock: (stock.get(i.id) ?? 0) <= i.reorder_level,
      })),
    };
  }

  @Post('items')
  @RequirePermission('inventory.manage')
  async createItem(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createItemSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVENTORY_ITEM_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { data, error } = await this.supabase.admin
      .from('inventory_items')
      .insert({
        tenant_id: req.tenant.tenantId,
        name: parsed.data.name,
        unit: parsed.data.unit,
        reorder_level: parsed.data.reorderLevel,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({ code: 'INVENTORY_ITEM_DUPLICATE' });
      }
      throw new InternalServerErrorException({
        code: 'INVENTORY_ITEM_CREATE_FAILED',
        message: error.message,
      });
    }
    return { itemId: data.id as string };
  }

  @Post('movements')
  @RequirePermission('inventory.manage')
  async move(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = moveInventorySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'INVENTORY_MOVEMENT_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc('move_inventory', {
      p_tenant_id: req.tenant.tenantId,
      p_actor: req.user.id,
      p_item_id: parsed.data.itemId,
      p_kind: parsed.data.kind,
      p_quantity: parsed.data.quantity,
      p_note: parsed.data.note ?? null,
    });
    if (error) {
      rpcError(error, [
        'INVENTORY_ITEM_NOT_FOUND',
        'INVENTORY_KIND_INVALID',
        'INVENTORY_QUANTITY_INVALID',
        'INVENTORY_INSUFFICIENT',
      ]);
    }
    return data as {
      movementId: string;
      itemId: string;
      kind: string;
      quantity: number;
      stock: number;
    };
  }

  /** Movement history of one item, newest first. */
  @Get('items/:id/movements')
  @RequirePermission('inventory.view')
  async movements(@Req() req: TenantRequest, @Param('id') id: string) {
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({ code: 'INVENTORY_ITEM_INVALID' });
    }
    const { data, error } = await this.supabase.admin
      .from('inventory_movements')
      .select('id, kind, quantity, note, moved_on, created_at')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('item_id', id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      throw new InternalServerErrorException({
        code: 'INVENTORY_MOVEMENTS_FAILED',
        message: error.message,
      });
    }
    const rows: MovementRow[] = data ?? [];
    return {
      data: rows.map((m) => ({
        id: m.id,
        kind: m.kind,
        quantity: m.quantity,
        note: m.note,
        movedOn: m.moved_on,
      })),
    };
  }
}
