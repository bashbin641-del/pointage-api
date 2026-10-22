create index if not exists email_change_requests_actor_idx
  on public.email_change_requests (actor_user_id, requested_at desc);
