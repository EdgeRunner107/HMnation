-- Run once in the Supabase SQL editor before deploying the new endpoints.
-- Existing users, bank_donations and ranking functions are left unchanged.
begin;

create table if not exists public.toonation_goal_state (
  id smallint primary key default 1 check (id = 1),
  amount bigint not null default 0
    check (amount >= 0 and amount <= 9007199254740991),
  updated_at timestamptz not null default now()
);

alter table public.toonation_goal_state enable row level security;
revoke all on table public.toonation_goal_state from public, anon, authenticated;
grant select, insert, update on table public.toonation_goal_state to service_role;

-- The same function that powers /api/u/:login_id/ranking calculates each user.
-- Its cancellation/reset/grouping rules remain the single source of truth.
-- Request all ranks rather than the HTTP endpoint's default 6 / maximum 100.
-- p_limit is assumed to be an ordinary row limit, without an internal hard cap.
create or replace function public.get_donation_db_total()
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(r.total_amount), 0)::bigint
  from public.users as u
  cross join lateral public.get_current_donation_ranking(
    p_user_id => u.id,
    p_limit => 2147483647
  ) as r
  where u.is_active is distinct from false;
$$;

revoke all on function public.get_donation_db_total() from public, anon, authenticated;
grant execute on function public.get_donation_db_total() to service_role;

notify pgrst, 'reload schema';
commit;
