# Mandate Backend API

## Prerequisites
- Node.js 18.18.0 or later
- npm 9+
- A reachable MongoDB instance

## Installation
From the backend directory:
```bash
npm install
```

## Environment configuration
Copy the example environment file to the backend directory and fill in secrets locally:
```bash
cp backend/.env.example backend/.env
```
Set `MONGODB_URI` in `backend/.env` to your connection string. Do not commit or share that file (`.env` is git-ignored; only `.env.example` with placeholders is committed).

See `backend/.env.example` for every required variable (runtime, session, Google OIDC sign-in, optional Gmail mailbox connection, encryption, rate limits, logging). Key rules:
- `GOOGLE_OIDC_ENABLED=false` until client ID/secret + exact `GOOGLE_OIDC_REDIRECT_URI` are registered in Google Cloud Console. Missing credentials never enable demo auth — protected routes fail closed with 401.
- `GOOGLE_GMAIL_ENABLED=false` until mailbox scopes, credentials, callback, and token encryption (`TOKEN_ENCRYPTION_KEY` or `KMS_KEY_ID`) are deliberately configured. Sign-in scopes stay identity-only (`openid email profile`).
- Production startup rejects insecure config: HTTP base/callback URLs, `SESSION_COOKIE_SECURE=false`, weak `SESSION_SECRET`, localhost `FRONTEND_ORIGIN`, or blind `TRUST_PROXY=true`.
- Never prefix server secrets with `VITE_*` and never place secrets in frontend code, browser storage, URLs, or logs.

MongoDB is required at startup. Vendor offers are read from the `vendorOffers` collection (tenant-scoped `{ tenantId, offerId }`). Identity (`users`), workspaces (`tenants`), memberships (`memberships`), sessions (`sessions`), and Gmail connections (`gmailConnections`) are now durable collections with tenant-aware indexes. See `backend/scripts/migrate-tenant-isolation.js --dry-run` before building compound indexes on legacy data — never auto-assign legacy records to one tenant.

## Commands
```bash
npm run dev
npm start
npm test
```

## API endpoints
- `GET /api/health` (public)
- `GET /api/auth/google` → Google OIDC start (501 when `GOOGLE_OIDC_ENABLED=false`); `GET /api/auth/google/callback`; `GET /api/auth/session`; `GET /api/auth/csrf`; `POST /api/auth/logout`
- `GET /api/workspaces/me`, `GET /api/workspaces/current`, `POST /api/workspaces`, `GET/PATCH /api/workspaces/:tenantId`, member invite/update, `GET/POST /api/workspaces/:tenantId/business-email[/verify]`
- `GET /api/vendors` (requires `vendors:read` + server-resolved tenant)
- `POST /api/vendors/import` (requires `vendors:import`; per-tenant quotas + `Idempotency-Key`/`importId` replay; payload `tenantId` never trusted)
- `POST /api/purchases/evaluate` (requires `purchases:create`); `GET /api/purchases/:purchaseId` and `GET /api/purchases` (require `purchases:read`; cross-tenant IDs return generic 404)
- `GET /api/audit/events` (requires `audit:read`, tenant-scoped)
- `GET /api/integrations/google-gmail/status|connect|callback`, `POST /api/integrations/google-gmail/disconnect` (disabled with 501 until `GOOGLE_GMAIL_ENABLED`; separate consent from sign-in)
- Approval, payment and mandate routes intentionally return 501. No real payment authorization or execution is active (`paymentAuthorized: false` throughout).

## Vendor offer import
Send JSON to `POST /api/vendors/import`:
```json
{
  "offers": [{
    "offerId": "offer-001",
    "vendorId": "vendor-001",
    "vendorName": "Example Supplier",
    "productId": "BRG-6204",
    "currency": "INR",
    "unitPriceMinor": 125000,
    "availableQuantity": 100,
    "deliveryDays": 4,
    "shippingMinor": 0,
    "taxMinor": 22500,
    "feesMinor": 0,
    "vendorApproved": true,
    "qualityScore": 90,
    "reliabilityScore": 92,
    "active": true
  }]
}
```
Amounts are integer minor units (INR paise). Shipping, tax and fees must be explicit, even when their value is zero. The importer validates input and upserts by `offerId`.

## Request flow
1. Express validates the incoming purchase request.
2. Vendor service queries active offers in MongoDB for the requested product.
3. The deterministic decision engine ranks eligible offers.
4. A separate policy service validates hard constraints.
5. Audit events and purchase records are currently stored in memory.
6. The response returns a recommendation and policy findings, never payment authorization.

## Limitations / known issues
- Without MongoDB, services fall back to in-memory stores (tests) that reset on restart; production must use MongoDB with the tenant-aware indexes created in `src/server.js`.
- Legacy records without `tenantId` are quarantined by `scripts/migrate-tenant-isolation.js` — no automatic default-tenant assignment. Run `--dry-run`, back up, reconcile ownership, then build compound indexes.
- Session store defaults to in-memory unless a `sessions` collection is wired (production should use a shared durable store; a warning is logged otherwise).
- Gmail mailbox features are scaffold-only until credentials, scopes, callback, token encryption, and provider tests are configured; status reports `enabled: false` until then.
- Approval and payment execution remain disabled (501; `paymentAuthorized: false`).
- No external AI call or real PayPal payment flow is active.
- Threat model (for PR): untrusted client tenant IDs, session hijacking, OAuth replay, cross-tenant ID guessing, overly broad Gmail scopes, secret leakage via logs/responses, and import abuse are mitigated by server-resolved tenant context, HttpOnly+Secure+SameSite cookies + rotation + CSRF, state/nonce/PKCE + single-use transactions + exact redirect allowlists, generic 404s, narrow identity-only login scopes + encrypted mailbox tokens, redacted logging/safe errors, and rate limits + per-tenant import quotas. Deferred: shared session store in multi-instance prod, KMS envelope encryption, dependency/secret scanning in CI, encrypted backups + restore rehearsal, and alerting on repeated authz failures.
