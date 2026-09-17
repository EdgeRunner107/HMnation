import { calculateGoal, readStoredAmount } from './goalProgress.js';

const TOONATION_STALE_AFTER_MS = 60_000;
const ALL_RANKS_LIMIT = 2_147_483_647;

function isMissingSchemaObject(error, postgrestCode, postgresCode) {
  return error?.code === postgrestCode || error?.code === postgresCode;
}

async function getUserDonationDbTotal(supabase, userId) {
  const aggregate = await supabase.rpc('get_user_donation_db_total', {
    p_user_id: String(userId),
  });
  if (!aggregate.error) return readStoredAmount(aggregate.data);
  if (!isMissingSchemaObject(aggregate.error, 'PGRST202', '42883')) {
    throw aggregate.error;
  }

  // Deployments that have not run user-goal-progress.sql can still use the
  // same per-user source as the working Ranking endpoint.
  const { data: ranking, error } = await supabase.rpc(
    'get_current_donation_ranking',
    { p_user_id: userId, p_limit: ALL_RANKS_LIMIT },
  );
  if (error) throw error;
  if (!Array.isArray(ranking)) {
    throw new Error('Invalid user ranking result');
  }

  return ranking.reduce((total, row) => {
    const amount = readStoredAmount(row?.total_amount);
    if (total > Number.MAX_SAFE_INTEGER - amount) {
      throw new Error('Invalid stored goal amount');
    }
    return total + amount;
  }, 0);
}

async function getUserToonationState(supabase, userId) {
  const result = await supabase
    .from('user_toonation_goal_state')
    .select('amount, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (
    result.error &&
    isMissingSchemaObject(result.error, 'PGRST205', '42P01')
  ) {
    // No personal Toonation storage has been installed yet. This is the same
    // observable state as a valid user who has never submitted a snapshot.
    return null;
  }
  if (result.error) throw result.error;
  return result.data;
}

// Match the existing /api/u/:login_id/... lookup and active-user checks.
async function findUser(supabase, loginId, res) {
  if (!loginId || !loginId.trim()) {
    res.status(400).json({ ok: false, error: 'login_id is required' });
    return null;
  }
  const { data: user, error } = await supabase
    .from('users')
    .select('id, login_id, is_active')
    .eq('login_id', loginId)
    .maybeSingle();
  if (error) throw error;
  if (!user) {
    res.status(404).json({ ok: false, error: 'User not found' });
    return null;
  }
  if (user.is_active === false) {
    res.status(403).json({ ok: false, error: 'User is inactive' });
    return null;
  }
  return user;
}

export async function getUserGoalProgress(supabase, userId, now = Date.now()) {
  const [dbAmount, toonState] = await Promise.all([
    getUserDonationDbTotal(supabase, userId),
    getUserToonationState(supabase, userId),
  ]);

  const toonAmount = toonState ? readStoredAmount(toonState.amount) : 0;
  const toonUpdatedAt = toonState?.updated_at ?? null;
  if (toonState && !Number.isFinite(Date.parse(toonUpdatedAt))) {
    throw new Error('Invalid Toonation update timestamp');
  }
  // Always recompute from the two current sources; never add to a prior total.
  const totalAmount = dbAmount + toonAmount;
  const goalAmount = calculateGoal(totalAmount);
  return {
    toonAmount,
    dbAmount,
    totalAmount,
    goalAmount,
    percent: Math.round((totalAmount / goalAmount) * 1000) / 10,
    toonUpdatedAt,
    isToonStale:
      toonUpdatedAt === null || now - Date.parse(toonUpdatedAt) > TOONATION_STALE_AFTER_MS,
  };
}

export function registerUserGoalProgressRoutes(app, supabase) {
  app.get('/api/u/:login_id/goal-progress', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const user = await findUser(supabase, req.params.login_id, res);
      if (!user) return;
      return res.json({
        ok: true,
        login_id: user.login_id,
        ...(await getUserGoalProgress(supabase, user.id)),
      });
    } catch (error) {
      console.error('[USER GOAL PROGRESS] lookup failed:', error);
      return res.status(500).json({ ok: false, error: 'User goal progress lookup failed' });
    }
  });

  app.post('/api/u/:login_id/toonation-goal', async (req, res) => {
    // Preserve the trusted collector's existing Bearer-token authentication.
    // This server-wide token belongs to the collector, not to public widgets.
    const token = process.env.TOONATION_GOAL_TOKEN;
    if (!token) {
      return res.status(503).json({
        ok: false,
        error: 'Toonation collector token is not configured',
      });
    }
    if (req.get('authorization') !== `Bearer ${token}`) {
      return res.status(401).json({ ok: false, error: 'Invalid collector token' });
    }
    const { amount } = req.body || {};
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
      return res.status(400).json({
        ok: false,
        error: 'amount must be a non-negative safe integer',
      });
    }

    try {
      const user = await findUser(supabase, req.params.login_id, res);
      if (!user) return;
      // Only the URL-resolved user owns this snapshot; ignore body user IDs.
      const { data, error } = await supabase
        .from('user_toonation_goal_state')
        .upsert(
          { user_id: user.id, amount, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        )
        .select('amount, updated_at')
        .single();
      if (error) throw error;
      return res.json({
        ok: true,
        login_id: user.login_id,
        toonAmount: readStoredAmount(data.amount),
        toonUpdatedAt: data.updated_at,
      });
    } catch (error) {
      console.error('[USER TOONATION GOAL] update failed:', error);
      return res.status(500).json({ ok: false, error: 'User Toonation goal update failed' });
    }
  });
}
