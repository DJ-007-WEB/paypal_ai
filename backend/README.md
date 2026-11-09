# Mandate Backend API

Express + MongoDB API for Mandate. See the repository root `README.md` for full deployment instructions.

## Prerequisites

- Node.js 18.18.0 or later
- npm 9+
- A reachable MongoDB instance (production), or the in-memory stores used by tests

## Installation

```bash
cd backend
npm ci
cp ../.env.example .env
npm test
npm run dev
```

## Environment configuration

Set `MONGODB_URI` and the other values in `backend/.env` (or Render environment variables). Never commit `.env`; only `.env.example` with placeholders is committed.

Key rules:

- `GOOGLE_OIDC_ENABLED=false` until the client ID/secret and exact redirect URI are registered. Missing credentials never enable fake auth — protected routes fail closed with 401.
- `GOOGLE_GMAIL_ENABLED=false` until credentials, callback, the read-only scope, and `TOKEN_ENCRYPTION_KEY` are configured. Sign-in scopes stay identity-only.
- `PAYPAL_ENV=sandbox` only. Live PayPal is rejected at startup. Credentials must be paired, and `PAYPAL_WEBHOOK_ID` is required in production when PayPal is enabled.
- `KMS_KEY_ID` alone is not implemented. Set `TOKEN_ENCRYPTION_KEY` (base64 32-byte key or 64-char hex) to encrypt Gmail refresh tokens.
- Production startup rejects insecure configuration: HTTP base/callback URLs, `SESSION_COOKIE_SECURE=false`, weak `SESSION_SECRET`, localhost `FRONTEND_ORIGIN`, or blind `TRUST_PROXY=true`. Behind Render's single reverse proxy, set the explicit hop count `TRUST_PROXY=1`.
- Never prefix server secrets with `VITE_*` and never place them in frontend code, browser storage, URLs, or logs.

MongoDB collections used in production: `vendorOffers`, `users`, `tenants`, `memberships`, `sessions`, `purchases`, `auditEvents`, `gmailConnections`, `oauthTransactions`, `paypalWebhookEvents`. Indexes are created in `src/server.js`. `scripts/migrate-tenant-isolation.js --dry-run` should be reviewed before applying compound indexes to legacy data.

If Mongo is unreachable, persistence-backed services fail closed rather than silently claiming a write succeeded. Tests use explicit in-memory fakes.

## Commands

```bash
npm run dev    # node --watch src/server.js
npm start      # node src/server.js
npm test       # node --test tests/*.test.js
```

## API endpoints

- `GET /api/health` (public)
- `GET /api/auth/google`, `GET /api/auth/google/callback`, `GET /api/auth/session`, `GET /api/auth/csrf`, `POST /api/auth/logout`
- `GET /api/workspaces/me`, `GET /api/workspaces/current`, `POST /api/workspaces`, `GET/PATCH /api/workspaces/:tenantId`
- `GET/POST /api/workspaces/:tenantId/members`, `POST /api/workspaces/:tenantId/members/accept`, `PATCH /api/workspaces/:tenantId/members/:userId`, `GET /api/workspaces/invitations`
- `GET/POST /api/workspaces/:tenantId/business-email[/verify]`
- `GET /api/vendors` (`vendors:read`), `POST /api/vendors/import` (`vendors:import`)
- `POST /api/purchases/evaluate` (`purchases:create`), `GET /api/purchases` and `GET /api/purchases/:purchaseId` (`purchases:read`)
- `POST /api/purchases/interpret`, `POST /api/purchases/:purchaseId/explain`
- `GET /api/audit/events` (`audit:read`)
- `GET /api/approvals/pending` (`purchases:read`)
- `POST /api/approvals/purchase/:purchaseId/approve|reject` (`purchases:approve`)
- `POST /api/payments/create|capture|cancel/:purchaseId` (`purchases:approve`), `GET /api/payments/status/:purchaseId` (`purchases:read`)
- `POST /api/payments/webhook` (public by design; PayPal signature verification, no session/CSRF)
- `GET /api/integrations/google-gmail/status|connect|callback`, `POST /api/integrations/google-gmail/disconnect`

Approval and payment routes are active. Nothing is marked paid until PayPal returns a verified capture whose amount, currency, purchase, and tenant match server-side records.

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

Amounts are integer minor units (INR paise). Shipping, tax, and fees must be explicit, even when zero. The importer validates input and upserts by `{ tenantId, offerId }`.

## Request flow

1. Express validates the incoming purchase request.
2. Vendor service queries active offers for the server-resolved tenant.
3. The deterministic decision engine ranks eligible offers.
4. A separate policy service validates hard constraints.
5. The purchase record is stored with `approvalStatus: PENDING`, `paymentStatus: NONE`.
6. An authorized approver records a decision (single-use CAS).
7. Payment order creation uses the stored recommendation amount, not the budget ceiling.
8. Capture/webhook verification is required before `paymentStatus: COMPLETED`.

## Tests

```bash
npm test
```

The suite covers authentication, CSRF, tenant isolation, permissions, vendor import, decision-engine behavior, approval single-use semantics, recommendation-based payment amounts, unverified-capture behavior, webhook signature failure, and sandbox-only configuration. It exits naturally.

## Limitations / known issues

- In-memory stores are used only in tests. Production requires MongoDB.
- No managed KMS client exists; only `TOKEN_ENCRYPTION_KEY` encrypts tokens at rest.
- Business email verification is `owner-attested` unless it matches the signed-in verified Google identity.
- Gmail is read-only and disabled unless fully configured.
- PayPal is Sandbox-only.
