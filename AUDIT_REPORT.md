# Mandate / PayPal AI — Audit Report

**Audit date:** 2026-11-09  
**Scope:** `frontend/` (React/Vite SPA), `backend/` (Express/MongoDB API), tests, CI, deployment configuration, documentation.  
**Method:** full source inventory, route/service review, configuration review, threat-model review, test execution, production build, and targeted regression tests.  
**Constraints preserved:** no fake authentication, no fake payment authorization, no fake Gmail connection, no fake approval state, tenant isolation, CSRF, OAuth state validation, PayPal Sandbox only.

---

## 1. Severity summary

| Severity | Found | Fixed | Remaining |
|---|---:|---:|---:|
| Critical | 6 | 6 | 0 |
| High | 9 | 9 | 0 |
| Medium | 11 | 11 | 0 |
| Low / documentation | 7 | 7 | 0 |
| External configuration still required | — | — | 4 |

“Remaining” below means code/config work still outstanding; external dashboard setup is listed separately.

---

## 2. Critical issues found and fixed

### C1. Approval endpoints were unimplemented while the UI implied they existed
- **Files:** `backend/src/routes/approval.routes.js`, `backend/src/app.js`, `frontend/src/App.jsx`, `frontend/src/pages/Approvals.jsx`
- **Issue:** approval endpoints returned 501 or were absent; the frontend had a broken local `ApprovalsPage` that rendered an undefined `Approvals` component. No real approval state machine existed.
- **Fix:** implemented server-permission-gated approval/rejection with a single-use atomic `PENDING -> APPROVED|REJECTED` compare-and-set. Added pending list, rationale capture, audit events, and an approval-gated payment flow. Replaced the broken local page with a real `frontend/src/pages/Approvals.jsx`.
- **Verification:** regression test confirms a purchaser gets 403, an owner can approve once, and a second decision returns `409 ALREADY_DECIDED`.

### C2. Payment could be created without a recorded human approval
- **Files:** `backend/src/routes/payment.routes.js`
- **Issue:** create/capture paths did not consistently require `approvalStatus: APPROVED` and `authorization.humanApproved`.
- **Fix:** both create and capture now fail closed with `409 APPROVAL_REQUIRED` unless an approval is stored. The route also requires a policy-passing `RECOMMENDED` recommendation.
- **Verification:** regression test confirms no PayPal order is created before approval.

### C3. Payment amount used the budget ceiling instead of the selected offer
- **Files:** `backend/src/routes/payment.routes.js`, `backend/src/services/paypal.service.js`
- **Issue:** the payment amount could be derived from the request budget rather than `recommendation.totalMinor`.
- **Fix:** the PayPal amount now comes from the stored recommendation in minor units, with currency-exponent handling. The budget is only an upper-bound check.
- **Verification:** regression test asserts the order amount is `400000` while the budget is `5000000`.

### C4. Payment completion did not require a verified PayPal capture
- **Files:** `backend/src/routes/payment.routes.js`, `backend/src/services/paypal.service.js`
- **Issue:** state transitions could mark a purchase paid without re-verifying the capture amount, currency, purchase, and tenant.
- **Fix:** capture verifies the stored order, expected amount/currency, purchase ID, and tenant. `paymentStatus: COMPLETED` is written only after a `COMPLETED` capture. Non-completed or failed captures transition to `CAPTURE_FAILED`, never `COMPLETED`.
- **Verification:** regression test with a fake `PENDING` capture returns 502 and leaves `paymentCaptured: false`.

### C5. OAuth transactions were memory-only and unsafe across instances/restarts
- **Files:** `backend/src/services/oauthTransaction.service.js` (new), `backend/src/routes/auth.routes.js`, `backend/src/routes/gmail.routes.js`, `backend/src/app.js`, `backend/src/server.js`
- **Issue:** OAuth state/PKCE transactions were stored only in memory. Multiple Render instances or a restart could lose state or accept stale state.
- **Fix:** added a durable Mongo-backed transaction store with single-use consumption, expiry, TTL index, and in-memory fallback for tests. Both Google login and Gmail connect use it.
- **Verification:** source review plus existing OAuth/security tests; transaction store is wired in `server.js`.

