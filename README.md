# AZOX LLM Portal

Internal account portal for the `llm-gateway` Docker stack.

## Scope

- Providers: Claude and Codex OAuth only.
- Model catalog: a reference-only table seeded once from the 2026-10-01
  `azox-llm-gateway` README snapshot (20 models). Any signed-in user can view
  tier, family, status (`active`/`inactive`), and input/output USD prices per
  million tokens. All seeded and existing models default to `inactive` after
  migration. Admins can add, edit, reorder, delete, or toggle a model; new
  models default to inactive. Each model can belong to zero or more tiers and
  zero or more families. Tiers and families are admin-managed catalogs: admins
  can add, rename, or delete either; deleting one unlinks it from every model.
  IDs increase and are not reused. Migration creates the tiers `model-ultra`,
  `model-max`, `model-high`, `model-medium` (IDs 1–4) once and keeps every
  existing model's tier links; the legacy `model_catalog.tiers` JSON column is
  kept in sync so an older image can still be rolled back to. Families start
  empty (no preset names). Changes are local to Portal and never change
  routing, LiteLLM prices, billing, or gateway availability. The seed includes
  models listed as Testing or Deprecated; it does not track those lifecycle
  labels or sync future README changes automatically.
- Operation results (success and failure) appear as a top-center toast that
  hides after 3 seconds. Input validation errors stay next to their form.
- Admin-created username/password users; users may change password at any time.
- Admin surface mirrors the 9Router dashboard: create user, reset a chosen
  password, disable/enable, and remove a user with its router connections.
- Login has two tabs like 9Router: username/password for users, and an
  admin-password form that signs in as `INIT_ADMIN_USERNAME`.
- Provider accounts are owner-scoped for regular users. Administrators can
  inspect and operate every provider account.
- Account labels are the full upstream email or account name, unmasked, and
  every surface shows `Sponsored by: <portal user>` beneath it.
- Quota Tracker reads upstream quota. A background policy checks the session
  window every five minutes, auto-disables accounts at or below the configured
  remaining-percent threshold (30% by default), and auto-enables only those
  policy-disabled accounts after the session resets. Both actions default on
  and can be changed by an administrator.
- Portal is the canonical credential owner. Its admin-configured refresh lead is
  read on every scheduler tick, with a 10-minute minimum gap between successful
  refreshes of the same account. It keeps the refresh token encrypted at rest
  and pushes only the access token, expiry and identity metadata to 9Router and
  OmniRoute.

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
monotonic; each router returns `409` for stale writes.

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

The zbs0 deployment uses `deploy/portal.override.yml`, the external volume
`llm-gateway_llm-portal-data`, and an env file at mode `0600`. Schema migrations
rename and extend the prototype tables in place; the existing database is not
reset.
