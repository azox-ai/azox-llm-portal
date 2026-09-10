# AZOX LLM Portal

Internal account portal for the `llm-gateway` Docker stack.

## Scope

- Providers: Claude and Codex OAuth only.
- Admin-created username/password users; users may change password at any time.
- Admin surface mirrors the 9Router dashboard: create user, reset a chosen
  password, disable/enable, and remove a user with its router connections.
- Login has two tabs like 9Router: username/password for users, and an
  admin-password form that signs in as `INIT_ADMIN_USERNAME`.
- Provider accounts are strictly owner-scoped, including for administrators.
- Account labels are the full upstream email or account name, unmasked, and
  every surface shows `Sponsored by: <portal user>` beneath it.
- Quota Tracker reads upstream quota and exposes no state-changing actions.
- Portal is the canonical credential owner. It refreshes one hour before expiry,
  keeps the refresh token encrypted at rest, and pushes only the access token,
  expiry and identity metadata to 9Router.
- OmniRoute is intentionally outside this release and will use the same adapter
  contract after the Portal + 9Router deployment is validated.

## Adding a provider account

The Connect dialog reproduces the two-step 9Router `OAuthModal`: step 1 opens a
popup on the vendor authorize URL (with copy and re-open buttons when the popup
is blocked), step 2 accepts the pasted callback. The flow is manual because
`llm-gateway-9router` owns ports 1455 and 54545 on this host, so the portal
never listens for the redirect. Claude shows `code#state` in the browser; Codex
redirects to `http://localhost:1455/auth/callback?...`, which is copied whole
from the address bar. `POST /api/oauth/:provider/complete` then performs the
PKCE exchange server-side.

## Credential sync contract

Portal calls the internal Docker-network endpoint:

`PUT /api/internal/portal/connections/{externalId}`

The request uses `Authorization: Bearer <service token>` and contains
`accessToken`, `expiresAt`, `tokenVersion`, enabled state and safe identity
metadata. `refreshToken` is neither sent nor accepted. `tokenVersion` is
monotonic; 9Router returns `409` for stale writes.

Status and removal use `GET` and `DELETE` on the same URL. Tokens are never
returned by any response.

## Development

```sh
npm ci
npm run check
npm start
```

Node.js 22.13+ is required because the portal uses `node:sqlite`.

## Production

The zbs3 deployment uses `deploy/portal.override.yml`, the external volume
`llm-gateway_llm-portal-data`, and an env file at mode `0600`. Schema migrations
rename and extend the prototype tables in place; the existing database is not
reset.
