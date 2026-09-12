# Router credential sync contract

> **UPGRADE-CRITICAL AZOX CONTRACT**
>
> This contract protects rotating Codex and Claude OAuth credentials shared by
> LLM Portal, OmniRoute and 9Router. Every upstream upgrade or reset of any of
> these three repositories must review this document and run the listed
> regression checks before merge or production rollout. Do not resolve an
> upstream conflict by giving either router a Portal refresh token.

The Portal is the only component allowed to store or use an OAuth refresh token.
Routers are access-token consumers. This avoids refresh-token rotation races when
one account serves traffic through multiple routers.

## Portal refresh authority

- Portal keeps the refresh token encrypted at rest and is the only process that
  exchanges it with Codex or Claude.
- `refresh_lead_hours` is a dynamic admin setting read on every scheduler tick.
  The production value was set to `1` on 2026-09-12, but `1` is not a hard-coded
  contract and may be changed through Portal configuration.
- A successful automatic refresh starts a 10-minute minimum refresh gap for that
  account. Failed refresh attempts do not start the gap, and manual re-auth is
  unaffected.
- Every successful rotation increments `tokenVersion` and pushes the new access
  token to both routers.

## 9Router

- Internal URL: `/api/internal/portal/connections/{externalId}`
- Authentication: bearer service token from `PORTAL_SYNC_TOKEN`
- Network: Docker `llm-gateway-net`; do not publish this endpoint separately
- Methods: `PUT` upsert, `GET` token-safe status, `DELETE` removal
- Providers: `claude`, `codex`
- Required write fields: `provider`, `accessToken`, `expiresAt`, `tokenVersion`
- Display fields: `email` and `name` carry the full upstream account address;
  `displayName` carries `Sponsored by: <portal user>`, which 9Router renders as
  the second line of the connection row. `providerSpecificData.sponsoredBy`
  keeps the raw username for programmatic use.
- Forbidden persistence: `refreshToken`
- Ordering: writes with `tokenVersion` less than or equal to the stored version
  receive `409`, preventing stale retries from replacing a newer token.

Portal and 9Router share one generated service token through their environment
files. Logs and API responses never contain credential values.

## OmniRoute

- Internal URL, authentication, network isolation, methods, providers and write
  fields match the 9Router contract above.
- Portal-managed rows are identified by
  `providerSpecificData.portalExternalId`.
- The credential health sweep must completely skip those rows: no local refresh,
  no `no_refresh_token` error, no `expired` state and no automatic deactivation.
- Every Portal `PUT` clears stale terminal health state left by an older build so
  a previously poisoned row recovers without dashboard re-authentication.
- Direct-login OAuth rows without `portalExternalId` retain OmniRoute's normal
  refresh and health-check behavior.

## Required upgrade checks

Before accepting an upstream merge, rebase, reset or major auth refactor in any
of the three repositories, verify all of the following:

1. Portal never sends a `refreshToken`, and both router endpoints reject or drop
   any stale stored Portal refresh token.
2. Both routers preserve `portalExternalId`, monotonic `portalTokenVersion`,
   stale-write rejection and access-token-only persistence.
3. OmniRoute's health sweep cannot mark Portal-managed rows `expired`, assign
   `no_refresh_token`, increment expired retries or set `isActive=false`.
4. A subsequent Portal push restores an old OmniRoute row to active health.
5. Portal still reads the refresh lead dynamically and enforces the independent
   10-minute minimum gap only after successful refreshes.
6. Direct-login OAuth accounts in both routers continue to use their existing
   local refresh behavior.

The incident that established this contract occurred on 2026-09-11/12:
OmniRoute treated access-token-only Portal rows as broken OAuth credentials,
eventually deactivated the Codex account, exhausted LiteLLM retries and surfaced
HTTP 429. Disabling that Codex row removed the bad candidate and temporarily
restored routing; preserving this contract is the root fix.
