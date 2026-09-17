import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import express from "express";

// Exercise the real Express routes and Supabase client against a local REST fixture.
// No production credentials or database are used.
let apiServer;
let databaseServer;
let apiBase;
let users;
let donations;
let calls;
let failRequest;
let beforeWrite;
let rankingResult;
let goalDbTotal;
let toonGoalState;
let userGoalDbTotals;
let userToonGoalStates;

function seed() {
  users = [
    {
      id: 1,
      login_id: "testuser",
      password: "test-password",
      is_active: true,
      ranking_reset_at: null,
    },
    { id: 2, login_id: "SA58PARA", is_active: true },
    { id: 3, login_id: "inactive", is_active: false },
  ];
  donations = [
    {
      id: 101,
      user_id: 1,
      donor_name: "완료후원",
      amount: 10000,
      text: "응원",
      executed: true,
      canceled: false,
      created_at: "2026-09-15T01:00:00Z",
      executed_at: "2026-09-15T01:01:00Z",
    },
    {
      id: 102,
      user_id: 1,
      donor_name: "대기후원",
      amount: 2000,
      text: "안녕",
      executed: false,
      canceled: false,
      created_at: "2026-09-15T02:00:00Z",
      executed_at: null,
    },
    {
      id: 103,
      user_id: 1,
      donor_name: "개인입금",
      amount: 50000,
      text: "",
      executed: false,
      canceled: true,
      created_at: "2026-09-15T00:00:00Z",
      executed_at: null,
    },
    {
      id: 201,
      user_id: 2,
      donor_name: "다른사용자",
      amount: 9000,
      text: "",
      executed: true,
      canceled: false,
      created_at: "2026-09-14T00:00:00Z",
      executed_at: "2026-09-14T00:01:00Z",
    },
  ];
  calls = [];
  failRequest = null;
  beforeWrite = null;
  rankingResult = [];
  goalDbTotal = "50000";
  toonGoalState = null;
  userGoalDbTotals = new Map([["1", "50000"], ["2", "9000"]]);
  userToonGoalStates = new Map();
}

