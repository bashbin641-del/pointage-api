-- Verified recovery email channel. Raw addresses and verification codes are
-- encrypted or keyed by the API before they reach Postgres.

create table public.recovery_email_contacts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_ciphertext text not null,
  email_hash text not null unique,
  email_masked text not null,
  verified_at timestamptz not null,
  available_after timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recovery_email_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('verify_contact', 'password_reset')),
  destination_ciphertext text not null,
  destination_hash text not null,
  code_digest text not null,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.recovery_email_proofs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('password_reset')),
  token_digest text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index recovery_email_challenges_user_purpose_idx
  on public.recovery_email_challenges (user_id, purpose, created_at desc);
create index recovery_email_challenges_expiry_idx
  on public.recovery_email_challenges (expires_at)
  where consumed_at is null;
create index recovery_email_proofs_expiry_idx
  on public.recovery_email_proofs (expires_at)
  where consumed_at is null;

create or replace function public.consume_recovery_email_challenge(
  p_id uuid,
  p_user_id uuid,
  p_purpose text,
  p_code_digest text
)
returns table(status text, destination_ciphertext text, destination_hash text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  challenge public.recovery_email_challenges%rowtype;
begin
  select * into challenge
  from public.recovery_email_challenges
  where id = p_id and user_id = p_user_id and purpose = p_purpose
  for update;

  if not found then
    return query select 'invalid'::text, null::text, null::text;
    return;
  end if;
  if challenge.consumed_at is not null then
    return query select 'used'::text, null::text, null::text;
    return;
  end if;
  if challenge.expires_at <= now() then
    return query select 'expired'::text, null::text, null::text;
    return;
  end if;
  if challenge.attempts >= 5 then
    return query select 'locked'::text, null::text, null::text;
    return;
  end if;
  if challenge.code_digest <> p_code_digest then
    update public.recovery_email_challenges
    set attempts = least(attempts + 1, 5)
    where id = challenge.id;
    return query select
      case when challenge.attempts + 1 >= 5 then 'locked' else 'invalid' end::text,
      null::text,
      null::text;
    return;
  end if;

  update public.recovery_email_challenges
  set consumed_at = now()
  where id = challenge.id;
  return query select 'verified'::text, challenge.destination_ciphertext, challenge.destination_hash;
end;
$$;

create or replace function public.consume_recovery_email_proof(
  p_user_id uuid,
  p_purpose text,
  p_token_digest text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  proof_id uuid;
begin
  select id into proof_id
  from public.recovery_email_proofs
  where user_id = p_user_id
    and purpose = p_purpose
    and token_digest = p_token_digest
    and consumed_at is null
    and expires_at > now()
  for update;

  if proof_id is null then
    return false;
  end if;

  update public.recovery_email_proofs set consumed_at = now() where id = proof_id;
  return true;
end;
$$;

alter table public.recovery_email_contacts enable row level security;
alter table public.recovery_email_contacts force row level security;
alter table public.recovery_email_challenges enable row level security;
alter table public.recovery_email_challenges force row level security;
alter table public.recovery_email_proofs enable row level security;
alter table public.recovery_email_proofs force row level security;

revoke all on public.recovery_email_contacts,
  public.recovery_email_challenges,
  public.recovery_email_proofs from public, anon, authenticated;
grant all on public.recovery_email_contacts,
  public.recovery_email_challenges,
  public.recovery_email_proofs to service_role;
revoke all on function public.consume_recovery_email_challenge(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.consume_recovery_email_proof(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.consume_recovery_email_challenge(uuid, uuid, text, text)
  to service_role;
grant execute on function public.consume_recovery_email_proof(uuid, text, text)
  to service_role;

comment on table public.recovery_email_contacts is
  'Server-only verified recovery channels. Email values are AES-256-GCM encrypted by the API.';
comment on table public.recovery_email_challenges is
  'Short-lived keyed verification challenges. Codes are never stored in plaintext.';
comment on table public.recovery_email_proofs is
  'Five-minute, single-use proof tokens authorizing one sensitive recovery action.';
