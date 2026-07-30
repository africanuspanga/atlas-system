-- ATLAS migration 0022 — inventory (ghala/vifaa) module.
--
-- The school store tracks uniforms, exercise books, chalk and other supplies.
-- inventory_items is the catalogue; inventory_movements is an append-only
-- in/out journal. The stock level is ALWAYS computed as sum(in) - sum(out) —
-- there is no stored balance to drift. Writes go through app.move_inventory
-- only.
--
-- NOTE (v1): issuing stock to a student ('out' movement) does NOT invoice the
-- student. Selling items (uniforms, books) bills through the finance module
-- (invoices/ledger) separately in a later version — every money movement must
-- post a balanced journal entry there.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  unit text not null default 'pcs',
  reorder_level int not null default 0 check (reorder_level >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create index inventory_items_tenant_idx on public.inventory_items (tenant_id);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  item_id uuid not null references public.inventory_items(id),
  kind text not null check (kind in ('in','out')),
  quantity int not null check (quantity > 0),
  note text,
  moved_on date not null default current_date,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index inventory_movements_tenant_idx on public.inventory_movements (tenant_id);
create index inventory_movements_item_idx
  on public.inventory_movements (item_id, created_at desc);

-- RLS: members read; all writes via the API (service role).
alter table public.inventory_items enable row level security;
alter table public.inventory_movements enable row level security;

create policy "members read inventory items" on public.inventory_items
  for select using (app.is_tenant_member(tenant_id));
create policy "members read inventory movements" on public.inventory_movements
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Record a stock movement. For 'out' the current stock (sum in - sum out)
-- must cover the quantity. The item row is locked to serialise concurrent
-- stock checks — two simultaneous issues can never oversell.
-- ---------------------------------------------------------------------------
create or replace function app.move_inventory(
  p_tenant_id uuid, p_actor uuid, p_item_id uuid,
  p_kind text, p_quantity int, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
  v_stock int;
  v_movement_id uuid;
begin
  if p_kind is null or p_kind not in ('in','out') then
    raise exception 'INVENTORY_KIND_INVALID';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVENTORY_QUANTITY_INVALID';
  end if;

  -- lock the item row: concurrent movements serialise on the stock check
  select * into v_item from public.inventory_items
  where id = p_item_id and tenant_id = p_tenant_id
  for update;
  if v_item.id is null then
    raise exception 'INVENTORY_ITEM_NOT_FOUND';
  end if;

  select coalesce(sum(case when kind = 'in' then quantity else -quantity end), 0)::int
  into v_stock
  from public.inventory_movements
  where item_id = p_item_id;

  if p_kind = 'out' and v_stock < p_quantity then
    raise exception 'INVENTORY_INSUFFICIENT';
  end if;

  insert into public.inventory_movements
    (tenant_id, item_id, kind, quantity, note, created_by)
  values (p_tenant_id, p_item_id, p_kind, p_quantity, nullif(trim(p_note), ''), p_actor)
  returning id into v_movement_id;

  v_stock := v_stock + case when p_kind = 'in' then p_quantity else -p_quantity end;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'inventory.moved', 'inventory_movement',
          v_movement_id::text,
          jsonb_build_object('itemId', p_item_id, 'itemName', v_item.name,
                             'kind', p_kind, 'quantity', p_quantity,
                             'stockAfter', v_stock));

  return jsonb_build_object(
    'movementId', v_movement_id,
    'itemId', p_item_id,
    'kind', p_kind,
    'quantity', p_quantity,
    'stock', v_stock
  );
end;
$$;

-- Public wrapper — service role only (PostgREST exposes only public schema).
create or replace function public.move_inventory(
  p_tenant_id uuid, p_actor uuid, p_item_id uuid,
  p_kind text, p_quantity int, p_note text
)
returns jsonb language sql security definer set search_path = public
as $$ select app.move_inventory(p_tenant_id, p_actor, p_item_id, p_kind, p_quantity, p_note); $$;

revoke execute on function app.move_inventory(uuid, uuid, uuid, text, int, text) from public, anon, authenticated;
revoke execute on function public.move_inventory(uuid, uuid, uuid, text, int, text) from public, anon, authenticated;
grant execute on function public.move_inventory(uuid, uuid, uuid, text, int, text) to service_role;

-- ---------------------------------------------------------------------------
-- Current stock per item, computed in SQL over ALL movements. The API used to
-- sum movement rows in JS, which the Supabase 1000-row read cap silently
-- truncated → wrong stock levels for busy items. Aggregating here is exact and
-- unbounded. Returns one row per item that has any movement.
-- ---------------------------------------------------------------------------
create or replace function app.inventory_stock_levels(p_tenant_id uuid)
returns table (item_id uuid, stock int)
language sql
stable
security definer
set search_path = public
as $$
  select item_id,
         coalesce(sum(case when kind = 'in' then quantity else -quantity end), 0)::int
  from public.inventory_movements
  where tenant_id = p_tenant_id
  group by item_id;
$$;

create or replace function public.inventory_stock_levels(p_tenant_id uuid)
returns table (item_id uuid, stock int)
language sql security definer set search_path = public
as $$ select * from app.inventory_stock_levels(p_tenant_id); $$;

revoke execute on function app.inventory_stock_levels(uuid) from public, anon, authenticated;
revoke execute on function public.inventory_stock_levels(uuid) from public, anon, authenticated;
grant execute on function public.inventory_stock_levels(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions (keys BEFORE role_permissions — FK). Mirrored in seed.sql.
-- school_owner/director are superusers in the API guard and need no rows.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('inventory.view',   'inventory', 'View inventory items and stock levels'),
  ('inventory.manage', 'inventory', 'Manage inventory items and stock movements')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'head_teacher' then array['inventory.view']
  when 'school_admin' then array['inventory.view', 'inventory.manage']
  when 'bursar'       then array['inventory.view', 'inventory.manage']
  when 'accountant'   then array['inventory.view']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
