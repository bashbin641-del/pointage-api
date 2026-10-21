-- INOX Présence now exposes three administrative roles only:
-- owner (protected), administrator (account management) and maintainer
-- (operational management). Historical lower-privilege roles are migrated to
-- maintainer so no existing account loses operational access unexpectedly.

drop trigger if exists sync_inox_admin_member on auth.users;

alter table private.admin_members
  drop constraint if exists admin_members_role_check;

update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('inox_admin_role', 'maintainer')
where raw_app_meta_data ->> 'inox_admin_role' in ('moderator', 'editor', 'viewer');

update private.admin_members
set role = 'maintainer', updated_at = now()
where role in ('moderator', 'editor', 'viewer');

alter table private.admin_members
  add constraint admin_members_role_check
  check (role in ('owner', 'administrator', 'maintainer'));

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
  v_matricule text := nullif(btrim(new.raw_app_meta_data ->> 'inox_admin_matricule'), '');
  v_invited_by uuid;
begin
  if v_role is null then return new; end if;
  if v_role not in ('owner', 'administrator', 'maintainer') then
    raise exception 'INVALID_INOX_ADMIN_ROLE';
  end if;
  if v_matricule is null or v_matricule !~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}$' then
    raise exception 'INVALID_INOX_ADMIN_MATRICULE';
  end if;
  if (new.raw_app_meta_data ->> 'inox_admin_invited_by') ~* '^[0-9a-f-]{36}$' then
    v_invited_by := (new.raw_app_meta_data ->> 'inox_admin_invited_by')::uuid;
  end if;
  insert into private.admin_members(user_id, matricule, display_name, role, active, invited_by_user_id, invited_at, activated_at)
  values (
    new.id,
    v_matricule,
    left(coalesce(v_name, split_part(coalesce(new.email, 'Membre INOX'), '@', 1)), 100),
    v_role,
    v_active,
    v_invited_by,
    case when v_invited_by is not null then now() end,
    case when new.last_sign_in_at is not null then new.last_sign_in_at end
  )
  on conflict (user_id) do update set
    matricule = excluded.matricule,
    display_name = excluded.display_name,
    role = excluded.role,
    active = excluded.active,
    invited_by_user_id = coalesce(private.admin_members.invited_by_user_id, excluded.invited_by_user_id),
    invited_at = coalesce(private.admin_members.invited_at, excluded.invited_at),
    activated_at = coalesce(private.admin_members.activated_at, excluded.activated_at),
    updated_at = now();
  return new;
end;
$$;

create trigger sync_inox_admin_member
after insert or update of raw_app_meta_data, last_sign_in_at on auth.users
for each row execute function private.sync_inox_admin_member();

revoke all on function private.sync_inox_admin_member() from public, anon, authenticated;
grant execute on function private.sync_inox_admin_member() to service_role;
