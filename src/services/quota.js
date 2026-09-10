const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function quotaWindow(window) {
  if (!window || typeof window.utilization !== 'number') return null;
  return {
    used: window.utilization,
    remaining: Math.max(0, 100 - window.utilization),
    resetAt: window.resets_at || null,
  };
}

function codexWindow(window) {
  if (!window) return null;
  const used = Number(window.used_percent ?? window.percent_used ?? 0);
  return {
    used,
    remaining: Math.max(0, 100 - used),
    resetAt: window.reset_at ?? window.resets_at ?? null,
  };
}

export async function fetchQuota(provider, tokenSet, fetchImpl = fetch) {
  if (provider === 'claude') {
    const response = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${tokenSet.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
    });
    if (!response.ok) throw new Error(`Quota upstream returned ${response.status}`);
    const data = await response.json();
    const quotas = {};
    const session = quotaWindow(data.five_hour);
    const weekly = quotaWindow(data.seven_day);
    if (session) quotas.session = session;
    if (weekly) quotas.weekly = weekly;
    return { plan: data.plan_type || 'Claude', quotas };
  }

  const response = await fetchImpl(CODEX_USAGE_URL, {
    headers: { authorization: `Bearer ${tokenSet.accessToken}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Quota upstream returned ${response.status}`);
  const data = await response.json();
  const rate = data.rate_limit || data.rate_limits || {};
  const quotas = {};
  const session = codexWindow(rate.primary_window || rate.primary);
  const weekly = codexWindow(rate.secondary_window || rate.secondary);
  if (session) quotas.session = session;
  if (weekly) quotas.weekly = weekly;
  return { plan: data.plan_type || data.summary?.plan || 'Codex', quotas };
}
