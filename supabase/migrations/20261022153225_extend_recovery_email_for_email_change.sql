alter table public.recovery_email_challenges
  drop constraint recovery_email_challenges_purpose_check;
alter table public.recovery_email_challenges
  add constraint recovery_email_challenges_purpose_check
  check (purpose in ('verify_contact', 'password_reset', 'email_change_recovery', 'email_change_target'));

alter table public.recovery_email_proofs
  drop constraint recovery_email_proofs_purpose_check;
alter table public.recovery_email_proofs
  add constraint recovery_email_proofs_purpose_check
  check (purpose in ('password_reset', 'email_change_recovery', 'email_change_final'));
alter table public.recovery_email_proofs
  add column payload_ciphertext text;

create or replace function public.consume_recovery_email_payload_proof(
  p_user_id uuid,
  p_purpose text,
  p_token_digest text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  proof public.recovery_email_proofs%rowtype;
begin
  select * into proof
  from public.recovery_email_proofs
  where user_id = p_user_id
    and purpose = p_purpose
    and token_digest = p_token_digest
    and consumed_at is null
    and expires_at > now()
  for update;

  if not found or proof.payload_ciphertext is null then
    return null;
  end if;

  update public.recovery_email_proofs set consumed_at = now() where id = proof.id;
  return proof.payload_ciphertext;
end;
$$;

revoke all on function public.consume_recovery_email_payload_proof(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.consume_recovery_email_payload_proof(uuid, text, text)
  to service_role;
