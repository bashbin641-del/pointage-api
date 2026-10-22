-- Email changes are always completed by the account holder through Supabase Auth.
-- This table stores only the workflow and audit state; confirmation secrets stay in Auth.
create table public.email_change_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  target_user_id uuid not null references auth.users(id) on delete cascade,
  target_entity_id uuid not null,
  target_type text not null check (target_type in ('employee', 'administrator')),
  actor_user_id uuid references auth.users(id) on delete set null,
  old_email text not null,
  new_email text not null,
  status text not null default 'pending_target'
    check (status in ('pending_target', 'awaiting_confirmations', 'confirmed', 'expired', 'cancelled', 'failed')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  initiated_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  failure_reason text,
  updated_at timestamptz not null default now(),
  check (lower(btrim(old_email)) <> lower(btrim(new_email)))
);

create index email_change_requests_target_idx
  on public.email_change_requests (target_user_id, requested_at desc);

create unique index email_change_requests_one_active_target_idx
  on public.email_change_requests (target_user_id)
  where status in ('pending_target', 'awaiting_confirmations');

create unique index email_change_requests_one_active_email_idx
  on public.email_change_requests (lower(btrim(new_email)))
  where status in ('pending_target', 'awaiting_confirmations');

alter table public.email_change_requests enable row level security;
alter table public.email_change_requests force row level security;

revoke all on public.email_change_requests from public, anon, authenticated;
grant select, insert, update, delete on public.email_change_requests to service_role;

create or replace function private.finalize_inox_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.email_change_requests%rowtype;
begin
  if new.email is not distinct from old.email then return new; end if;

  update public.email_change_requests
  set status = 'confirmed', confirmed_at = now(), updated_at = now()
  where target_user_id = new.id
    and lower(btrim(new_email)) = lower(btrim(new.email))
    and status = 'awaiting_confirmations'
  returning * into v_request;

  if found then
    insert into public.journaux_audit(actor_user_id, action, target_type, target_id, details)
    values (
      new.id,
      v_request.target_type || '.email_change_confirmed',
      v_request.target_type,
      v_request.target_entity_id,
      jsonb_build_object('requestId', v_request.id)
    );
  end if;

  -- Email is a login identifier. All refresh sessions are revoked after the
  -- confirmed change; existing short-lived JWTs remain bounded by their expiry.
  delete from auth.sessions where user_id = new.id;
  return new;
end;
$$;

drop trigger if exists finalize_inox_email_change on auth.users;
create trigger finalize_inox_email_change
after update of email on auth.users
for each row execute function private.finalize_inox_email_change();

revoke all on function private.finalize_inox_email_change() from public, anon, authenticated;
