import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(
  new URL('../sql/goal-progress.sql', import.meta.url),
  'utf8',
);
let db;

before(async () => {
  db = new PGlite();
  // Isolated SQL fixtures, not the deployed function definition. The extra
  // ranking_hidden rule proves the wrapper delegates filtering to the function.
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.users (
      id bigint primary key,
      is_active boolean,
      ranking_reset_at timestamptz
    );
    create table public.bank_donations (
      id bigint generated always as identity primary key,
      user_id bigint not null,
      donor_name text not null,
      amount bigint not null,
      canceled boolean not null default false,
      executed boolean not null default false,
      created_at timestamptz not null default '2026-09-16T00:00:00Z',
      ranking_hidden boolean not null default false
    );
    create function public.get_current_donation_ranking(
      p_user_id bigint, p_limit integer default 6
    ) returns table(donor_name text, total_amount bigint)
    language sql stable as $$
      select bd.donor_name, sum(bd.amount)::bigint
      from public.bank_donations bd
      join public.users u on u.id = bd.user_id
      where bd.user_id = p_user_id
        and bd.canceled = false
        and bd.ranking_hidden = false
        and (u.ranking_reset_at is null or bd.created_at >= u.ranking_reset_at)
      group by bd.donor_name
      order by sum(bd.amount) desc, bd.donor_name
      limit p_limit;
    $$;
    grant usage on schema public to service_role;
    grant select on public.users, public.bank_donations to service_role;
  `);
  await db.exec(migration);
});

beforeEach(async () => {
  await db.exec(`
    truncate public.users, public.bank_donations, public.toonation_goal_state;
    insert into public.users values
      (1, true, '2026-09-15T00:00:00Z'),
      (2, true, null), (3, false, null), (4, null, null);
    insert into public.bank_donations(user_id, donor_name, amount, executed) values
      (1, 'A', 10000, true), (1, 'B', 20000, false), (2, 'C', 20000, true);
    insert into public.bank_donations(user_id, donor_name, amount, canceled) values
      (1, 'Canceled', 900, true);
    insert into public.bank_donations(user_id, donor_name, amount, created_at) values
      (1, 'Before reset', 3000, '2026-09-14T00:00:00Z');
    insert into public.bank_donations(user_id, donor_name, amount, ranking_hidden) values
      (1, 'Excluded by existing function', 1100, true);
    insert into public.bank_donations(user_id, donor_name, amount) values
      (3, 'Inactive user', 6000);
  `);
});

after(async () => {
  await db?.close();
});

async function total() {
  const { rows } = await db.query(
    'select public.get_donation_db_total() as amount',
  );
  return Number(rows[0].amount);
}

test('SQL wrapper reuses ranking filters across users and reflects cancellation/reset', async () => {
  assert.equal(await total(), 50000);
  await db.exec(
    "update public.bank_donations set canceled = true where donor_name = 'A'",
  );
  assert.equal(await total(), 40000);
  await db.exec(
    "update public.users set ranking_reset_at = '2026-09-17T00:00:00Z' where id = 1",
  );
  assert.equal(await total(), 20000);
  await db.exec('update public.users set is_active = false where id = 2');
  assert.equal(await total(), 0);
  await db.exec(
    "insert into public.bank_donations(user_id, donor_name, amount) values (4, 'Null active flag', 100)",
  );
  assert.equal(await total(), 100);
});

test('SQL aggregation includes over 1000 donors rather than only the first six ranks', async () => {
  await db.exec(`
    insert into public.bank_donations(user_id, donor_name, amount)
    select 1, 'Donor ' || n, 10 from generate_series(1, 1500) as n;
  `);
  assert.equal(await total(), 65000);
  const { rows } = await db.query(
    'select * from public.get_current_donation_ranking(1, 6)',
  );
  assert.equal(rows.length, 6);
  assert.ok(
    rows.reduce((sum, row) => sum + Number(row.total_amount), 0) < 65000,
  );
});

test('SQL singleton upsert replaces snapshots, preserves timestamps and rejects invalid rows', async () => {
  for (const amount of [11900, 11900, 16900, 21900, 0]) {
    await db.query(
      `
      insert into public.toonation_goal_state(id, amount)
      values (1, $1)
      on conflict (id) do update set amount = excluded.amount, updated_at = now()
    `,
      [amount],
    );
    const { rows } = await db.query(
      'select * from public.toonation_goal_state',
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].amount), amount);
    assert.ok(Number.isFinite(Date.parse(rows[0].updated_at)));
  }
  await assert.rejects(
    db.query(
      'insert into public.toonation_goal_state(id, amount) values (2, 100)',
    ),
  );
  await assert.rejects(
    db.query('update public.toonation_goal_state set amount = -1'),
  );
  await assert.rejects(
    db.query(
      'update public.toonation_goal_state set amount = 9007199254740992',
    ),
  );
});

test('SQL can be rerun without changing ranking definition, donations or stored amount', async () => {
  const { rows: before } = await db.query(
    "select pg_get_functiondef('public.get_current_donation_ranking(bigint,integer)'::regprocedure) as definition",
  );
  await db.exec(
    'insert into public.toonation_goal_state(id, amount) values (1, 11900)',
  );
  await db.exec(migration);
  const { rows: after } = await db.query(
    "select pg_get_functiondef('public.get_current_donation_ranking(bigint,integer)'::regprocedure) as definition",
  );
  assert.deepEqual(after, before);
  assert.equal(await total(), 50000);
  const { rows } = await db.query(
    'select amount from public.toonation_goal_state',
  );
  assert.equal(Number(rows[0].amount), 11900);
});

test('SQL state and aggregate allow the service role but deny direct public access', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(
        db.query('select * from public.toonation_goal_state'),
        /permission denied/,
      );
      await assert.rejects(
        db.query('select public.get_donation_db_total()'),
        /permission denied/,
      );
    } finally {
      await db.exec('reset role');
    }
  }
  await db.exec('set role service_role');
  try {
    assert.equal(await total(), 50000);
    await db.exec(
      'insert into public.toonation_goal_state(id, amount) values (1, 11900)',
    );
    const { rows } = await db.query(
      'select amount from public.toonation_goal_state',
    );
    assert.equal(Number(rows[0].amount), 11900);
  } finally {
    await db.exec('reset role');
  }
});
