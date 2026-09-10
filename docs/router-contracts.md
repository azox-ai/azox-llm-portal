# Router credential sync contract

The Portal is the only component allowed to store or use an OAuth refresh token.
Routers are access-token consumers. This avoids refresh-token rotation races when
one account serves traffic through multiple routers.

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

Deferred. It will implement the same semantic contract after the 9Router rollout
proves access-token-only operation under real traffic and token rotation.