before(async () => {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
  const database = express();
  database.use(express.json());
  database.use("/rest/v1", (req, res) => {
    const call = {
      method: req.method,
      path: req.path,
      query: { ...req.query },
      body: req.body,
    };
    calls.push(call);
    const failure = failRequest?.(call);
    if (failure) {
      return res
        .status(typeof failure === "object" ? failure.status ?? 500 : 500)
        .json(
          typeof failure === "object"
            ? failure.body ?? { message: "Test database failure" }
            : { message: "Test database failure" },
        );
    }
    if (req.path === "/rpc/get_current_donation_ranking") {
      return res.json(rankingResult);
    }
    if (req.path === "/rpc/get_donation_db_total") {
      return res.json(goalDbTotal);
    }
    if (req.path === "/rpc/get_user_donation_db_total") {
      assert.equal(typeof req.body.p_user_id, "string");
      return res.json(userGoalDbTotals.get(req.body.p_user_id) ?? "0");
    }
    if (req.path === "/user_toonation_goal_state") {
      if (req.method === "POST") {
        assert.equal(req.query.on_conflict, "user_id");
        assert.ok(req.headers.prefer.includes("resolution=merge-duplicates"));
        const snapshot = { ...req.body };
        userToonGoalStates.set(String(snapshot.user_id), snapshot);
        return res.json(snapshot);
      }
      assert.equal(req.method, "GET");
      assert.ok(req.query.user_id.startsWith("eq."));
      const snapshot = userToonGoalStates.get(req.query.user_id.slice(3));
      return res.json(snapshot ? [snapshot] : []);
    }
    if (req.path === "/toonation_goal_state") {
      if (req.method === "POST") {
        assert.equal(req.query.on_conflict, "id");
        assert.ok(req.headers.prefer.includes("resolution=merge-duplicates"));
        assert.equal(req.body.id, 1);
        toonGoalState = { ...req.body };
        return res.json(toonGoalState);
      }
      assert.equal(req.method, "GET");
      assert.equal(req.query.id, "eq.1");
      return res.json(toonGoalState ? [toonGoalState] : []);
    }
    const rows = req.path === "/users" ? users : donations;
    if (req.method === "PATCH") beforeWrite?.(call);
    let selected = rows.filter((row) =>
      Object.entries(req.query).every(([key, value]) => {
        if (["select", "order", "limit"].includes(key)) return true;
        assert.ok(value.startsWith("eq."), `Unexpected filter: ${value}`);
        return String(row[key]) === value.slice(3);
      }),
    );
    if (req.method === "PATCH") {
      selected.forEach((row) => Object.assign(row, req.body));
    } else if (req.method === "POST") {
      const inserted = {
        id: 300 + donations.length,
        canceled: false,
        executed_at: null,
        created_at: new Date().toISOString(),
        ...req.body,
      };
      rows.push(inserted);
      selected = [inserted];
    } else {
      assert.equal(req.method, "GET");
    }
    if (req.query.order) {
      const [column, direction] = req.query.order.split(".");
      selected.sort(
        (a, b) =>
          String(a[column]).localeCompare(String(b[column])) *
          (direction === "desc" ? -1 : 1),
      );
    }
    if (req.query.limit) selected = selected.slice(0, Number(req.query.limit));
    const columns = req.query.select?.split(",").map((column) => column.trim());
    const result = selected.map((row) =>
      columns
        ? Object.fromEntries(columns.map((column) => [column, row[column]]))
        : { ...row },
    );
    return res.json(
      req.headers.accept?.includes("application/vnd.pgrst.object+json")
        ? result[0] || null
        : result,
    );
  });
  databaseServer = await new Promise((resolve) => {
    const server = database.listen(0, "127.0.0.1", () => resolve(server));
  });

  const environment = {
    PORT: "0",
    SUPABASE_URL: `http://127.0.0.1:${databaseServer.address().port}`,
    SUPABASE_SERVICE_ROLE_KEY: "local-test-key",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  const originalListen = express.application.listen;
  express.application.listen = function (...args) {
    apiServer = originalListen.apply(this, args);
    return apiServer;
  };
  try {
    await import("../server.js");
    apiBase = `http://127.0.0.1:${apiServer.address().port}`;
  } finally {
    express.application.listen = originalListen;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

beforeEach(seed);

after(async () => {
  for (const server of [apiServer, databaseServer]) {
    if (!server) continue;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  mock.restoreAll();
});

async function request(path, method = "GET", body, headers) {
  const response = await fetch(apiBase + path, {
    method,
    headers:
      headers || (body ? { "Content-Type": "application/json" } : undefined),
    body: body ? (headers ? body : JSON.stringify(body)) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

const actionUrl = (id, action, loginId = "testuser") =>
  `/api/u/${loginId}/donations/${id}/${action}`;
const nextUrls = [
  "/api/u/testuser/next",
  "/api/donations/next?login_id=testuser",
];

test("both list APIs include canceled rows and flags, scoped to the user", async () => {
  for (const path of ["/api/u/testuser", "/api/donations?login_id=testuser"]) {
    const { status, data } = await request(path);
    assert.equal(status, 200);
    assert.deepEqual(
      data.donations.map((row) => row.id),
      [102, 101, 103],
    );
    assert.ok(
      data.donations.every(
        (row) => row.user_id === 1 && typeof row.canceled === "boolean",
      ),
    );
    assert.equal(data.donations.find((row) => row.id === 103).canceled, true);
  }
});

test("retry clears execution, both next APIs return the oldest eligible row, complete still works", async () => {
  for (const path of nextUrls)
    assert.equal((await request(path)).data.donation.id, 102);
  const result = await request(actionUrl(101, "retry"), "POST");
  assert.equal(result.status, 200);
  assert.equal(result.data.donation.executed, false);
  assert.equal(result.data.donation.executed_at, null);
  assert.equal(result.data.donation.canceled, false);
  for (const path of nextUrls)
    assert.equal((await request(path)).data.donation.id, 101);
  const completed = await request("/api/donations/101/complete", "POST");
  assert.equal(completed.status, 200);
  assert.equal(completed.data.donation.executed, true);
  assert.ok(completed.data.donation.executed_at);
  assert.equal(
    (await request("/api/donations/101/complete", "POST")).data
      .already_completed,
    true,
  );
  assert.equal(donations.length, 4);
});

test("cancel preserves completed and waiting history and excludes all canceled rows from next", async () => {
  for (const id of [101, 102]) {
    const original = structuredClone(donations.find((row) => row.id === id));
    const result = await request(actionUrl(id, "cancel"), "POST");
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.donation, { ...original, canceled: true });
    assert.equal(
      (await request(`/api/donations/${id}/complete`, "POST")).status,
      409,
    );
  }
  for (const path of nextUrls)
    assert.equal((await request(path)).data.donation, null);
  assert.equal(donations.length, 4);
});

test("retry restores canceled donations regardless of their executed flag", async () => {
  for (const executed of [false, true]) {
    Object.assign(donations[2], {
      canceled: true,
      executed,
      executed_at: executed ? "2026-09-15T01:00:00Z" : null,
    });
    const result = await request(actionUrl(103, "retry"), "POST");
    assert.equal(result.status, 200);
    assert.equal(result.data.donation.canceled, false);
    assert.equal(result.data.donation.executed, false);
    assert.equal(result.data.donation.executed_at, null);
    assert.equal((await request(nextUrls[0])).data.donation.id, 103);
  }
});

for (const action of ["retry", "cancel"]) {
  test(`${action}: rejects foreign/missing donations, missing/inactive users and invalid IDs`, async () => {
    const original = structuredClone(donations);
    for (const [id, loginId, expected] of [
      [201, "testuser", 404],
      [999, "testuser", 404],
      [101, "missing", 404],
      [101, "inactive", 403],
      ["invalid", "testuser", 400],
      [0, "testuser", 400],
      [-1, "testuser", 400],
      [1.5, "testuser", 400],
      ["9007199254740993", "testuser", 400],
    ]) {
      assert.equal(
        (await request(actionUrl(id, action, loginId), "POST")).status,
        expected,
      );
    }
    assert.deepEqual(donations, original);
    assert.ok(calls.every((call) => call.method === "GET"));
  });

  test(`${action}: ownership is checked again on update`, async () => {
    const original = { ...donations[0], user_id: 2 };
    beforeWrite = () => {
      donations[0].user_id = 2;
    };
    assert.equal((await request(actionUrl(101, action), "POST")).status, 404);
    assert.deepEqual(donations[0], original);
    const write = calls.find((call) => call.method === "PATCH");
    assert.equal(write.query.id, "eq.101");
    assert.equal(write.query.user_id, "eq.1");
  });

  test(`${action}: database errors return JSON failure without changing rows`, async () => {
    const original = structuredClone(donations);
    for (const stage of ["user", "lookup", "update"]) {
      failRequest = (call) =>
        stage === "user"
          ? call.path === "/users"
          : call.path === "/bank_donations" &&
            call.method === (stage === "update" ? "PATCH" : "GET");
      const result = await request(actionUrl(101, action), "POST");
      assert.equal(result.status, 500);
      assert.equal(result.data.ok, false);
      assert.deepEqual(donations, original);
    }
  });
}

test("complete cannot overwrite a cancellation that occurs after its lookup", async () => {
  beforeWrite = () => {
    donations[1].canceled = true;
  };
  const result = await request("/api/donations/102/complete", "POST");
  assert.equal(result.status, 409);
  assert.equal(donations[1].executed, false);
  assert.equal(donations[1].executed_at, null);
});

test("ranking still delegates aggregation to the database RPC and reset preserves donations", async () => {
  await request(actionUrl(101, "cancel"), "POST");
  // This is the RPC contract, not a test of the deployed SQL function.
  rankingResult = [
    { rank: 1, donor_name: "대기후원", total_amount: 2000, donation_count: 1 },
  ];
  const result = await request("/api/u/testuser/ranking?limit=6");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.ranking, rankingResult);
  assert.deepEqual(calls.find((call) => call.path.startsWith("/rpc/")).body, {
    p_user_id: 1,
    p_limit: 6,
  });
  const original = structuredClone(donations);
  const reset = await request("/api/u/testuser/ranking/reset", "POST");
  assert.equal(reset.status, 200);
  assert.ok(reset.data.ranking_reset_at);
  assert.deepEqual(donations, original);
});

test("login and both bank/KakaoPay SMS parsers retain their existing behavior", async () => {
  const login = await request("/api/login", "POST", {
    login_id: "testuser",
    password: "test-password",
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.login_id, "testuser");
  assert.equal(login.data.user.password, undefined);
  assert.equal(
    (
      await request("/api/login", "POST", {
        login_id: "testuser",
        password: "wrong",
      })
    ).status,
    401,
  );
  const bank = await request(
    "/accountgetter/testuser",
    "POST",
    "입금 10,000원\n잔액 20,000원\n경석/오늘/방송/화이팅\n123***456",
    { "Content-Type": "text/plain" },
  );
  assert.equal(bank.status, 201);
  assert.equal(bank.data.source, "bank");
  assert.deepEqual(bank.data.parsed, {
    donor_name: "경석",
    amount: 10000,
    text: "오늘/방송/화이팅",
  });
  const kakao = await request("/accountgetter/testuser", "POST", {
    text: "카카오페이증권\n5,000원 입금 되었어요.",
  });
  assert.equal(kakao.status, 201);
  assert.equal(kakao.data.source, "kakaopay_securities");
  assert.deepEqual(kakao.data.parsed, {
    donor_name: "익명",
    amount: 5000,
    text: "익명",
  });
  assert.ok(
    donations
      .slice(-2)
      .every((row) => row.canceled === false && row.executed === false),
  );
});

const alertCases = [
  {
    input: "경석/담배피지마라",
    name: "경석",
    text: "담배피지마라",
    alert: "경석 담배피지마라",
  },
  {
    input: "담배피지마라",
    name: "익명",
    text: "담배피지마라",
    alert: "익명 담배피지마라",
  },
  {
    input: "경석/오늘/방송/화이팅",
    name: "경석",
    text: "오늘/방송/화이팅",
    alert: "경석 오늘/방송/화이팅",
  },
  { input: "/테스트", name: "익명", text: "테스트", alert: "익명 테스트" },
  { input: "경석/", name: "경석", text: "경석", alert: "경석" },
  {
    input: "카카오페이증권",
    name: "익명",
    text: "익명",
    alert: "익명",
    kakao: true,
  },
  {
    input: "안녕하세요",
    name: "익명",
    text: "안녕하세요",
    alert: "익명 안녕하세요",
  },
  {
    input: "테스트입니다",
    name: "익명",
    text: "테스트입니다",
    alert: "익명 테스트입니다",
  },
  { input: "12345", name: "익명", text: "12345", alert: "익명 12345" },
  {
    input: "  경석  /  오늘/방송/화이팅  ",
    name: "경석",
    text: "오늘/방송/화이팅",
    alert: "경석 오늘/방송/화이팅",
  },
  { input: " / ", name: "익명", text: "익명", alert: "익명" },
];

for (const sample of alertCases) {
  test(`accountgetter → stored/list text → both next responses: ${sample.input}`, async () => {
    // The newly inserted row must be the only eligible donation for this user.
    donations[1].executed = true;
    const amount = sample.kakao ? 5000 : 10000;
    const sms = sample.kakao
      ? "5,000원 입금 되었어요.\n- 계좌 : 123***456\n[카카오페이증권 알림]"
      : `입금 10,000원\n잔액 20,000원\n${sample.input}\n123***456`;
    const inserted = await request(
      "/accountgetter/testuser",
      "POST",
      sample.kakao ? { text: sms } : sms,
      sample.kakao ? undefined : { "Content-Type": "text/plain" },
    );
    assert.equal(inserted.status, 201);
    assert.equal(
      inserted.data.source,
      sample.kakao ? "kakaopay_securities" : "bank",
    );
    assert.deepEqual(inserted.data.parsed, {
      donor_name: sample.name,
      amount,
      text: sample.text,
    });
    const stored = donations.find(
      (row) => row.id === inserted.data.donation.id,
    );
    assert.equal(stored.donor_name, sample.name);
    assert.equal(stored.text, sample.text);
    assert.equal(stored.amount, amount);
    assert.equal(inserted.data.donation.text, sample.text);
    const snapshot = structuredClone(donations);
    const readsStart = calls.length;

    for (const path of nextUrls) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.deepEqual(response.data.donation, {
        id: stored.id,
        donor_name: sample.name,
        amount,
        text: sample.alert,
        created_at: stored.created_at,
      });
      const repeated = await request(path);
      assert.equal(repeated.data.donation.text, sample.alert);
    }
    for (const path of [
      "/api/u/testuser",
      "/api/donations?login_id=testuser",
    ]) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.deepEqual(
        response.data.donations.find((row) => row.id === stored.id),
        stored,
      );
    }
    assert.deepEqual(donations, snapshot);
    assert.ok(calls.slice(readsStart).every((call) => call.method === "GET"));
  });
}

test("both next APIs safely format existing empty, duplicate and padded fields without rewriting them", async () => {
  for (const [donorName, text, expected] of [
    [null, null, ""],
    ["", "", ""],
    ["", "메시지만", "메시지만"],
    ["경석", "", "경석"],
    ["경석", null, "경석"],
    [" 익명 ", " 익명 ", "익명"],
    [" 경석 ", " 메시지 ", "경석 메시지"],
  ]) {
    Object.assign(donations[1], { donor_name: donorName, text });
    const snapshot = structuredClone(donations);
    for (const path of nextUrls) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.equal(response.data.donation.id, 102);
      assert.equal(response.data.donation.donor_name, donorName);
      assert.equal(response.data.donation.text, expected);
    }
    assert.deepEqual(donations, snapshot);
  }
});

function configureGoalToken(context, token = "collector-test-token") {
  const previous = process.env.TOONATION_GOAL_TOKEN;
  if (token === null) delete process.env.TOONATION_GOAL_TOKEN;
  else process.env.TOONATION_GOAL_TOKEN = token;
  context.after(() => {
    if (previous === undefined) delete process.env.TOONATION_GOAL_TOKEN;
    else process.env.TOONATION_GOAL_TOKEN = previous;
  });
}

async function postGoal(amount, token = "collector-test-token") {
  const response = await fetch(apiBase + "/api/toonation-goal", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ amount }),
  });
  return { status: response.status, data: await response.json() };
}

test("goal: snapshots replace previous Toonation totals, including repeats and decreases", async (context) => {
  configureGoalToken(context);
  const originalDonations = structuredClone(donations);
  for (const amount of [11900, 11900, 16900, 21900, 7000, 0]) {
    const result = await postGoal(amount);
    assert.equal(result.status, 200);
    assert.equal(result.data.toonAmount, amount);
    assert.ok(Number.isFinite(Date.parse(result.data.toonUpdatedAt)));
    assert.equal(toonGoalState.id, 1);
    assert.equal(toonGoalState.amount, amount);
    for (let count = 0; count < 2; count += 1) {
      const response = await request("/api/goal-progress");
      assert.equal(response.status, 200);
      assert.equal(response.data.dbAmount, 50000);
      assert.equal(response.data.toonAmount, amount);
      assert.equal(response.data.totalAmount, 50000 + amount);
      assert.equal(response.data.goalAmount, 100000);
      assert.equal(response.data.isToonStale, false);
    }
  }
  assert.deepEqual(donations, originalDonations);
  assert.ok(calls.every((call) => call.path !== "/bank_donations"));
});

test("goal: examples A-D calculate new goals and clamp the final percentage", async () => {
  for (const [db, toon, total, goal, percent] of [
    [50000, 11900, 61900, 100000, 61.9],
    [60000, 60000, 120000, 1000000, 12],
    [1500000, 0, 1500000, 2000000, 75],
    [10500000, 0, 10500000, 10000000, 100],
  ]) {
    goalDbTotal = String(db);
    toonGoalState = {
      id: 1,
      amount: String(toon),
      updated_at: new Date().toISOString(),
    };
    const result = await request("/api/goal-progress");
    assert.equal(result.status, 200);
    assert.equal(result.data.totalAmount, total);
    assert.equal(result.data.goalAmount, goal);
    assert.equal(result.data.percent, percent);
  }
});

test("goal: no snapshot starts at zero; stale snapshots still contribute their full amount", async () => {
  const initial = await request("/api/goal-progress");
  assert.equal(initial.status, 200);
  assert.equal(initial.data.toonAmount, 0);
  assert.equal(initial.data.toonUpdatedAt, null);
  assert.equal(initial.data.isToonStale, true);
  toonGoalState = { id: 1, amount: 11900, updated_at: "2000-01-01T00:00:00Z" };
  const stale = await request("/api/goal-progress");
  assert.equal(stale.status, 200);
  assert.equal(stale.data.totalAmount, 61900);
  assert.equal(stale.data.toonUpdatedAt, toonGoalState.updated_at);
  assert.equal(stale.data.isToonStale, true);
});

test("goal: POST rejects invalid values and unauthorized writers without changing the snapshot", async (context) => {
  configureGoalToken(context);
  toonGoalState = { id: 1, amount: 11900, updated_at: "2026-09-16T00:00:00Z" };
  const original = { ...toonGoalState };
  for (const amount of [
    -1,
    1.5,
    "11900",
    "11,900 (1.2%)",
    null,
    true,
    {},
    [],
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal((await postGoal(amount)).status, 400);
  }
  assert.equal((await postGoal(20000, "wrong-token")).status, 401);
  assert.deepEqual(toonGoalState, original);
  assert.equal(calls.length, 0);
});

test("goal: absent collector configuration does not allow an unauthenticated write", async (context) => {
  configureGoalToken(context, null);
  assert.equal((await postGoal(11900)).status, 503);
  assert.equal(toonGoalState, null);
});

test("goal: either read failure is an error, never a fabricated zero total", async () => {
  for (const path of ["/rpc/get_donation_db_total", "/toonation_goal_state"]) {
    failRequest = (call) => call.path === path;
    const response = await request("/api/goal-progress");
    assert.equal(response.status, 500);
    assert.equal(response.data.ok, false);
    assert.equal(response.data.totalAmount, undefined);
  }
});

test("goal: failed snapshot upsert preserves the previous value", async (context) => {
  configureGoalToken(context);
  toonGoalState = { id: 1, amount: 11900, updated_at: "2026-09-16T00:00:00Z" };
  const original = { ...toonGoalState };
  failRequest = (call) =>
    call.path === "/toonation_goal_state" && call.method === "POST";
  assert.equal((await postGoal(21900)).status, 500);
  assert.deepEqual(toonGoalState, original);
});

test("goal: corrupt and unsafe stored totals fail without rounding or zeroing them", async () => {
  for (const value of [
    null,
    [50000],
    "not-an-amount",
    -1,
    "9007199254740992",
  ]) {
    goalDbTotal = value;
    assert.equal((await request("/api/goal-progress")).status, 500);
  }
  goalDbTotal = Number.MAX_SAFE_INTEGER;
  toonGoalState = { id: 1, amount: 1, updated_at: new Date().toISOString() };
  assert.equal((await request("/api/goal-progress")).status, 500);
});

const userGoalUrl = (loginId = "testuser") =>
  `/api/u/${encodeURIComponent(loginId)}/goal-progress`;

async function postUserGoal(loginId, amount, token = "collector-test-token", extra = {}) {
  const response = await fetch(apiBase + `/api/u/${encodeURIComponent(loginId)}/toonation-goal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ amount, ...extra }),
  });
  return { status: response.status, data: await response.json() };
}

test("personal graph: separates both sources by URL user and never reads the global snapshot", async (context) => {
  configureGoalToken(context);
  toonGoalState = { id: 1, amount: 999999, updated_at: new Date().toISOString() };
  assert.equal((await postUserGoal("testuser", 11900)).status, 200);
  assert.equal((await postUserGoal("SA58PARA", 25000)).status, 200);
  for (const [loginId, dbAmount, toonAmount] of [
    ["testuser", 50000, 11900], ["SA58PARA", 9000, 25000],
  ]) {
    const response = await fetch(apiBase + userGoalUrl(loginId));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.equal(result.login_id, loginId);
    assert.equal(result.dbAmount, dbAmount);
    assert.equal(result.toonAmount, toonAmount);
    assert.equal(result.totalAmount, dbAmount + toonAmount);
    assert.equal(result.isToonStale, false);
  }
  assert.ok(calls.every((call) => ![
    "/rpc/get_donation_db_total", "/toonation_goal_state", "/bank_donations",
  ].includes(call.path)));
});

test("personal graph: repeated/decreasing snapshots replace only the URL user's amount", async (context) => {
  configureGoalToken(context);
  const originalDonations = structuredClone(donations);
  await postUserGoal("SA58PARA", 25000);
  const otherSnapshot = structuredClone(userToonGoalStates.get("2"));
  for (const amount of [11900, 11900, 21900, 7000, 0]) {
    // Body IDs cannot redirect the write away from the URL user.
    const updated = await postUserGoal("testuser", amount, undefined, {
      user_id: 2, login_id: "SA58PARA",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.login_id, "testuser");
    for (let poll = 0; poll < 2; poll += 1) {
      const { data } = await request(userGoalUrl());
      assert.equal(data.totalAmount, 50000 + amount);
    }
    assert.deepEqual(userToonGoalStates.get("2"), otherSnapshot);
  }
  assert.deepEqual(donations, originalDonations);
  assert.equal(toonGoalState, null);
});

test("personal graph: no snapshot starts at zero and stale data keeps its amount", async () => {
  const initial = await request(userGoalUrl());
  assert.equal(initial.status, 200);
  assert.equal(initial.data.toonAmount, 0);
  assert.equal(initial.data.totalAmount, 50000);
  assert.equal(initial.data.toonUpdatedAt, null);
  assert.equal(initial.data.isToonStale, true);
  userToonGoalStates.set("1", { amount: "11900", updated_at: "2000-01-01T00:00:00Z" });
  const stale = await request(userGoalUrl());
  assert.equal(stale.data.totalAmount, 61900);
  assert.equal(stale.data.isToonStale, true);
});

test("personal graph: missing optional migration falls back to Ranking and zero Toonation", async () => {
  rankingResult = [
    { donor_name: "A", total_amount: "10000" },
    { donor_name: "B", total_amount: "25000" },
  ];
  failRequest = (call) => {
    if (call.path === "/rpc/get_user_donation_db_total") {
      return {
        status: 404,
        body: { code: "PGRST202", message: "Function not found" },
      };
    }
    if (call.path === "/user_toonation_goal_state") {
      return {
        status: 404,
        body: { code: "PGRST205", message: "Table not found" },
      };
    }
    return false;
  };

  const result = await request(userGoalUrl());
  assert.equal(result.status, 200);
  assert.deepEqual(
    {
      login_id: result.data.login_id,
      dbAmount: result.data.dbAmount,
      toonAmount: result.data.toonAmount,
      totalAmount: result.data.totalAmount,
      goalAmount: result.data.goalAmount,
      percent: result.data.percent,
      toonUpdatedAt: result.data.toonUpdatedAt,
      isToonStale: result.data.isToonStale,
    },
    {
      login_id: "testuser",
      dbAmount: 35000,
      toonAmount: 0,
      totalAmount: 35000,
      goalAmount: 100000,
      percent: 35,
      toonUpdatedAt: null,
      isToonStale: true,
    },
  );
  const fallback = calls.find(
    (call) => call.path === "/rpc/get_current_donation_ranking",
  );
  assert.equal(fallback.body.p_user_id, 1);
  assert.equal(fallback.body.p_limit, 2_147_483_647);
});

test("personal graph: missing/inactive/blank users never access amount data", async (context) => {
  configureGoalToken(context);
  for (const [loginId, status] of [["missing", 404], ["inactive", 403], [" ", 400]]) {
    calls = [];
    assert.equal((await request(userGoalUrl(loginId))).status, status);
    assert.equal((await postUserGoal(loginId, 100)).status, status);
    assert.ok(calls.every((call) => call.path === "/users"));
  }
  failRequest = (call) => call.path === "/users";
  assert.equal((await request(userGoalUrl())).status, 500);
  assert.equal((await postUserGoal("testuser", 100)).status, 500);
  assert.equal(userToonGoalStates.size, 0);
});

test("personal graph: preserves collector authentication and validates writes before database access", async (context) => {
  configureGoalToken(context);
  assert.equal((await postUserGoal("testuser", 100, "wrong")).status, 401);
  for (const amount of [-1, 1.1, "11900", null, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await postUserGoal("testuser", amount)).status, 400);
  }
  delete process.env.TOONATION_GOAL_TOKEN;
  assert.equal((await postUserGoal("testuser", 100)).status, 503);
  assert.equal(calls.length, 0);
});

test("personal graph: supports encoded login IDs and actual string user IDs", async (context) => {
  configureGoalToken(context);
  const id = "8686e010-68ba-499b-80a1-a3e8b7f8c845";
  const loginId = "방송+one/%";
  users.push({ id, login_id: loginId, is_active: true });
  userGoalDbTotals.set(id, "35000");
  assert.equal((await postUserGoal(loginId, 11900)).status, 200);
  const result = await request(userGoalUrl(loginId));
  assert.equal(result.status, 200);
  assert.equal(result.data.login_id, loginId);
  assert.equal(result.data.totalAmount, 46900);
  assert.equal(userToonGoalStates.get(id).user_id, id);
});

test("personal graph: goal boundaries and percentage follow the current personal total", async () => {
  for (const [amount, goal, percent] of [
    [0, 100000, 0], [100000, 100000, 100], [100001, 1000000, 10],
    [1000000, 1000000, 100], [1000001, 2000000, 50],
    [1500000, 2000000, 75], [10500000, 10000000, 105],
  ]) {
    userGoalDbTotals.set("1", String(amount));
    const result = await request(userGoalUrl());
    assert.equal(result.status, 200);
    assert.equal(result.data.totalAmount, amount);
    assert.equal(result.data.goalAmount, goal);
    assert.equal(result.data.percent, percent);
  }
});

test("personal graph: read failures and invalid stored values return errors, never a zero fallback", async () => {
  for (const path of ["/rpc/get_user_donation_db_total", "/user_toonation_goal_state"]) {
    failRequest = (call) => call.path === path;
    const result = await request(userGoalUrl());
    assert.equal(result.status, 500);
    assert.equal(result.data.totalAmount, undefined);
  }
  failRequest = null;
  for (const value of ["not-an-amount", "9007199254740992", -1, [50000]]) {
    userGoalDbTotals.set("1", value);
    assert.equal((await request(userGoalUrl())).status, 500);
  }
  userGoalDbTotals.set("1", "50000");
  for (const snapshot of [
    { amount: null, updated_at: new Date().toISOString() },
    { amount: 11900, updated_at: null },
    { amount: 11900, updated_at: "invalid" },
  ]) {
    userToonGoalStates.set("1", snapshot);
    assert.equal((await request(userGoalUrl())).status, 500);
  }
  userGoalDbTotals.set("1", String(Number.MAX_SAFE_INTEGER));
  userToonGoalStates.set("1", { amount: 1, updated_at: new Date().toISOString() });
  assert.equal((await request(userGoalUrl())).status, 500);
});

test("personal graph: a failed write retains the user's previous snapshot", async (context) => {
  configureGoalToken(context);
  await postUserGoal("testuser", 11900);
  const before = structuredClone(userToonGoalStates.get("1"));
  failRequest = (call) => call.path === "/user_toonation_goal_state" && call.method === "POST";
  assert.equal((await postUserGoal("testuser", 21900)).status, 500);
  assert.deepEqual(userToonGoalStates.get("1"), before);
});