### C6. PayPal webhook verification was not using PayPal’s official verification API
- **Files:** `backend/src/routes/payment.routes.js`, `backend/src/services/paypal.service.js`, `backend/src/app.js`, `backend/src/services/webhookEvent.service.js` (new)
- **Issue:** the webhook relied on an ad-hoc HMAC interpretation and lacked a replay ledger.
- **Fix:** mounted the webhook before `express.json` so raw bytes are preserved; verify with PayPal `/v1/notifications/verify-webhook-signature`; correlate order/invoice/purchase to server-side records; store processed event IDs in a TTL-backed ledger.
- **Verification:** regression test returns 400 for an invalid signature and 503 when PayPal is not configured.

---

## 3. High issues found and fixed

### H1. Business email “verification” was not tied to identity
- **Files:** `backend/src/routes/workspace.routes.js`
- **Issue:** email verification could mark an arbitrary address verified without an independent challenge.
- **Fix:** labels verification as `owner-attested` unless the address matches the signed-in verified Google identity (`google-identity`). Gmail addresses must match the Google identity.

### H2. First-login workspace creation could create duplicate random tenants
- **Files:** `backend/src/services/tenant.service.js`, `backend/src/routes/auth.routes.js`
- **Issue:** repeated first-login races could create multiple personal workspaces.
- **Fix:** deterministic personal tenant ID derived from a SHA-256 slice of the user ID, idempotent tenant creation, and membership upsert.

### H3. Team invitations created active members immediately
- **Files:** `backend/src/services/tenant.service.js`, `backend/src/routes/workspace.routes.js`
- **Issue:** an invitee could receive access before accepting, and typed emails did not prove identity.
- **Fix:** invitations create `status: 'invited'` memberships with `invitedEmail`/`invitedAt`; a separate acceptance endpoint requires a matching signed-in identity and sets `active`/`acceptedAt`.

### H4. Gmail integration was scaffold-only despite UI/config
- **Files:** `backend/src/services/gmail.service.js`, `backend/src/routes/gmail.routes.js`
- **Issue:** connect/callback was a placeholder; no real code exchange, identity check, refresh, revoke, or durable encrypted token storage.
- **Fix:** real OIDC discovery/code exchange via `openid-client` v6, same-Google-identity check, required read-only Gmail scope, encrypted refresh-token storage, refresh/revoke/disconnect, and explicit failure states.

### H5. Gmail tokens could be stored without encryption
- **Files:** `backend/src/services/crypto.service.js`, `backend/src/config/index.js`
- **Issue:** `KMS_KEY_ID` was reported as usable although no KMS client existed; token storage could proceed without a valid key.
- **Fix:** encryption is available only with a valid `TOKEN_ENCRYPTION_KEY` (base64 32-byte or 64-char hex). `KMS_KEY_ID` alone logs a warning and does not claim availability. Gmail storage fails closed without encryption.

### H6. Session/CORS/proxy deployment mismatch
- **Files:** `frontend/src/api/client.js`, `frontend/vite.config.js`, `frontend/vercel.json`, `backend/src/config/index.js`
- **Issue:** the frontend defaulted to `http://localhost:3000/api`; Vercel had no `/api` proxy or SPA fallback; cross-origin cookies would fail.
- **Fix:** frontend defaults to same-origin `/api`; Vite proxies `/api` to the local backend; `frontend/vercel.json` proxies `/api/:path*` to Render and rewrites all other paths to `index.html`.

### H7. CSRF handling in the frontend was incomplete
- **Files:** `frontend/src/api/client.js`
- **Issue:** state-changing requests could omit the CSRF token or send JSON incorrectly.
- **Fix:** the client fetches `/api/auth/csrf`, attaches `X-CSRF-Token`, retries once after a CSRF failure, and sends correct JSON bodies.

