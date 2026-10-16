-- INOX Présence: les secrets TOTP restent dans Supabase Auth.
-- Cette table ne contient que l'identité métier et l'état d'accès.
create schema if not exists private;

create table if not exists private.admin_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null check (role in ('owner', 'administrator', 'moderator', 'editor', 'viewer')),
  active boolean not null default false,
  invited_by_user_id uuid references private.admin_members(user_id) on delete set null,
  invited_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_members_active_role_idx on private.admin_members(active, role);

create or replace function private.sync_inox_admin_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := new.raw_app_meta_data ->> 'inox_admin_role';
  v_active boolean := coalesce((new.raw_app_meta_data ->> 'inox_admin_active')::boolean, false);
  v_name text := nullif(btrim(new.raw_app_meta_data ->> 'inox_admin_display_name'), '');
  v_invited_by uuid;
begin
  if v_role is null then return new; end if;
  if v_role not in ('owner', 'administrator', 'moderator', 'editor', 'viewer') then
    raise exception 'INVALID_INOX_ADMIN_ROLE';
  end if;
  if (new.raw_app_meta_data ->> 'inox_admin_invited_by') ~* '^[0-9a-f-]{36}$' then
    v_invited_by := (new.raw_app_meta_data ->> 'inox_admin_invited_by')::uuid;
  end if;
  insert into private.admin_members(user_id, display_name, role, active, invited_by_user_id, invited_at, activated_at)
  values (new.id, left(coalesce(v_name, split_part(coalesce(new.email, 'Membre INOX'), '@', 1)), 100), v_role, v_active, v_invited_by,
    case when v_invited_by is not null then now() end, case when new.last_sign_in_at is not null then new.last_sign_in_at end)
  on conflict (user_id) do update set
    display_name = excluded.display_name, role = excluded.role, active = excluded.active,
    invited_by_user_id = coalesce(private.admin_members.invited_by_user_id, excluded.invited_by_user_id),
    invited_at = coalesce(private.admin_members.invited_at, excluded.invited_at),
    activated_at = coalesce(private.admin_members.activated_at, excluded.activated_at), updated_at = now();
  return new;
end;
$$;

drop trigger if exists sync_inox_admin_member on auth.users;
create trigger sync_inox_admin_member after insert or update of raw_app_meta_data, last_sign_in_at on auth.users
for each row execute function private.sync_inox_admin_member();

revoke all on private.admin_members from public, anon, authenticated;
revoke all on function private.sync_inox_admin_member() from public, anon, authenticated;
grant execute on function private.sync_inox_admin_member() to service_role;
