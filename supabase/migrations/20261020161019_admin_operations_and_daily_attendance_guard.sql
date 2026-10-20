-- Destructive administration operations remain explicit in the API, while
-- foreign keys guarantee that no orphaned operational records survive.
alter table public.evenements_pointage
  drop constraint evenements_pointage_employe_id_fkey,
  add constraint evenements_pointage_employe_id_fkey
    foreign key (employe_id) references public.employes(id) on delete cascade;

alter table public.evenements_pointage
  drop constraint evenements_pointage_terminal_id_fkey,
  add constraint evenements_pointage_terminal_id_fkey
    foreign key (terminal_id) references public.terminaux(id) on delete cascade;

alter table public.evenements_pointage
  drop constraint evenements_pointage_site_id_fkey,
  add constraint evenements_pointage_site_id_fkey
    foreign key (site_id) references public.sites(id) on delete cascade;

alter table public.terminaux
  drop constraint terminaux_site_id_fkey,
  add constraint terminaux_site_id_fkey
    foreign key (site_id) references public.sites(id) on delete cascade;

alter table public.employes
  drop constraint employes_auth_user_id_fkey,
  add constraint employes_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users(id) on delete cascade;

-- This expression index supports the daily guard and attendance corrections.
create index if not exists evenements_employe_local_day_type_idx
  on public.evenements_pointage (
    employe_id,
    ((occurred_at at time zone 'Africa/Abidjan')::date),
    event_type
  );

create or replace function private.enforce_daily_attendance_limit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_attendance_day date := (new.occurred_at at time zone 'Africa/Abidjan')::date;
  v_existing_count integer;
begin
  -- Serialize writes for one employee and one local work day. This prevents
  -- two scanners from both passing the count check concurrently.
  perform pg_advisory_xact_lock(
    hashtextextended(new.employe_id::text || ':' || v_attendance_day::text, 0)
  );

  select count(*)::integer
    into v_existing_count
  from public.evenements_pointage event
  where event.employe_id = new.employe_id
    and (event.occurred_at at time zone 'Africa/Abidjan')::date = v_attendance_day
    and event.id <> new.id;

  if v_existing_count >= 2 then
    raise exception using
      errcode = 'P0001',
      message = 'DAILY_ATTENDANCE_LIMIT_REACHED';
  end if;

  if exists (
    select 1
    from public.evenements_pointage event
    where event.employe_id = new.employe_id
      and (event.occurred_at at time zone 'Africa/Abidjan')::date = v_attendance_day
      and event.event_type = new.event_type
      and event.id <> new.id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ATTENDANCE_TYPE_ALREADY_RECORDED';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_daily_attendance_limit on public.evenements_pointage;
create trigger enforce_daily_attendance_limit
before insert or update of employe_id, event_type, occurred_at
on public.evenements_pointage
for each row execute function private.enforce_daily_attendance_limit();

revoke all on function private.enforce_daily_attendance_limit() from public, anon, authenticated;
grant execute on function private.enforce_daily_attendance_limit() to service_role;
