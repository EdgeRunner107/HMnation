import { findUser } from './userGoalProgress.js';

export const DEFAULT_GRAPH_SETTINGS = Object.freeze({
  label: '후원목표',
  color: '#3B82F6',
});

function parseGraphSettings(body) {
  const { label, color } = body || {};
  if (typeof label !== 'string' || typeof color !== 'string') return null;

  const normalizedLabel = label.trim();
  const normalizedColor = color.toUpperCase();
  if (
    normalizedLabel.length < 1 ||
    normalizedLabel.length > 20 ||
    !/^#[0-9A-F]{6}$/.test(normalizedColor)
  ) {
    return null;
  }

  return { label: normalizedLabel, color: normalizedColor };
}

export function registerUserGraphSettingsRoutes(app, supabase) {
  app.get('/api/u/:login_id/graph-settings', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const user = await findUser(supabase, req.params.login_id.trim(), res);
      if (!user) return;

      const { data, error } = await supabase
        .from('user_graph_settings')
        .select('login_id, label, color')
        .eq('login_id', user.login_id)
        .maybeSingle();

      if (error) throw error;
      return res.json({
        ok: true,
        login_id: user.login_id,
        ...(data
          ? { label: data.label, color: data.color.toUpperCase(), isDefault: false }
          : { ...DEFAULT_GRAPH_SETTINGS, isDefault: true }),
      });
    } catch (error) {
      console.error('[USER GRAPH SETTINGS] lookup failed:', error);
      return res.status(500).json({
        ok: false,
        error: 'Graph settings lookup failed',
      });
    }
  });

  app.put('/api/u/:login_id/graph-settings', async (req, res) => {
    const settings = parseGraphSettings(req.body);
    if (!settings) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid graph settings',
      });
    }

    try {
      const user = await findUser(supabase, req.params.login_id.trim(), res);
      if (!user) return;

      const { data, error } = await supabase
        .from('user_graph_settings')
        .upsert(
          { login_id: user.login_id, ...settings },
          { onConflict: 'login_id' },
        )
        .select('login_id, label, color')
        .single();

      if (error) throw error;
      return res.json({
        ok: true,
        login_id: data.login_id,
        label: data.label,
        color: data.color.toUpperCase(),
        isDefault: false,
      });
    } catch (error) {
      console.error('[USER GRAPH SETTINGS] update failed:', error);
      return res.status(500).json({
        ok: false,
        error: 'Graph settings update failed',
      });
    }
  });
}
