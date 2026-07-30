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
import {
  allocateBedSchema,
  createHostelSchema,
  createRoomSchema,
} from './hostel.schema';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps RPC business exceptions to 400s with a stable code. */
function rpcError(error: { message: string }, known: string[]): never {
  const match = known.find((code) => error.message.includes(code));
  if (match) {
    throw new BadRequestException({ code: match, message: error.message });
  }
  throw new InternalServerErrorException({
    code: 'HOSTEL_RPC_FAILED',
    message: error.message,
  });
}

interface HostelRow {
  id: string;
  name: string;
  gender: string;
  hostel_rooms: Array<{ id: string; name: string; capacity: number }>;
}

interface OccupantRow {
  id: string;
  allocated_at: string;
  students: {
    id: string;
    student_number: string;
    first_name: string;
    last_name: string;
    gender: string;
  } | null;
}

@Controller('hostel')
@UseGuards(AuthGuard, TenantGuard)
export class HostelController {
  constructor(private readonly supabase: SupabaseService) {}

  /** Hostels with rooms, capacity and live occupied counts. */
  @Get()
  @RequirePermission('hostel.view')
  async list(@Req() req: TenantRequest) {
    const [hostels, occupancy] = await Promise.all([
      this.supabase.admin
        .from('hostels')
        .select('id, name, gender, hostel_rooms(id, name, capacity)')
        .eq('tenant_id', req.tenant.tenantId)
        .order('name')
        .limit(200),
      this.supabase.admin.rpc('hostel_occupancy', {
        p_tenant_id: req.tenant.tenantId,
      }),
    ]);
    const err = hostels.error ?? occupancy.error;
    if (err) {
      throw new InternalServerErrorException({
        code: 'HOSTEL_FETCH_FAILED',
        message: err.message,
      });
    }
    const occupied = new Map<string, number>();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const occupancyRows: Array<{ room_id: string; occupied: number }> =
      occupancy.data ?? [];
    for (const o of occupancyRows) {
      occupied.set(o.room_id, Number(o.occupied));
    }
    const rows: HostelRow[] = hostels.data ?? [];
    return {
      data: rows.map((h) => ({
        id: h.id,
        name: h.name,
        gender: h.gender,
        rooms: h.hostel_rooms
          .map((r) => ({
            id: r.id,
            name: r.name,
            capacity: r.capacity,
            occupied: occupied.get(r.id) ?? 0,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      })),
    };
  }

  @Post()
  @RequirePermission('hostel.manage')
  async createHostel(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createHostelSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'HOSTEL_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { data, error } = await this.supabase.admin
      .from('hostels')
      .insert({
        tenant_id: req.tenant.tenantId,
        name: parsed.data.name,
        gender: parsed.data.gender,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({ code: 'HOSTEL_DUPLICATE' });
      }
      throw new InternalServerErrorException({
        code: 'HOSTEL_CREATE_FAILED',
        message: error.message,
      });
    }
    return { hostelId: data.id as string };
  }

  @Post('rooms')
  @RequirePermission('hostel.manage')
  async createRoom(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = createRoomSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'HOSTEL_ROOM_INVALID',
        issues: parsed.error.issues,
      });
    }
    const { data: hostel } = await this.supabase.admin
      .from('hostels')
      .select('id')
      .eq('tenant_id', req.tenant.tenantId)
      .eq('id', parsed.data.hostelId)
      .maybeSingle();
    if (!hostel) {
      throw new BadRequestException({ code: 'HOSTEL_NOT_FOUND' });
    }
    const { data, error } = await this.supabase.admin
      .from('hostel_rooms')
      .insert({
        tenant_id: req.tenant.tenantId,
        hostel_id: parsed.data.hostelId,
        name: parsed.data.name,
        capacity: parsed.data.capacity,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ConflictException({ code: 'HOSTEL_ROOM_DUPLICATE' });
      }
      throw new InternalServerErrorException({
        code: 'HOSTEL_ROOM_CREATE_FAILED',
        message: error.message,
      });
    }
    return { roomId: data.id as string };
  }

  @Post('allocations')
  @RequirePermission('hostel.manage')
  async allocate(@Req() req: TenantRequest, @Body() body: unknown) {
    const parsed = allocateBedSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'HOSTEL_ALLOCATION_INVALID',
        issues: parsed.error.issues,
      });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'allocate_hostel_bed',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_student_id: parsed.data.studentId,
        p_room_id: parsed.data.roomId,
        p_year_id: parsed.data.academicYearId,
      },
    );
    if (error) {
      rpcError(error, [
        'HOSTEL_STUDENT_NOT_FOUND',
        'HOSTEL_NOT_BOARDER',
        'HOSTEL_ROOM_NOT_FOUND',
        'HOSTEL_GENDER_MISMATCH',
        'HOSTEL_YEAR_NOT_FOUND',
        'HOSTEL_ROOM_FULL',
      ]);
    }
    return data as {
      allocationId: string;
      roomId: string;
      hostelId: string;
      transferredFromRoomId: string | null;
    };
  }

  @Post('allocations/:id/release')
  @RequirePermission('hostel.manage')
  async release(@Req() req: TenantRequest, @Param('id') id: string) {
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({ code: 'HOSTEL_ALLOCATION_INVALID' });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { data, error } = await this.supabase.admin.rpc(
      'release_hostel_bed',
      {
        p_tenant_id: req.tenant.tenantId,
        p_actor: req.user.id,
        p_allocation_id: id,
      },
    );
    if (error) {
      rpcError(error, ['HOSTEL_ALLOCATION_NOT_FOUND']);
    }
    return data as { released: boolean };
  }

  /** Active occupants of one room. */
  @Get('rooms/:id/occupants')
  @RequirePermission('hostel.view')
  async occupants(@Req() req: TenantRequest, @Param('id') id: string) {
    if (!UUID_RE.test(id)) {
      throw new BadRequestException({ code: 'HOSTEL_ROOM_INVALID' });
    }
    const { data, error } = await this.supabase.admin
      .from('hostel_allocations')
      .select(
        'id, allocated_at, students(id, student_number, first_name, last_name, gender)',
      )
      .eq('tenant_id', req.tenant.tenantId)
      .eq('room_id', id)
      .is('released_at', null)
      .order('allocated_at')
      .limit(500);
    if (error) {
      throw new InternalServerErrorException({
        code: 'HOSTEL_OCCUPANTS_FAILED',
        message: error.message,
      });
    }
    const rows: OccupantRow[] = (data ?? []) as unknown as OccupantRow[];
    return {
      data: rows.map((a) => ({
        allocationId: a.id,
        studentId: a.students?.id ?? null,
        studentNumber: a.students?.student_number ?? '',
        name: `${a.students?.first_name ?? ''} ${a.students?.last_name ?? ''}`.trim(),
        gender: a.students?.gender ?? '',
        allocatedAt: a.allocated_at,
      })),
    };
  }
}
