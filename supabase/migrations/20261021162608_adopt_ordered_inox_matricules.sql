-- Replace the historical numeric matricules with stable INOX identifiers.
-- Sequences are scoped by entity type and hiring year. They deliberately do
-- not use a permanent sequence table: after a definitive deletion, the first
-- free number can be attributed again by the API.

drop trigger if exists sync_inox_admin_member on auth.users;

alter table public.employes
  add column if not exists hired_at date;

alter table private.admin_members
  add column if not exists hired_at date;

update public.employes
set hired_at = (created_at at time zone 'Africa/Abidjan')::date
where hired_at is null;

update private.admin_members
set hired_at = (created_at at time zone 'Africa/Abidjan')::date
where hired_at is null;

alter table public.employes
  alter column hired_at set default current_date,
  alter column hired_at set not null,
  drop constraint if exists employes_matricule_format_check;

alter table private.admin_members
  alter column hired_at set default current_date,
  alter column hired_at set not null,
  drop constraint if exists admin_members_matricule_format_check;

with ordered_employees as (
  select
    id,
    extract(year from hired_at)::integer as hiring_year,
    row_number() over (
      partition by extract(year from hired_at)
      order by created_at, id
    ) as sequence_number
  from public.employes
)
update public.employes as employee
set matricule = 'INOX-EMP-'
  || ordered.hiring_year::text
  || '-'
  || lpad(ordered.sequence_number::text, 4, '0')
from ordered_employees as ordered
where employee.id = ordered.id;

with ordered_administrators as (
  select
    user_id,
    extract(year from hired_at)::integer as hiring_year,
    row_number() over (
      partition by extract(year from hired_at)
      order by (role = 'owner') desc, created_at, user_id
    ) as sequence_number
  from private.admin_members
)
update private.admin_members as member
set matricule = 'INOX-ADMIN-'
  || ordered.hiring_year::text
  || '-'
  || lpad(ordered.sequence_number::text, 4, '0'),
  updated_at = now()
from ordered_administrators as ordered
where member.user_id = ordered.user_id;

update auth.users as auth_user
set raw_app_meta_data = coalesce(auth_user.raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object(
    'inox_admin_matricule', member.matricule,
    'inox_admin_hired_at', to_char(member.hired_at, 'YYYY-MM-DD')
  )
from private.admin_members as member
where member.user_id = auth_user.id;

alter table public.employes
  add constraint employes_matricule_format_check
  check (
    matricule ~ '^INOX-EMP-[0-9]{4}-[0-9]{4}$'
    and matricule !~ '-0000$'
    and substring(matricule from 10 for 4)::integer = extract(year from hired_at)::integer
  ),
  add constraint employes_hired_at_check
  check (hired_at >= date '1900-01-01' and hired_at <= current_date);

alter table private.admin_members
  add constraint admin_members_matricule_format_check
  check (
    matricule ~ '^INOX-ADMIN-[0-9]{4}-[0-9]{4}$'
    and matricule !~ '-0000$'
    and substring(matricule from 12 for 4)::integer = extract(year from hired_at)::integer
  ),
  add constraint admin_members_hired_at_check
  check (hired_at >= date '1900-01-01' and hired_at <= current_date);

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
  v_matricule text := upper(nullif(btrim(new.raw_app_meta_data ->> 'inox_admin_matricule'), ''));
  v_hired_at date;
  v_invited_by uuid;
begin
  if v_role is null then return new; end if;
  if v_role not in ('owner', 'administrator', 'maintainer') then
    raise exception 'INVALID_INOX_ADMIN_ROLE';
  end if;
  if (new.raw_app_meta_data ->> 'inox_admin_hired_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    v_hired_at := (new.raw_app_meta_data ->> 'inox_admin_hired_at')::date;
  else
    select member.hired_at into v_hired_at
    from private.admin_members as member
    where member.user_id = new.id;
  end if;
  v_hired_at := coalesce(v_hired_at, (new.created_at at time zone 'Africa/Abidjan')::date);
  if v_hired_at < date '1900-01-01' or v_hired_at > current_date then
    raise exception 'INVALID_INOX_ADMIN_HIRING_DATE';
  end if;
  if v_matricule is null
    or v_matricule !~ '^INOX-ADMIN-[0-9]{4}-[0-9]{4}$'
    or v_matricule ~ '-0000$'
    or substring(v_matricule from 12 for 4)::integer <> extract(year from v_hired_at)::integer
  then
    raise exception 'INVALID_INOX_ADMIN_MATRICULE';
  end if;
  if (new.raw_app_meta_data ->> 'inox_admin_invited_by') ~* '^[0-9a-f-]{36}$' then
    v_invited_by := (new.raw_app_meta_data ->> 'inox_admin_invited_by')::uuid;
  end if;
  insert into private.admin_members(user_id, matricule, hired_at, display_name, role, active, invited_by_user_id, invited_at, activated_at)
  values (
    new.id,
    v_matricule,
    v_hired_at,
    left(coalesce(v_name, split_part(coalesce(new.email, 'Membre INOX'), '@', 1)), 100),
    v_role,
    v_active,
    v_invited_by,
    case when v_invited_by is not null then now() end,
    case when new.last_sign_in_at is not null then new.last_sign_in_at end
  )
  on conflict (user_id) do update set
    matricule = excluded.matricule,
    hired_at = excluded.hired_at,
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
