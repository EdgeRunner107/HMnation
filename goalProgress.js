const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
const TOONATION_STALE_AFTER_MS = 60_000;

export function readStoredAmount(value) {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^\d+$/.test(value))
  ) {
    throw new Error('Invalid stored goal amount');
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Invalid stored goal amount');
  }
  return amount;
}

export function calculateGoal(total) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('Invalid total amount');
  }
  if (total <= 100_000) return 100_000;
  if (total <= 1_000_000) return 1_000_000;
  return Math.min(Math.ceil(total / 1_000_000) * 1_000_000, 10_000_000);
}

export async function getDonationDbTotal(supabase) {
  // This SQL wrapper sums the existing ranking function across all active users.
  // Aggregating inside Postgres avoids the ranking API's top-N / REST row limits.
  const { data, error } = await supabase.rpc('get_donation_db_total');
  if (error) throw error;
  return readStoredAmount(data);
}

export async function getLatestToonationAmount(supabase) {
  const { data, error } = await supabase
    .from('toonation_goal_state')
    .select('amount, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { amount: 0, updatedAt: null };
  if (!Number.isFinite(Date.parse(data.updated_at))) {
    throw new Error('Invalid Toonation update timestamp');
  }
  return { amount: readStoredAmount(data.amount), updatedAt: data.updated_at };
}

export async function getGoalProgress(supabase, now = Date.now()) {
  const [dbAmount, toon] = await Promise.all([
    getDonationDbTotal(supabase),
    getLatestToonationAmount(supabase),
  ]);
  const totalAmount = dbAmount + toon.amount;
  const goalAmount = calculateGoal(totalAmount);
  const percent =
    Math.round(Math.min((totalAmount / goalAmount) * 100, 100) * 10) / 10;

  return {
    toonAmount: toon.amount,
    dbAmount,
    totalAmount,
    goalAmount,
    percent,
    toonUpdatedAt: toon.updatedAt,
    isToonStale:
      toon.updatedAt === null ||
      now - Date.parse(toon.updatedAt) > TOONATION_STALE_AFTER_MS,
  };
}

export function registerGoalProgressRoutes(app, supabase) {
  app.get('/api/goal-progress', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      return res.json({ ok: true, ...(await getGoalProgress(supabase)) });
    } catch (error) {
      console.error('[GOAL PROGRESS] lookup failed:', error);
      return res
        .status(500)
        .json({ ok: false, error: 'Goal progress lookup failed' });
    }
  });

  app.post('/api/toonation-goal', async (req, res) => {
    // The singleton is shared, so only the configured collector can replace it.
    const token = process.env.TOONATION_GOAL_TOKEN;
    if (!token) {
      return res
        .status(503)
        .json({
          ok: false,
          error: 'Toonation collector token is not configured',
        });
    }
    if (req.get('authorization') !== `Bearer ${token}`) {
      return res
        .status(401)
        .json({ ok: false, error: 'Invalid collector token' });
    }

    const { amount } = req.body || {};
    if (
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      amount > MAX_AMOUNT
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error: 'amount must be a non-negative safe integer',
        });
    }

    try {
      const { data, error } = await supabase
        .from('toonation_goal_state')
        .upsert(
          { id: 1, amount, updated_at: new Date().toISOString() },
          { onConflict: 'id' },
        )
        .select('amount, updated_at')
        .single();
      if (error) throw error;
      return res.json({
        ok: true,
        toonAmount: readStoredAmount(data.amount),
        toonUpdatedAt: data.updated_at,
      });
    } catch (error) {
      console.error('[TOONATION GOAL] update failed:', error);
      return res
        .status(500)
        .json({ ok: false, error: 'Toonation goal update failed' });
    }
  });
}