### H8. PayPal return/cancel URLs pointed to the purchase form
- **Files:** `backend/src/config/index.js`, `.env.example`, `backend/.env.example`
- **Issue:** PayPal appended `token`/`PayerID` to a page that did not handle them.
- **Fix:** defaults now target `/app/approvals?paypal=return|cancel`; the Approvals page matches PayPal’s `token` to the stored order and captures or cancels explicitly.

### H9. Test suite did not exit naturally
- **Files:** `backend/tests/api.test.js`, `backend/tests/security.test.js`
- **Issue:** unawaited `server.close()` calls and one unclosed server left keep-alive handles open, so `npm test` hung.
- **Fix:** added `closeServer()` (`closeAllConnections()` + awaited close), replaced every close, and closed the background-job test’s server. Added focused approval/payment/webhook/config tests.

---

## 4. Medium issues found and fixed

| ID | Issue | Files | Fix |
|---|---|---|---|
| M1 | Payment/approval transitions used read-then-write upserts | `purchaseStore.service.js`, `approval.routes.js`, `payment.routes.js` | Atomic compare-and-set for payment and approval status, including expected order ID |
| M2 | Purchase records lacked top-level payment/approval state | `purchase.routes.js`, `purchaseStore.service.js` | Evaluations now store `approvalStatus: PENDING`, `paymentStatus: NONE`, and payment defaults |
| M3 | Webhook lookup had no tenant-free index | `purchaseStore.service.js`, `server.js` | Added top-level `paypalOrderId` and a lookup/index for webhook correlation |
| M4 | PayPal order reuse could double-create orders | `payment.routes.js` | Reuse existing `CREATED`/`APPROVED`/`CAPTURING` order; CAS `CREATING -> CREATED` |
| M5 | Rejection after capture was possible | `approval.routes.js` | Rejects any decision on `COMPLETED` payments with `PAYMENT_COMPLETED` |
| M6 | Approval re-decision returned a misleading 400 | `approval.routes.js` | Returns `409 ALREADY_DECIDED` before eligibility checks |
| M7 | PayPal fetch calls had no timeout | `paypal.service.js` | Added AbortController timeout and token caching |
| M8 | Currency exponent handling was inconsistent | `paypal.service.js` | Explicit minor-unit conversion for supported currencies |
| M9 | Payment cancel lacked state guards | `payment.routes.js` | Cancel is CAS-gated and cannot cancel a completed payment |
| M10 | Stale UI copy claimed payment/approval was locked/501 | `frontend/src/App.jsx`, `frontend/src/pages/Approvals.jsx` | Replaced with approval-gated Sandbox descriptions and real links |
| M11 | Workspace invite/accept and Gmail status were not exposed cleanly | `frontend/src/api/client.js`, `frontend/src/App.jsx` | Added client helpers and accurate server-backed status copy |

---

## 5. Low / documentation issues fixed

- Updated root `README.md` and `backend/README.md` for the real architecture, Sandbox-only PayPal, approval flow, webhook, Gmail, token encryption, tests, and deployment.
- Updated root and backend `.env.example` with `PAYPAL_WEBHOOK_ID`, correct return/cancel URLs, Gmail read-only scope, and KMS limitation.
- Added `frontend/vercel.json` with `/api` proxy and SPA fallback.
- Added `frontend/vite.config.js` dev proxy.
- Corrected permissions documentation (`purchases:approve`, not `purchases:create`).
- Corrected audit event names and webhook event names.
- Removed misleading “no real payment flow” / “approval endpoints return 501” claims.

---

## 6. Files changed / added

### Backend — added
- `backend/src/services/oauthTransaction.service.js`
- `backend/src/services/webhookEvent.service.js`

