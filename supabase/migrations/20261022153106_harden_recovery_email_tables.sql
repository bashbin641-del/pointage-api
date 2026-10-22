create index recovery_email_proofs_user_idx
  on public.recovery_email_proofs (user_id, purpose, created_at desc);

create policy recovery_email_contacts_server_only
  on public.recovery_email_contacts
  for all to anon, authenticated
  using (false)
  with check (false);

create policy recovery_email_challenges_server_only
  on public.recovery_email_challenges
  for all to anon, authenticated
  using (false)
  with check (false);

create policy recovery_email_proofs_server_only
  on public.recovery_email_proofs
  for all to anon, authenticated
  using (false)
  with check (false);
