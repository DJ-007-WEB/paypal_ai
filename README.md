# Mandate — PayPal AI Hackathon

**Policy-aware purchasing with human-controlled, PayPal Sandbox payment authorization.**

Mandate turns a business purchasing request into a transparent vendor recommendation. It compares offers against hard constraints, independently validates the result against policy, and records the decision for review. A payment can only be started after an authorized approver records an approval, and a purchase is marked paid only after PayPal confirms a verified capture.

> **Safety invariant:** AI may assist with recommendations, deterministic code enforces policy, and a human with `purchases:approve` must authorize payment. AI never authorizes payment. PayPal is Sandbox-only; live credentials are rejected at startup.

## Current capabilities

- Deterministic purchase decision engine using integer currency minor units
- MongoDB-backed vendor offer catalog and validated import API
- Independent checks for budget, compatibility, inventory, delivery, approved vendors, quality, and reliability
- Express purchase evaluation/retrieval API with tenant isolation and audit events
- React/Vite purchase desk, purchase history, approvals, workspace settings, and supplier catalog
- Google OIDC sign-in with server-side sessions, CSRF protection, and durable OAuth transaction state
- Workspace memberships with roles, invitations, acceptance, and server-side permissions
- Human approval workflow with single-use atomic decisions
- PayPal Orders API (Sandbox) order creation, redirect, verified capture, cancellation, and status
- PayPal webhook handling with official signature verification and replay idempotency
- Optional Gmail read-only mailbox connection with encrypted refresh-token storage
- Optional OpenAI-compatible advisory AI for request parsing and decision explanations

## Architecture

```text
React/Vite frontend (/api)
        |
        v
Vercel rewrite or local Vite proxy
        |
        v
Express API (Render)
  |-- Google OIDC login + server sessions + CSRF
  |-- Workspace roles/permissions (tenant isolation)
  |-- Purchase evaluation -> deterministic engine + policy validator
  |-- Approval state machine (PENDING -> APPROVED/REJECTED)
  |-- PayPal Sandbox order -> payer approval -> verified capture
  |-- Webhook raw-body signature verification + event ledger
  |-- Audit events + MongoDB persistence
```

## Repository layout

```text
backend/    Express API, services, routes, tests
frontend/   React/Vite SPA, API client, pages
.github/    CI workflow
```

## Run locally

Requirements: Node.js 18.18+ and npm (developed with Node 24).

### Backend

```bash
cd backend
npm ci
cp ../.env.example .env   # then edit values
npm test
npm run dev
```

Health check: `curl http://localhost:3000/api/health`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The frontend always calls the relative base `/api`; Vite proxies it to `http://localhost:3000` by default. Override the local proxy target if needed:

```env
VITE_DEV_API_PROXY=http://localhost:3000
```

For a non-proxied API base, set `VITE_API_BASE_URL` at build time. Never place PayPal, Google, MongoDB, session, or encryption secrets in `VITE_*` variables — Vite embeds those in the browser bundle.

## Deployment

The supported topology is a Vercel frontend project (`frontend/`) proxying `/api/*` to a Render backend service (`backend/`). The browser stays on one origin, so session cookies and CSRF remain same-origin.

### Render backend

- Service root: `backend`
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/api/health`
- Set `TRUST_PROXY=true` when Render terminates TLS in front of the service.

Required production variables:

```env
NODE_ENV=production
PORT=<Render-provided port, or 3000>
MONGODB_URI=<Atlas connection string>
MONGODB_DB_NAME=mandate
FRONTEND_ORIGIN=https://paypal-aifrontend.vercel.app
APP_BASE_URL=https://paypal-ai-m3dq.onrender.com
FRONTEND_BASE_URL=https://paypal-aifrontend.vercel.app
TRUST_PROXY=true
SESSION_SECRET=<long random value>
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAME_SITE=lax
```

Google sign-in:

```env
GOOGLE_OIDC_ENABLED=true
GOOGLE_OIDC_CLIENT_ID=<Google client id>
GOOGLE_OIDC_CLIENT_SECRET=<Google client secret>
GOOGLE_OIDC_REDIRECT_URI=https://paypal-aifrontend.vercel.app/api/auth/google/callback
GOOGLE_OIDC_ISSUER=https://accounts.google.com
GOOGLE_OIDC_SCOPES=openid email profile
```

PayPal Sandbox:

```env
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=<PayPal Sandbox client id>
PAYPAL_CLIENT_SECRET=<PayPal Sandbox client secret>
PAYPAL_WEBHOOK_ID=<PayPal Sandbox webhook id>
PAYPAL_RETURN_URL=https://paypal-aifrontend.vercel.app/app/approvals?paypal=return
PAYPAL_CANCEL_URL=https://paypal-aifrontend.vercel.app/app/approvals?paypal=cancel
```

Optional Gmail mailbox connection:

```env
GOOGLE_GMAIL_ENABLED=true
GOOGLE_GMAIL_CLIENT_ID=<Google client id>
GOOGLE_GMAIL_CLIENT_SECRET=<Google client secret>
GOOGLE_GMAIL_REDIRECT_URI=https://paypal-aifrontend.vercel.app/api/integrations/google-gmail/callback
GOOGLE_GMAIL_SCOPES=https://www.googleapis.com/auth/gmail.readonly
TOKEN_ENCRYPTION_KEY=<base64 32-byte key or 64-char hex>
```

`KMS_KEY_ID` alone does not encrypt anything: no KMS client is implemented. Gmail refresh tokens are stored only when `TOKEN_ENCRYPTION_KEY` is valid.

### Vercel frontend

- Project root: `frontend`
- Framework preset: Vite
- Build command: `npm run build`
- Output directory: `dist`
- `frontend/vercel.json` rewrites `/api/:path*` to `https://paypal-ai-m3dq.onrender.com/api/:path*` and serves the SPA fallback for all other paths.
- Do not add backend secrets to Vercel. `VITE_*` values are public. `VITE_API_BASE_URL` is unnecessary when the rewrite/proxy is used.

