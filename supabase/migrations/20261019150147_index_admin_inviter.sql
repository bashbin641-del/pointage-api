create index if not exists admin_members_invited_by_idx
  on private.admin_members (invited_by_user_id)
  where invited_by_user_id is not null;
