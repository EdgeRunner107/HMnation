import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../sql/user-goal-progress.sql', import.meta.url), 'utf8');
const legacyMigration = await readFile(new URL('../sql/goal-progress.sql', import.meta.url), 'utf8');
let db;

async function createFixture(database, idType = 'bigint') {
  // A test-only ranking definition, including an extra exclusion rule to prove
  // that the new aggregate delegates to ranking instead of duplicating filters.
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.users (
      id ${idType} primary key, login_id text unique,
      is_active boolean, ranking_reset_at timestamptz
    );
    create table public.bank_donations (
      user_id ${idType} not null, donor_name text not null, amount bigint not null,
      canceled boolean not null default false,
      created_at timestamptz not null default '2026-09-16T00:00:00Z',
      ranking_hidden boolean not null default false
    );
    create function public.get_current_donation_ranking(
      p_user_id ${idType}, p_limit integer default 6
    ) returns table(donor_name text, total_amount bigint)
    language sql stable as $$
      select bd.donor_name, sum(bd.amount)::bigint
      from public.bank_donations bd join public.users u on u.id = bd.user_id
      where bd.user_id = p_user_id and not bd.canceled and not bd.ranking_hidden
        and (u.ranking_reset_at is null or bd.created_at >= u.ranking_reset_at)
      group by bd.donor_name order by sum(bd.amount) desc, bd.donor_name
      limit p_limit;
    $$;
    grant usage on schema public to service_role;
    grant select on public.users, public.bank_donations to service_role;
  `);
}

before(async () => {
  db = new PGlite();
  await createFixture(db);
  await db.exec(legacyMigration);
  await db.exec(migration);
});

beforeEach(async () => {
  await db.exec(`
    truncate public.user_toonation_goal_state, public.toonation_goal_state,
      public.bank_donations, public.users;
    insert into public.users values
      (1, 'testuser', true, '2026-09-15T00:00:00Z'),
      (2, 'user2', true, null), (3, 'inactive', false, null), (4, 'empty', null, null);
    insert into public.bank_donations(user_id, donor_name, amount) values
      (1, 'A', 10000), (1, 'B', 20000), (1, 'B', 5000), (2, 'A', 9000), (3, 'C', 6000);
    insert into public.bank_donations(user_id, donor_name, amount, canceled) values
      (1, 'Canceled', 1000, true);
    insert into public.bank_donations(user_id, donor_name, amount, ranking_hidden) values
      (1, 'Excluded by ranking', 2000, true);
    insert into public.bank_donations(user_id, donor_name, amount, created_at) values
      (1, 'Before reset', 3000, '2026-09-14T00:00:00Z');
    insert into public.toonation_goal_state(id, amount) values (1, 999999);
  `);
});

after(async () => { await db?.close(); });

async function total(id, database = db) {
  const { rows } = await database.query(
    'select public.get_user_donation_db_total($1) as amount', [String(id)],
  );
  return Number(rows[0].amount);
}

test('personal SQL: scopes the full ranking to one ID and honors cancellation/reset', async () => {
  assert.equal(await total(1), 35000);
  assert.equal(await total(2), 9000);
  assert.equal(await total(3), 0);
  assert.equal(await total(4), 0);
  assert.equal(await total(999), 0);
  await db.exec("update public.bank_donations set canceled = true where user_id = 1 and donor_name = 'A'");
  assert.equal(await total(1), 25000);
  assert.equal(await total(2), 9000);
  await db.exec("update public.users set ranking_reset_at = '2026-09-17T00:00:00Z' where id = 1");
  assert.equal(await total(1), 0);
  assert.equal(await total(2), 9000);
});

test('personal SQL: includes more than 1000 donors without adding other users', async () => {
  await db.exec(`
    insert into public.bank_donations(user_id, donor_name, amount)
    select 1, 'Donor ' || n, 10 from generate_series(1, 1500) as n;
  `);
  assert.equal(await total(1), 50000);
  assert.equal(await total(2), 9000);
});

test('personal SQL: upsert and constraints keep user snapshots separate', async () => {
  await db.exec('insert into public.user_toonation_goal_state(user_id, amount) values (2, 25000)');
  for (const amount of [11900, 11900, 21900, 7000, 0]) {
    await db.query(`
      insert into public.user_toonation_goal_state(user_id, amount) values (1, $1)
      on conflict (user_id) do update set amount = excluded.amount, updated_at = now()
    `, [amount]);
    const { rows } = await db.query('select * from public.user_toonation_goal_state order by user_id');
    assert.equal(rows.length, 2);
    assert.equal(Number(rows[0].amount), amount);
    assert.equal(Number(rows[1].amount), 25000);
    assert.ok(Number.isFinite(Date.parse(rows[0].updated_at)));
  }
  for (const statement of [
    'insert into public.user_toonation_goal_state(user_id, amount) values (999, 1)',
    'update public.user_toonation_goal_state set amount = -1 where user_id = 1',
    'update public.user_toonation_goal_state set amount = 9007199254740992 where user_id = 1',
    'update public.user_toonation_goal_state set amount = null where user_id = 1',
    'update public.user_toonation_goal_state set updated_at = null where user_id = 1',
  ]) {
    await assert.rejects(db.exec(statement));
  }
  await db.exec("update public.users set login_id = 'renamed' where id = 2");
  const { rows } = await db.query('select amount from public.user_toonation_goal_state where user_id = 2');
  assert.equal(Number(rows[0].amount), 25000);
  await db.exec('delete from public.users where id = 2');
  assert.equal((await db.query('select * from public.user_toonation_goal_state where user_id = 2')).rows.length, 0);
});

test('personal SQL: rerun preserves ranking, users, donations and both kinds of snapshots', async () => {
  await db.exec('insert into public.user_toonation_goal_state(user_id, amount) values (1, 11900)');
  const queries = [
    "select pg_get_functiondef('public.get_current_donation_ranking(bigint,integer)'::regprocedure) as definition",
    'select * from public.users order by id',
    'select * from public.bank_donations order by user_id, donor_name',
    'select * from public.toonation_goal_state',
    'select * from public.user_toonation_goal_state',
  ];
  const before = await Promise.all(queries.map((query) => db.query(query)));
  await db.exec(migration);
  const after = await Promise.all(queries.map((query) => db.query(query)));
  assert.deepEqual(after.map((result) => result.rows), before.map((result) => result.rows));
});

test('personal SQL: service role can access state and totals; public roles cannot', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(db.query('select * from public.user_toonation_goal_state'), /permission denied/);
      await assert.rejects(total(1), /permission denied/);
      await assert.rejects(db.exec('insert into public.user_toonation_goal_state(user_id, amount) values (1, 11900)'), /permission denied/);
    } finally {
      await db.exec('reset role');
    }
  }
  await db.exec('set role service_role');
  try {
    assert.equal(await total(1), 35000);
    await db.exec('insert into public.user_toonation_goal_state(user_id, amount) values (1, 11900)');
    assert.equal(Number((await db.query('select amount from public.user_toonation_goal_state')).rows[0].amount), 11900);
  } finally {
    await db.exec('reset role');
  }
});

test('personal SQL: inherits UUID users.id and works without the legacy global migration', async () => {
  const uuidDb = new PGlite();
  try {
    await createFixture(uuidDb, 'uuid');
    await uuidDb.exec(migration);
    const id = '8686e010-68ba-499b-80a1-a3e8b7f8c845';
    await uuidDb.query('insert into public.users(id, login_id, is_active) values ($1, $2, true)', [id, 'uuid-user']);
    await uuidDb.query("insert into public.bank_donations(user_id, donor_name, amount) values ($1, 'A', 50000)", [id]);
    await uuidDb.query('insert into public.user_toonation_goal_state(user_id, amount) values ($1, 11900)', [id]);
    assert.equal(await total(id, uuidDb), 50000);
    assert.equal((await uuidDb.query('select user_id from public.user_toonation_goal_state')).rows[0].user_id, id);
  } finally {
    await uuidDb.close();
  }
});
