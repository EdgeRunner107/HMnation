-- Personal graphs only. This migration does not require goal-progress.sql.
-- Preserve the existing ranking function and the legacy global snapshot.
begin;

do $$
begin
  if to_regclass('public.user_toonation_goal_state') is null then
    -- Inherit the actual users.id type (e.g. bigint or uuid), without copying users.
    create table public.user_toonation_goal_state as
      select id as user_id, 0::bigint as amount, now() as updated_at
      from public.users with no data;

    alter table public.user_toonation_goal_state
      add primary key (user_id),
      add foreign key (user_id) references public.users(id) on delete cascade,
      alter column amount set not null,
      alter column amount set default 0,
      add check (amount >= 0 and amount <= 9007199254740991),
      alter column updated_at set not null,
      alter column updated_at set default now();
  end if;
end;
$$;

alter table public.user_toonation_goal_state enable row level security;
revoke all on table public.user_toonation_goal_state from public, anon, authenticated;
grant select, insert, update on table public.user_toonation_goal_state to service_role;

-- The API resolves login_id to users.id before calling this function.
-- A text parameter supports the existing ID type without assuming bigint/uuid.
-- Sum inside Postgres so REST row limits and the ranking API's limit=6 do not
-- truncate the total. The existing ranking function must honor p_limit.
create or replace function public.get_user_donation_db_total(p_user_id text)
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
  where u.id::text = p_user_id
    and u.is_active is distinct from false;
$$;

revoke all on function public.get_user_donation_db_total(text) from public, anon, authenticated;
grant execute on function public.get_user_donation_db_total(text) to service_role;

notify pgrst, 'reload schema';
commit;
