-- Enforce every INOX identifier as nine digits displayed as 000-000-000.
-- Existing employee digits are preserved; the current owner receives the
-- reserved administrative sequence beginning at 900-000-001.

update public.employes
set matricule = regexp_replace(
  lpad(regexp_replace(matricule, '[^0-9]', '', 'g'), 9, '0'),
  '^([0-9]{3})([0-9]{3})([0-9]{3})$',
  '\1-\2-\3'
);

alter table public.employes
  drop constraint if exists employes_matricule_check;

alter table public.employes
  add constraint employes_matricule_format_check
  check (matricule ~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}$');

alter table private.admin_members
  add column if not exists matricule text;

with ranked_admins as (
  select
    user_id,
    row_number() over (order by created_at, user_id) as sequence_number
  from private.admin_members
)
update private.admin_members as member
set matricule = regexp_replace(
  (900000000 + ranked.sequence_number)::text,
  '^([0-9]{3})([0-9]{3})([0-9]{3})$',
  '\1-\2-\3'
)
from ranked_admins as ranked
where member.user_id = ranked.user_id
  and (member.matricule is null or member.matricule !~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}$');

update auth.users as auth_user
set raw_app_meta_data = coalesce(auth_user.raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('inox_admin_matricule', member.matricule)
from private.admin_members as member
where member.user_id = auth_user.id
  and auth_user.raw_app_meta_data ->> 'inox_admin_matricule' is distinct from member.matricule;

alter table private.admin_members
  alter column matricule set not null;

alter table private.admin_members
  add constraint admin_members_matricule_format_check
  check (matricule ~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}$');

create unique index if not exists admin_members_matricule_unique_idx
  on private.admin_members (matricule);

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
  if v_role not in ('owner', 'administrator', 'moderator', 'editor', 'viewer') then
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

revoke all on function private.sync_inox_admin_member() from public, anon, authenticated;
grant execute on function private.sync_inox_admin_member() to service_role;
