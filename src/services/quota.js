const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/**
 * Upstreams disagree on the reset representation: Claude sends an ISO string,
 * Codex sends a Unix timestamp in seconds. Passing the raw number to `Date`
 * in the browser reads it as milliseconds and renders 1970, so normalize to
 * ISO here where the provider shape is already known.
 */
function resetIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return new Date(seconds * 1000).toISOString();
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function quotaWindow(window) {
  if (!window) return null;
  const used = typeof window.utilization === 'number' && Number.isFinite(window.utilization)
    ? window.utilization : null;
  return {
    used,
    remaining: used === null ? null : Math.max(0, 100 - used),
    resetAt: resetIso(window.resets_at),
  };
}

function codexWindow(window) {
  if (!window) return null;
  const rawUsed = window.used_percent ?? window.percent_used;
  const parsedUsed = rawUsed === undefined || rawUsed === null || rawUsed === '' ? NaN : Number(rawUsed);
  const used = Number.isFinite(parsedUsed) ? parsedUsed : null;
  const seconds = window.reset_after_seconds;
  const resetAt = resetIso(window.reset_at ?? window.resets_at)
    ?? (seconds !== null && seconds !== undefined && seconds !== ''
      && Number.isFinite(Number(seconds)) && Number(seconds) >= 0
      ? new Date(Date.now() + Number(seconds) * 1000).toISOString()
      : null);
  return {
    used,
    remaining: used === null ? null : Math.max(0, 100 - used),
    resetAt,
  };
}

function requireQuotaResponse(response) {
  if (response.ok) return;
  const error = new Error(`Quota upstream returned ${response.status}`);
  error.statusCode = response.status;
  throw error;
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
    requireQuotaResponse(response);
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
  requireQuotaResponse(response);
  const data = await response.json();
  const rate = data.rate_limit || data.rate_limits || {};
  const quotas = {};
  const session = codexWindow(rate.primary_window || rate.primary);
  const weekly = codexWindow(rate.secondary_window || rate.secondary);
  if (session) quotas.session = session;
  if (weekly) quotas.weekly = weekly;
  return { plan: data.plan_type || data.summary?.plan || 'Codex', quotas };
}