### Google Cloud OAuth

Authorized JavaScript origin:

```text
https://paypal-aifrontend.vercel.app
```

Authorized redirect URIs:

```text
https://paypal-aifrontend.vercel.app/api/auth/google/callback
https://paypal-aifrontend.vercel.app/api/integrations/google-gmail/callback   # only if Gmail is enabled
```

Local development redirect URIs may additionally be registered:

```text
http://localhost:3000/api/auth/google/callback
http://localhost:3000/api/integrations/google-gmail/callback
```

### PayPal Dashboard

1. Use a PayPal Developer **Sandbox** app.
2. Add the return/cancel URLs shown above. PayPal appends `token` and `PayerID` to the return URL; the Approvals page matches `token` to the stored order.
3. Register a Sandbox webhook:
   - URL: `https://paypal-ai-m3dq.onrender.com/api/payments/webhook`
   - Events: `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.ORDER.DECLINED`, `CHECKOUT.ORDER.VOIDED`, `CHECKOUT.ORDER.CANCELLED`, `CHECKOUT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`
4. Copy the webhook ID into `PAYPAL_WEBHOOK_ID`.

The webhook route is intentionally public (PayPal cannot send a session or CSRF token). It verifies the signature with PayPal's `/v1/notifications/verify-webhook-signature` endpoint, matches the order/invoice/purchase to server-side records, and uses an event ledger to ignore replays.

### MongoDB Atlas

1. Create a cluster and database user with read/write access to `mandate`.
2. Allow the Render egress IPs (or `0.0.0.0/0` for a hackathon deployment).
3. Set `MONGODB_URI`. Collections and indexes are created on startup; if Mongo is unreachable, services that require persistence fail closed rather than pretending to save.

## Payment and approval invariants

- A purchase starts at `approvalStatus: PENDING`, `paymentStatus: NONE`.
- Only a policy-passing `RECOMMENDED` purchase that requires human approval can be approved.
- Approval/rejection is a single-use atomic compare-and-set; a second decision returns `409 ALREADY_DECIDED`.
- Payment creation requires `approvalStatus: APPROVED`, a stored recommendation, and the `purchases:approve` permission.
- The PayPal amount is the recommendation's `totalMinor`, never the budget ceiling and never a client-supplied value.
- Capture requires the stored PayPal order ID, server-side amount/currency verification, and a `COMPLETED` PayPal capture.
- The purchase becomes `paymentStatus: COMPLETED` only after verified capture or a verified `CHECKOUT.CAPTURE.COMPLETED` / `PAYMENT.CAPTURE.COMPLETED` webhook.
- Failed or unverified captures do not mark the purchase paid.

## API overview

```text
GET  /api/health
GET  /api/auth/google            Start Google OIDC
GET  /api/auth/google/callback   OIDC callback
GET  /api/auth/session           Current server session
GET  /api/auth/csrf              CSRF token
POST /api/auth/logout            Destroy session

GET  /api/workspaces/me
GET  /api/workspaces/current
POST /api/workspaces
GET  /api/workspaces/:tenantId
PATCH /api/workspaces/:tenantId
GET  /api/workspaces/:tenantId/members
POST /api/workspaces/:tenantId/members           Invite (status: invited)
POST /api/workspaces/:tenantId/members/accept    Accept invitation
PATCH /api/workspaces/:tenantId/members/:userId  Change role/status
GET  /api/workspaces/invitations
GET  /api/workspaces/:tenantId/business-email
POST /api/workspaces/:tenantId/business-email/verify

GET  /api/vendors
POST /api/vendors/import
POST /api/purchases/evaluate
POST /api/purchases/interpret
GET  /api/purchases
GET  /api/purchases/:purchaseId
POST /api/purchases/:purchaseId/explain
GET  /api/audit/events

GET  /api/approvals/pending
POST /api/approvals/purchase/:purchaseId/approve
POST /api/approvals/purchase/:purchaseId/reject

POST /api/payments/create/:purchaseId
POST /api/payments/capture/:purchaseId
POST /api/payments/cancel/:purchaseId
GET  /api/payments/status/:purchaseId
POST /api/payments/webhook

GET  /api/integrations/google-gmail/status
GET  /api/integrations/google-gmail/connect
GET  /api/integrations/google-gmail/callback
POST /api/integrations/google-gmail/disconnect
```

## Tests and checks

```bash
cd backend
npm test                 # exits naturally; currently 62 tests

cd ../frontend
npm run build
```

Optional frontend route check after build:

```bash
npm run preview
# open /, /login, /app/dashboard, /app/approvals
```

## Prototype limitations

- PayPal Sandbox only. Live PayPal is deliberately rejected.
- Business email verification is `owner-attested` unless the address matches the signed-in verified Google identity (`google-identity`); there is no independent email-delivery challenge.
- Gmail is read-only and only enabled when credentials and a valid encryption key are configured.
- No managed KMS client is implemented; `TOKEN_ENCRYPTION_KEY` is the only supported encryption-at-rest mechanism.
- This is a hackathon project, not audited financial software.

## License

See `LICENSE` for full licensing terms.
