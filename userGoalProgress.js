import { calculateGoal, readStoredAmount } from './goalProgress.js';

const TOONATION_STALE_AFTER_MS = 60_000;

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
  const [dbResult, toonResult] = await Promise.all([
    // Aggregate the complete existing ranking in SQL, without REST top-N limits.
    supabase.rpc('get_user_donation_db_total', { p_user_id: String(userId) }),
    supabase
      .from('user_toonation_goal_state')
      .select('amount, updated_at')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);
  if (dbResult.error) throw dbResult.error;
  if (toonResult.error) throw toonResult.error;

  const dbAmount = readStoredAmount(dbResult.data);
  const toonAmount = toonResult.data ? readStoredAmount(toonResult.data.amount) : 0;
  const toonUpdatedAt = toonResult.data?.updated_at ?? null;
  if (toonResult.data && !Number.isFinite(Date.parse(toonUpdatedAt))) {
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