### Backend — changed
- `backend/src/app.js`
- `backend/src/config/index.js`
- `backend/src/server.js`
- `backend/src/routes/approval.routes.js`
- `backend/src/routes/auth.routes.js`
- `backend/src/routes/gmail.routes.js`
- `backend/src/routes/payment.routes.js`
- `backend/src/routes/purchase.routes.js`
- `backend/src/routes/workspace.routes.js`
- `backend/src/services/crypto.service.js`
- `backend/src/services/gmail.service.js`
- `backend/src/services/paypal.service.js`
- `backend/src/services/purchaseStore.service.js`
- `backend/src/services/tenant.service.js`
- `backend/src/services/user.service.js`
- `backend/tests/api.test.js`
- `backend/tests/security.test.js`
- `backend/.env.example`
- `backend/README.md`

### Frontend — added
- `frontend/src/pages/Approvals.jsx` (real implementation)
- `frontend/vercel.json`
- `frontend/.env.example`

### Frontend — changed
- `frontend/src/App.jsx`
- `frontend/src/api/client.js`
- `frontend/vite.config.js`

### Repository — changed
- `README.md`
- `.env.example`
- `AUDIT_REPORT.md` (this file)

---

## 7. Verification performed

### Backend

```text
cd backend
npm test
```

Result: **62 tests passed, 0 failed, process exits naturally.**

Coverage added/confirmed includes:
- sandbox-only PayPal configuration and paired credentials
- approval permission enforcement and single-use decisions
- payment requires approval
- payment amount uses recommendation total, not budget
- verified capture completes payment; unverified capture does not
- webhook invalid signature returns 400; unconfigured webhook returns 503
- tenant isolation, CSRF, session rotation, OAuth fail-closed, Gmail scope restrictions
- import validation and idempotency

### Frontend

```text
cd frontend
npm run build
```

Result: **Vite production build succeeded** (`35 modules transformed`, output in `dist/`). The only warning is the existing chunk-size advisory.

### Syntax checks

All modified backend source files and tests were checked with `node --check`.

---

## 8. External configuration still required (not code defects)

These cannot be completed from the repository; they must be applied in the provider dashboards:

1. **Render environment variables** — set `MONGODB_URI`, `SESSION_SECRET`, `GOOGLE_OIDC_*`, `PAYPAL_*` (including `PAYPAL_WEBHOOK_ID`), `FRONTEND_ORIGIN`, `APP_BASE_URL`, `FRONTEND_BASE_URL`, `TRUST_PROXY=true`, `SESSION_COOKIE_SECURE=true`. Do not put these in Vercel `VITE_*`.
2. **Google Cloud OAuth** — register authorized origin `https://paypal-aifrontend.vercel.app` and redirect URI `https://paypal-aifrontend.vercel.app/api/auth/google/callback` (plus Gmail callback only if enabled).
3. **PayPal Developer Sandbox** — create a Sandbox app, set return/cancel URLs to `https://paypal-aifrontend.vercel.app/app/approvals?paypal=return|cancel`, register webhook `https://paypal-ai-m3dq.onrender.com/api/payments/webhook`, and copy the webhook ID to Render.
4. **Vercel** — set the project root to `frontend`, framework Vite, build `npm run build`, output `dist`; `frontend/vercel.json` handles the API proxy and SPA fallback.

Live PayPal, Gmail, and Google OAuth were not exercised against provider sandboxes during this audit. The code paths fail closed when their configuration is absent.

---

## 9. Residual risks / notes

- PayPal Sandbox behavior can change; webhook verification depends on network access to PayPal’s verification endpoint.
- MongoDB Atlas network access and credentials must be correct; the API now fails closed instead of pretending to persist.
- Gmail refresh-token encryption requires a deliberate `TOKEN_ENCRYPTION_KEY`; no KMS client is implemented.
- Business email verification is honest about being `owner-attested` unless it matches the Google identity. It is not an independent email-delivery challenge.
- This remains a hackathon system and has not undergone a formal security audit or penetration test.
