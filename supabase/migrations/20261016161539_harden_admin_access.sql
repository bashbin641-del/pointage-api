-- This DDL event trigger is internal. It must never be callable as a public RPC.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

-- The admin table is not exposed to the Data API and has no user-facing policies.
-- Keep it inaccessible to anon/authenticated even if future grants change.
alter table private.admin_members enable row level security;
