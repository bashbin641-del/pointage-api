-- Operational foundation for INOX Presence.
-- Business data is exposed to PostgREST only for the server-side service role.
-- Browser roles are explicitly revoked and RLS is forced as defense in depth.

create extension if not exists pgcrypto with schema extensions;

create table public.sites (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  timezone text not null default 'Africa/Abidjan',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index sites_name_unique_idx on public.sites (lower(btrim(name)));

create table public.employes (
  id uuid primary key default extensions.gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete restrict,
  matricule text not null check (char_length(btrim(matricule)) between 2 and 40),
  display_name text not null check (char_length(btrim(display_name)) between 2 and 120),
  site_id uuid references public.sites(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index employes_matricule_unique_idx on public.employes (upper(btrim(matricule)));
create index employes_site_active_idx on public.employes (site_id, active);

create table public.terminaux (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  site_id uuid not null references public.sites(id) on delete restrict,
  active boolean not null default true,
  activation_code_hash text unique,
  activation_expires_at timestamptz,
  session_token_hash text unique,
  session_expires_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((activation_code_hash is null) = (activation_expires_at is null)),
  check ((session_token_hash is null) = (session_expires_at is null))
);

create index terminaux_site_active_idx on public.terminaux (site_id, active);

create table public.evenements_pointage (
  id uuid primary key default extensions.gen_random_uuid(),
  employe_id uuid not null references public.employes(id) on delete restrict,
  terminal_id uuid not null references public.terminaux(id) on delete restrict,
  site_id uuid not null references public.sites(id) on delete restrict,
  event_type text not null check (event_type in ('entree', 'sortie')),
  occurred_at timestamptz not null default now(),
  qr_token_hash text not null unique,
  idempotency_key uuid not null unique,
  created_at timestamptz not null default now()
);

create index evenements_employe_date_idx on public.evenements_pointage (employe_id, occurred_at desc);
create index evenements_site_date_idx on public.evenements_pointage (site_id, occurred_at desc);
create index evenements_terminal_date_idx on public.evenements_pointage (terminal_id, occurred_at desc);

create table public.journaux_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  correlation_id uuid not null default extensions.gen_random_uuid(),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index journaux_audit_created_idx on public.journaux_audit (created_at desc);
create index journaux_audit_actor_idx on public.journaux_audit (actor_user_id, created_at desc);

alter table public.sites enable row level security;
alter table public.sites force row level security;
alter table public.employes enable row level security;
alter table public.employes force row level security;
alter table public.terminaux enable row level security;
alter table public.terminaux force row level security;
alter table public.evenements_pointage enable row level security;
alter table public.evenements_pointage force row level security;
alter table public.journaux_audit enable row level security;
alter table public.journaux_audit force row level security;

revoke all on public.sites, public.employes, public.terminaux,
  public.evenements_pointage, public.journaux_audit from public, anon, authenticated;
revoke all on sequence public.journaux_audit_id_seq from public, anon, authenticated;

grant select, insert, update, delete on public.sites, public.employes,
  public.terminaux, public.evenements_pointage, public.journaux_audit to service_role;
grant usage, select on sequence public.journaux_audit_id_seq to service_role;
