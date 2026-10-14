# Mandate / PayPal AI — Security Implementation Plan
## Google Sign-In, Business Gmail, Authorization, Tenant Isolation, and Backend Hardening

**Repository:** `DJ-007-WEB/paypal_ai`  
**Target branch:** Create a dedicated feature branch from the latest `main`  
**Status:** Implementation specification — review before coding  
**Change policy:** Implement backend/security behavior first, then minimally wire the existing frontend. Do not redesign the UI/UX.  
**Payment policy:** Recommendations must never authorize or execute a payment. Real payment execution remains out of scope and disabled.

---

## 1. Goal and non-negotiable rules

Implement a secure foundation so multiple businesses can use Mandate without seeing, changing, or processing each other's data.

The implementation must include:

1. Google OpenID Connect sign-in and logout.
2. A secure application session and real authentication middleware.
3. Workspace membership and server-side authorization.
4. Mandatory tenant context for every business-data operation.
5. Tenant-scoped MongoDB reads, writes, updates, imports, indexes, and audit records.
6. Business Gmail address verification, distinct from mailbox access.
7. A separately consented Gmail OAuth connection scaffold for future mailbox features.
8. Safe import, background-job, and migration patterns.
9. Security controls for secrets, sessions, CORS, CSRF, rate limits, errors, logging, and database access.
10. Tests proving cross-tenant access is denied.
11. Environment variable names and backend configuration/logic for all required credentials, with placeholders only.
12. No unnecessary UI/UX changes and no decision-engine behavior changes.

### Safety invariants

- Authentication establishes identity; it does not establish workspace permissions.
- A typed email, `tenantId`, `workspaceId`, request header, query parameter, or local-storage value never proves ownership or authorization.
- The backend resolves tenant context from a validated session and active workspace membership.
- Every tenant-owned query must be tenant-scoped at the repository/service layer, not merely filtered in route code.
- Missing or invalid tenant context fails closed.
- No cross-tenant fallback, “default tenant,” or unscoped query is permitted in normal business flows.
- OAuth credentials and secrets never appear in frontend code, `VITE_*` variables, browser storage, API responses, URLs, audit events, or logs.
- Google sign-in does not grant Gmail mailbox authorization.
- No payment endpoint is enabled by this implementation. `paymentAuthorized: false` and human-controlled approval remain intact.
- Never disable security controls merely to make tests or local development pass.
- Keep the current design, component structure, and purchase decision logic intact unless a documented security requirement demands a narrowly scoped API change.

---

## 2. Repository baseline and implementation process

Before editing:

1. Fetch the latest `main` and record its commit SHA.
2. Create a feature branch, e.g. `security/google-auth-tenant-isolation`.
3. Inspect current routes, MongoDB collection names/indexes, frontend login/signup/workspace flow, tests, and deployment configuration.
4. Capture screenshots of the existing landing page, login/signup, workspace, purchase evaluation, and vendor import screens.
5. Run current backend tests and frontend build. Record results without hiding pre-existing failures.
6. Add a concise threat model to the pull request.
7. Never commit `.env`, `.env.local`, OAuth client secrets, database credentials, token-encryption keys, or real customer data.

Implement in small, reviewable commits. Preserve existing tests and add security regression tests before refactoring data access.

---

## 3. Target architecture

```text
Browser
  |
  | HTTPS + secure session cookie
  v
Express request ID / safe logging / limits
  |
  v
Authentication middleware
  |-- validate application session
  |-- load active user
  v
Workspace resolution + membership authorization
  |-- server-resolved tenantId
  |-- active membership + permission check
  v
Strict request validation
  |
  v
Tenant-scoped service/repository APIs
  |-- tenant-owned vendor catalog
  |-- tenant-owned purchase records
  |-- tenant-owned audit events
  |-- tenant-owned imports/settings/connections
  v
Existing deterministic purchase engine
  |
  v
Policy validation + human review (no payment execution)
```

Tenant context must be created by backend middleware after membership verification. A client can request a workspace selection, but the server must validate membership before granting context.

### Suggested request context

```js
req.auth = Object.freeze({
  userId,
  tenantId,
  membershipId,
  role,
  permissions,
  sessionId
});
```

This object must be set only by verified server middleware. Do not trust client-supplied `req.auth`, and do not store the active tenant in process-global mutable state.

---

## 4. Authentication: Google OpenID Connect

### 4.1 Implementation requirements

Implement authorization-code flow with OIDC protections, using a maintained Google-supported library or well-maintained OIDC client.

1. Start from a backend endpoint such as `GET /api/auth/google`.
2. Generate cryptographically random `state` and `nonce`; use PKCE where supported by the chosen flow.
3. Store short-lived OAuth transaction state server-side or in a properly protected transaction cookie.
4. Use an exact, allowlisted callback URI.
5. Exchange the authorization code on the server only.
6. Validate signature, issuer, audience, expiry, nonce, and transaction state through the selected library.
7. Use Google's stable `sub` claim as the external identity key.
8. Require a verified email claim where the product relies on email ownership.
9. Create/update the local user record using an explicit account-linking policy.
10. Rotate the application session after successful login.
11. Redirect only to a fixed, allowlisted frontend destination; do not accept arbitrary return URLs.
12. Audit sign-in outcomes without storing authorization codes or tokens.
13. Implement logout, session invalidation, and bounded session expiry.
14. Handle cancellation, provider outage, expired transactions, revoked access, and callback replay safely.

Do not hand-roll JWT verification or trust a decoded token without cryptographic verification. Do not log callback query strings, which may contain authorization codes or provider error details.

### 4.2 Google login scopes

Start with identity scopes only:

- `openid`
- `email`
- `profile` only if the product actually uses profile fields.

Do not request Gmail scopes during ordinary login.

### 4.3 User identity and account linking

Persist users keyed by Google `sub` (unique). Email is mutable and is not the stable identity key.

- Do not automatically link accounts because email strings match.
- Require a logged-in, deliberate account-linking process.
- Re-authenticate before high-risk account linking/unlinking.
- Audit account linking/unlinking.
- Define recovery behavior if a provider identity becomes unavailable.

### 4.4 Session approach

Prefer a server-side session backed by a production-appropriate shared store. Do not rely on Express MemoryStore in production.

Session cookies must use:

- `HttpOnly`
- `Secure` in HTTPS deployments
- A carefully chosen `SameSite` policy compatible with the OAuth callback and frontend/backend deployment
- Narrow path/domain
- Bounded idle and absolute lifetimes

Rotate the session ID after login, workspace privilege changes, and account linking. Invalidate sessions on logout and, where feasible, after membership revocation or account disablement.

Use CSRF protection for state-changing cookie-authenticated requests. Do not put session IDs, refresh tokens, access tokens, or OAuth secrets in local storage.

---

## 5. Business Gmail: two separate capabilities

### 5.1 Business address verification

The workspace's business email field is contact information until the backend verifies it.

- Require authentication and a permission such as `workspace:manage` or `business_email:verify`.
- Normalize the address for comparison, but do not treat normalization as proof of ownership.
- Verify using a trusted Google identity or an explicit verification procedure.
- Record `businessEmail`, `businessEmailVerifiedAt`, `businessEmailVerifiedByUserId`, and verification method.
- Audit changes.
- A typed address must never create a user, owner, or workspace membership automatically.
- A Gmail address alone does not prove legal ownership of a company.

If the signed-in Google identity is used, verify it server-side and ensure the verified address corresponds to the intended business address. Otherwise require an explicit account-switch/verification flow.

For future company-domain email support, consider domain ownership verification (e.g. DNS TXT challenge) as a separate feature.

### 5.2 Separate Gmail mailbox OAuth connection

Only enable mailbox scopes if a real product feature requires Gmail API access. “Connect business Gmail” must be separate from sign-in.

- Use separate OAuth consent and a dedicated callback.
- Use `state`, PKCE where appropriate, exact redirect URI allowlists, and server-side code exchange.
- Request the narrowest scopes needed for the feature.
- Do not request read/send/modify scopes just because the workspace stores a business email.
- Bind each connection to `tenantId`, `connectedByUserId`, Google `sub`, mailbox email, granted scopes, and status.
- Only authorized owners/admins can connect, replace, or disconnect a workspace mailbox.
- Encrypt refresh tokens at rest using envelope encryption and a managed KMS/key service where available.
- Never expose tokens to frontend JavaScript or return them through APIs.
- Handle refresh failure, revoked consent, account changes, disconnect, and reauthorization.
- Provide disconnect/revocation and delete or revoke credentials according to the retention policy.
- Never use a login token as a mailbox credential.

If Gmail features are not being built yet, implement configuration, service boundaries, database schema, and safe “not configured” behavior. Do not claim mailbox access works until credentials, consent, token storage, and provider tests are configured.

---

## 6. Environment configuration: add every variable now, credentials later

Create/update `backend/.env.example` with documented placeholders for every required variable. Keep real `backend/.env` local and ignored by Git. If a real `.env` already exists, add variable names locally without overwriting existing secrets.

Never prefix server secrets with `VITE_`.

### 6.1 Backend environment variables

| Variable | Purpose and required behavior |
|---|---|
| `NODE_ENV` | Runtime mode (`development`, `test`, `production`); production is secure by default. |
| `PORT` | API listen port. |
| `MONGODB_URI` | Required MongoDB URI; never log it. |
| `MONGODB_DB_NAME` | Explicit database name; required explicitly in production. |
| `FRONTEND_ORIGIN` | Exact comma-separated allowed frontend origins; production must not use localhost defaults. |
| `APP_BASE_URL` | Canonical public backend origin; used for callback validation, not derived from incoming `Host`. |
| `FRONTEND_BASE_URL` | Canonical frontend origin for allowlisted redirects. |
| `SESSION_SECRET` | Cryptographically random secret if required by selected session/transaction implementation; reject weak/missing values in production. Document an alternative if not used. |
| `SESSION_COOKIE_NAME` | Session cookie name; use a `__Host-` prefix when compatible with deployment. |
| `SESSION_IDLE_TIMEOUT_SECONDS` | Positive bounded idle timeout. |
| `SESSION_ABSOLUTE_TIMEOUT_SECONDS` | Positive bounded absolute lifetime. |
| `SESSION_COOKIE_SECURE` | Must be true in production HTTPS deployments. |
| `SESSION_COOKIE_SAME_SITE` | Validated SameSite value compatible with the chosen OAuth/session architecture. |
| `SESSION_COOKIE_DOMAIN` | Optional; prefer host-only unless deployment explicitly needs a domain. |
| `GOOGLE_OIDC_ENABLED` | False until credentials and callback are configured; no fake-auth fallback. |
| `GOOGLE_OIDC_CLIENT_ID` | Google OIDC client ID. |
| `GOOGLE_OIDC_CLIENT_SECRET` | Google OIDC client secret; server-side only. |
| `GOOGLE_OIDC_REDIRECT_URI` | Exact registered sign-in callback URL. |
| `GOOGLE_OIDC_ISSUER` | Expected Google issuer validated by the trusted OIDC library. |
| `GOOGLE_OIDC_SCOPES` | Identity scopes only; `openid email profile` only if profile is needed. |
| `GOOGLE_GMAIL_ENABLED` | False until mailbox integration is deliberately configured. |
| `GOOGLE_GMAIL_CLIENT_ID` | Optional Gmail OAuth client ID; separate variable for clarity even if intentionally shared. |
| `GOOGLE_GMAIL_CLIENT_SECRET` | Optional Gmail OAuth client secret; server-side only. |
| `GOOGLE_GMAIL_REDIRECT_URI` | Exact registered mailbox OAuth callback URL. |
| `GOOGLE_GMAIL_SCOPES` | Empty/minimal until a specific feature and scopes are approved. |
| `TOKEN_ENCRYPTION_KEY` | Optional application-managed key if KMS is unavailable; strict encoding/length, rotation, and startup validation required. Prefer KMS. |
| `KMS_KEY_ID` | Managed encryption-key reference; deployment-specific. |
| `TRUST_PROXY` | Explicit proxy trust configuration; never blindly trust all proxies. |
| `RATE_LIMIT_WINDOW_MS` | Positive bounded rate-limit window. |
| `RATE_LIMIT_MAX_REQUESTS` | General API limit; route-specific limits also required. |
| `AUTH_RATE_LIMIT_MAX_REQUESTS` | Login/OAuth start/callback limit. |
| `IMPORT_RATE_LIMIT_MAX_REQUESTS` | Import endpoint limit; also use per-tenant quotas. |
| `MAX_JSON_BODY_BYTES` | Bounded JSON body limit. |
| `MAX_IMPORT_ROWS` | Hard import row limit, plus per-tenant daily/concurrency quotas. |
| `LOG_LEVEL` | Structured logging level; no verbose secret-bearing logs in production. |
| `AUDIT_RETENTION_DAYS` | Retention setting aligned with business/legal requirements. |
| `APP_ENV_LABEL` | Optional non-secret deployment label. |

### 6.2 Template to add to `backend/.env.example`

```dotenv
# Runtime
NODE_ENV=development
PORT=3000
MONGODB_URI=
MONGODB_DB_NAME=mandate
FRONTEND_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
APP_BASE_URL=http://localhost:3000
FRONTEND_BASE_URL=http://localhost:5173
TRUST_PROXY=false

# Application session
SESSION_SECRET=
SESSION_COOKIE_NAME=mandate.sid
SESSION_IDLE_TIMEOUT_SECONDS=1800
SESSION_ABSOLUTE_TIMEOUT_SECONDS=28800
SESSION_COOKIE_SECURE=false
SESSION_COOKIE_SAME_SITE=lax
SESSION_COOKIE_DOMAIN=

# Google sign-in (OIDC)
GOOGLE_OIDC_ENABLED=false
GOOGLE_OIDC_CLIENT_ID=
GOOGLE_OIDC_CLIENT_SECRET=
GOOGLE_OIDC_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
GOOGLE_OIDC_ISSUER=https://accounts.google.com
GOOGLE_OIDC_SCOPES=openid email profile

# Optional Google Gmail mailbox connection (separate from login)
GOOGLE_GMAIL_ENABLED=false
GOOGLE_GMAIL_CLIENT_ID=
GOOGLE_GMAIL_CLIENT_SECRET=
GOOGLE_GMAIL_REDIRECT_URI=http://localhost:3000/api/integrations/google-gmail/callback
GOOGLE_GMAIL_SCOPES=

# Encryption (prefer managed KMS in production)
TOKEN_ENCRYPTION_KEY=
KMS_KEY_ID=

# Abuse protection and payload limits
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=120
AUTH_RATE_LIMIT_MAX_REQUESTS=10
IMPORT_RATE_LIMIT_MAX_REQUESTS=5
MAX_JSON_BODY_BYTES=1048576
MAX_IMPORT_ROWS=2000

# Logging and audit
LOG_LEVEL=info
AUDIT_RETENTION_DAYS=365
APP_ENV_LABEL=local
```

### 6.3 Important configuration notes

- Reconcile the template with the exact session store, OIDC client, rate limiter, and deployment chosen.
- `SESSION_COOKIE_SECURE=false` is local HTTP-only configuration. Production startup must reject it.
- A `__Host-` cookie requires `Secure`, `Path=/`, and no `Domain`. If local HTTP testing cannot support it, use a documented local-only cookie name; do not weaken production defaults.
- Production base/callback URLs must use HTTPS.
- Gmail scopes remain empty until a feature requires them.
- Missing OIDC credentials must never enable demo authentication. The server may start with OIDC disabled for local development, but protected business routes remain inaccessible unless an explicitly isolated test harness supplies a test principal.
- Validate all variables at startup. Fail clearly on unsafe production configuration and never print secret values.
- Do not invent credentials; leave values blank/placeholders for the repository owner.

### 6.4 Central configuration module

Create a backend config module that:

- Parses and validates environment variables once at startup.
- Validates URLs, schemes, origins, numeric limits, and cookie settings.
- Rejects weak/missing session secrets in production where required.
- Rejects production HTTP callback/base URLs and insecure production cookies.
- Ensures enabled OIDC/Gmail features have all required credentials and exact redirect URIs.
- Never derives OAuth callback URLs from arbitrary `Host` headers.
- Exposes only a sanitized configuration object to app code.
- Never logs secrets.
- Fails closed for any enabled feature with missing configuration.
- Logs integration status only, not credential values.

---

## 7. Workspace, membership, and permission model

### 7.1 Suggested collections

**`users`**
- `userId`
- `googleSubject` (unique)
- `email`
- `emailVerified`
- `displayName` (if required)
- `status`
- `createdAt`, `updatedAt`, `lastLoginAt`

**`tenants` / `workspaces`**
- `tenantId`
- `businessName`
- `businessEmail`
- `businessEmailVerifiedAt`
- `businessEmailVerifiedByUserId`
- `businessEmailVerificationMethod`
- `status`
- `createdAt`, `updatedAt`

**`memberships`**
- `tenantId`
- `userId`
- `role` or explicit permission set
- `status`
- `invitedByUserId`
- `createdAt`, `updatedAt`

Create a unique index on `{ tenantId: 1, userId: 1 }`.

### 7.2 Initial roles

- **Owner:** workspace ownership, security settings, member management, business mailbox management.
- **Admin:** delegated workspace/member management.
- **Purchaser:** create/evaluate purchases and read permitted purchase records.
- **Approver:** future approval capability only after the workflow exists.
- **Read-only/Auditor:** read permitted records and audit history only.

Prefer explicit permissions:

- `workspace:read`, `workspace:manage`
- `members:read`, `members:invite`, `members:manage`
- `vendors:read`, `vendors:import`, `vendors:manage`
- `purchases:create`, `purchases:read`, `purchases:approve`
- `audit:read`
- `gmail:connect`, `gmail:use`, `gmail:disconnect`

Do not activate payment execution permissions in this milestone.

### 7.3 First-owner bootstrap

Define a safe workspace bootstrap procedure. Do not make the first arbitrary user who signs in an owner of an existing business workspace. Use explicit invitation, controlled provisioning, or a one-time bootstrap token supplied through deployment secrets. Disable it after use, never log it, and never expose it to the frontend. Document owner recovery and transfer.

---

## 8. Authorization middleware and route inventory

Implement consistent, testable middleware:

- `requireAuthentication`
- `requireActiveUser`
- `resolveWorkspaceMembership`
- `requirePermission(permission)`
- `requireTenantContext`
- `validateRequest(schema)`

### Required route behavior

| Route/action | Authentication | Permission | Tenant required |
|---|---|---|---|
| `GET /api/health` | Public | None | No; disclose no secrets |
| Google sign-in/callback/logout | Special auth flow | N/A | No tenant until membership is resolved |
| `GET /api/vendors` | Required | `vendors:read` | Yes |
| `POST /api/vendors/import` | Required | `vendors:import` | Yes |
| `POST /api/purchases/evaluate` | Required | `purchases:create` | Yes |
| `GET /api/purchases/:purchaseId` | Required | `purchases:read` | Yes |
| Workspace settings | Required | `workspace:read` / `workspace:manage` | Yes |
| Business email verification/update | Required | Explicit workspace permission | Yes |
| Gmail connect/disconnect/status | Required | `gmail:connect` / `gmail:disconnect` | Yes |
| Future audit endpoints | Required | `audit:read` | Yes |
| Approval/payment stubs | Explicitly deny unauthorized business access; do not activate execution | No new execution permission | Yes when reading workspace data |

For a resource owned by another tenant, return a generic `404` where appropriate to avoid confirming its existence. Use `401` for missing/invalid authentication and `403` for a known principal lacking permission when disclosure is safe.

Protect every resource identifier against object-level authorization failures, not just purchase IDs.

---

## 9. Tenant isolation in MongoDB and services

### 9.1 Tenant-owned records

At minimum, add tenant ownership to:

- `vendorOffers`
- `purchaseRecords`
- `auditEvents`
- workspace settings/policies
- import jobs and migration records
- Gmail connection records
- future approval records and external integration state

Global identity records and platform configuration may be global only by explicit design.

### 9.2 Repository/service contracts

Make tenant context a required dependency or required method argument. Example signatures:

```js
vendorService.getCatalog({ tenantId });
vendorService.getOffersForRequest({ tenantId, request });
vendorService.importOffers({ tenantId, offers, actorId });
purchaseStore.getById({ tenantId, purchaseId });
purchaseStore.list({ tenantId, filters });
purchaseStore.upsert({ tenantId, purchaseId, updater });
auditService.getEventsByRequestId({ tenantId, requestId });
```

Choose one consistent pattern. Services must reject missing tenant context. Do not make it optional for production paths, and do not allow a payload to override verified ownership.

### 9.3 Query and index changes

Use tenant-prefixed queries:

```js
collection.find({ tenantId, active: { $ne: false } });
collection.findOne({ tenantId, purchaseId });
collection.updateOne(
  { tenantId, offerId },
  { $set: tenantOwnedOffer }
);
```

Recommended indexes, after migration planning:

- `vendorOffers`: unique `{ tenantId: 1, offerId: 1 }`
- `purchaseRecords`: unique `{ tenantId: 1, purchaseId: 1 }`
- `memberships`: unique `{ tenantId: 1, userId: 1 }`
- `auditEvents`: `{ tenantId: 1, requestId: 1, timestamp: 1 }`
- `auditEvents`: `{ tenantId: 1, purchaseId: 1, timestamp: 1 }`
- Other tenant-prefixed indexes for actual query patterns.

Do not drop the current global unique `offerId` index and immediately add a compound index. Reconcile existing duplicates, back up data, run a dry run, and verify the migration first.

### 9.4 Prevent unscoped access

Search for and eliminate normal tenant-service use of:

- `find({})`
- `findOne({ purchaseId })`
- `updateOne({ offerId })`
- `deleteMany({})`
- `list()` methods without tenant context
- unscoped caches, maps, locks, and background jobs

Test-only in-memory adapters may remain, but production startup must use tenant-aware durable repositories. Global administrative operations must be separate, privileged, narrowly scoped, and audited.

---

## 10. Purchase evaluation and decision engine

Do not rewrite the decision engine to add authentication logic.

1. Resolve and authorize the user's tenant.
2. Validate the purchase request.
3. Load only that tenant's active vendor offers.
4. Load policy/configuration belonging to the same tenant.
5. Evaluate using the existing deterministic engine.
6. Validate the selected offer with the policy service.
7. Persist purchase, recommendation, and audit records with the same server-resolved tenant.
8. Return the result only to the authorized tenant member.

Keep currency-minor-unit calculations, hard constraints, policy validation, deterministic ranking, and explanations unchanged unless a separate bug is documented. The purchase record must continue to state `paymentAuthorized: false`. Approval/payment endpoints must not begin executing actions as a side effect of this work.

---

## 11. Vendor import isolation

Keep the current Excel/CSV import UI and field mapping.

- Require authentication and `vendors:import`.
- Obtain `tenantId` only from trusted request context.
- Reject or ignore any `tenantId` in a spreadsheet/request payload as an ownership source.
- Validate every row server-side.
- Preserve explicit price/fee validation and integer minor-unit semantics.
- Apply a configurable hard maximum and per-tenant rate/concurrency/daily quotas.
- Upsert using `{ tenantId, offerId }`.
- Make imports idempotent and record an `importId`.
- Store tenant, actor, timestamps, counts, status, and safe failure details.
- Never change an existing record's tenant through import.
- Avoid raw database errors, stack traces, or other tenant data in responses.
- Add tests for duplicate IDs, same `offerId` across two tenants, partial failure, retries, and oversized imports.

---

## 12. Migration and background-job isolation

### 12.1 Legacy data migration

Some current records may not have `tenantId`. Do not assign all records to one tenant automatically.

1. Identify legacy records and ownership evidence.
2. Back up the database and rehearse restore.
3. Produce a dry-run report grouped by collection and known owner.
4. Reconcile ambiguous records; quarantine records without trustworthy ownership.
5. Create tenants/memberships through explicit bootstrap.
6. Assign `tenantId` only where ownership is verified.
7. Detect duplicate `offerId` values within each intended tenant.
8. Build compound indexes after cleanup.
9. Verify counts and sample records after migration.
10. Record migration version, tenant, operator, timestamps, result, and rollback instructions.

### 12.2 Migration runner

Use a separate least-privilege migration credential, not a privileged runtime connection. Migrations must be idempotent, resumable, bounded, tenant-by-tenant, and have dry-run mode. Missing tenant ID must stop the migration rather than trigger a global write.

### 12.3 Background jobs

Every job must carry `jobId`, `tenantId`, initiating actor/service identity, bounded payload/reference IDs, an idempotency key for side effects, and creation/attempt metadata.

Workers must revalidate tenant status and use tenant-aware repositories. Never keep the current tenant in a process-global variable or reuse another tenant's credentials.

---

## 13. Audit, logging, and errors

### Audit events

Record login/logout, membership/permission changes, business email verification, Gmail connection/disconnection/revocation, imports, purchase evaluation/retrieval as appropriate, cross-tenant denials, migrations/jobs, and security configuration changes.

Tenant-owned events should include tenant, actor, action, resource ID where appropriate, timestamp, outcome, and correlation ID. Use explicit metadata allowlists. Never store tokens, authorization codes, passwords, cookie values, authorization headers, encryption keys, or full sensitive payloads. Restrict audit update/delete permissions in production and define retention.

### Request logging

- Generate a server-side request ID.
- Validate/bound client correlation IDs and keep them distinct from the authoritative internal ID.
- Remove duplicate request-ID middleware.
- Do not log raw OAuth callback URLs/query strings or request bodies by default.
- Redact headers/secrets and bound log fields.
- Avoid leaking PII, mailbox contents, tokens, database URIs, or stack traces.

### Error handling

Production responses must not expose stack traces, database errors, internal paths, or OAuth provider payloads. Use safe error codes and correlation IDs. Do not reveal whether another tenant's resource exists.

---

## 14. Defense in depth

Implement and test controls appropriate to the current stack:

- Secure HTTP headers (Helmet or equivalent) and a tested CSP.
- Exact CORS allowlist; remember CORS is not authentication.
- CSRF defense for cookie-authenticated state-changing requests.
- Route-specific rate limits for auth/OAuth, imports, and purchase evaluation.
- Request/body limits, import row limits, timeouts, bounded concurrency.
- Secure production cookies and explicit trusted-proxy configuration.
- Strict schemas, allowed fields, string/array limits, and safe object handling.
- TLS for database and external APIs.
- Least-privilege MongoDB runtime credentials.
- Separate migration/operational credentials.
- Managed secret storage in deployment.
- Dependency and secret scanning in CI.
- Lockfile review and dependency patch policy.
- Encrypted backups and tested restoration.
- Production startup checks for unsafe configuration.
- Data minimization, retention, and deletion procedures.
- Alerts for repeated authorization failures, tenant mismatch attempts, suspicious imports, and unusual exports.
- SSRF protections before any feature fetches user-supplied URLs.
- Idempotency for future external side-effect operations.

Do not add middleware without testing frontend/deployment/callback behavior. Document any deferred control and its security rationale.

---

## 15. Frontend integration without redesign

The current React/Vite design must remain recognizable and visually unchanged.

Allowed changes only:

- Wire existing login/signup actions to real authentication.
- Replace fake/local-storage session authority with API-validated session state.
- Add minimal loading, success, error, logged-out, and expired-session states using existing components.
- Show business email verification status.
- Show Gmail connected/disconnected status only when enabled.
- Hide/disable actions the current role cannot perform, while still enforcing authorization in the backend.
- Handle 401/403/429 responses safely in the existing API client.

Hidden buttons are not a security control; backend authorization is authoritative.

Do not add a new theme, restructure pages, change design tokens, or rebuild the workspace unless a specific security requirement cannot otherwise be met.

Before and after, compare screenshots for landing, login/signup, workspace, purchase evaluation, and vendor import. Run the frontend production build and test responsive/accessibility behavior for added controls.

---

## 16. Required automated tests

### Authentication
- Missing, malformed, expired, revoked, and tampered sessions are rejected.
- Invalid OAuth state/nonce, issuer, audience, signature, and expiration are rejected.
- Callback replay and unsafe redirects are rejected.
- Logout invalidates the session.
- Session ID rotates after login.
- Missing Google credentials never enable fake authentication.
- OAuth credentials/tokens are absent from responses and logs.

### Authorization
- Every protected route requires authentication.
- Read-only users cannot import vendors.
- Purchasers cannot manage memberships/workspace security.
- Only authorized roles can verify business email or manage Gmail connections.
- Removed/disabled members lose access.
- Client-supplied tenant IDs cannot override server-resolved context.

### Tenant isolation
Create tenants A and B with separate users, offers, purchases, audits, and Gmail connections. Assert:

- A cannot list B's offers.
- A cannot update B's offer by reusing its `offerId`.
- A cannot retrieve B's purchase even if its ID is known.
- A cannot list B's audits.
- A's import cannot modify B's catalog.
- A's job cannot access B's credentials/data.
- Missing tenant context rejects tenant-owned operations.
- Duplicate external IDs across tenants do not grant access.
- Error messages do not disclose B's resource existence/content.

### Gmail
- Login scopes exclude mailbox scopes.
- Gmail scopes are requested only in the separate connection flow.
- Unauthorized members cannot connect/disconnect the mailbox.
- Token encryption/decryption and rotation behavior are tested/documented.
- Tokens never appear in logs, API responses, frontend bundles, or audit metadata.
- Revoked consent disables mailbox operations safely.
- Disabled/unconfigured integration fails closed without a fake success state.

### Import and migration
- Malformed rows and oversized imports fail safely.
- Tenant IDs in import payloads are not trusted.
- Duplicate `offerId` values are handled within the correct tenant.
- Retries are idempotent and partial failures resume safely.
- Migration dry-run and per-tenant counts reconcile.
- Ambiguous legacy records are quarantined.
- Rollback/restore procedures are rehearsed.

### Regression
- Existing decision engine tests remain green.
- Policy validator behavior is unchanged.
- A recommendation does not authorize payment.
- Vendor import mapping remains functional.
- Frontend build passes.
- Screenshot comparison shows no unintended design changes.

---

## 17. Phased implementation and acceptance criteria

### Phase 0 — Baseline and configuration scaffolding
- Record branch/commit and test/build results.
- Add `.env.example` variables and central config validation.
- Ensure real `.env` remains ignored.
- Add startup checks and safe config-status logging.
- No fake-auth fallback.

**Exit:** template is complete, secrets are not committed, tests still run.

### Phase 1 — Google sign-in/session
- Implement OIDC start/callback/logout.
- Persist Google `sub`-based identity.
- Add secure session store, cookie settings, CSRF strategy, and auth middleware.
- Wire existing login controls without redesign.

**Exit:** protected routes reject unauthenticated calls; OIDC protections are tested.

### Phase 2 — Workspaces and permissions
- Add tenant/workspace, membership, and role model.
- Implement safe first-owner bootstrap.
- Implement membership resolution and permission middleware.

**Exit:** tenant context is server-created; membership/role tests pass.

### Phase 3 — Tenant-scoped persistence
- Add tenant ownership fields.
- Update repository/service contracts and MongoDB queries.
- Plan/run legacy-data reconciliation.
- Replace global uniqueness assumptions with tenant-aware compound indexes.

**Exit:** every normal tenant-owned read/write is scoped and tested.

### Phase 4 — Business email and Gmail connection
- Add business email verification metadata and permission checks.
- Add separately consented Gmail OAuth service/schema.
- Implement encrypted token storage and revocation/disconnect handling if enabled.
- If credentials are not supplied, keep integration disabled and test not-configured behavior.

**Exit:** no typed email is treated as proof; no mailbox token reaches the browser.

### Phase 5 — Imports, jobs, migrations
- Tenant-scope imports and upserts.
- Add per-tenant quotas and idempotency.
- Add tenant-bound job/migration patterns.

**Exit:** imports, jobs, and migrations cannot cross tenant boundaries.

### Phase 6 — Hardening
- Add headers, rate limits, error hygiene, redacted logs, dependency scanning, database least privilege, backup/restore guidance, and security alerting.

**Exit:** unsafe production configuration fails startup; CI includes security checks.

### Phase 7 — Final verification
- Run backend tests and frontend build.
- Run cross-tenant security suite.
- Compare UI screenshots.
- Review deployment secrets/configuration and rollback plan.
- Report completed controls and known limitations.

**Exit:** P0 findings are closed, P1 controls are completed or explicitly risk-accepted, and payment execution remains disabled.

---

## 18. Deployment checklist

- [ ] Set Google OIDC client ID/secret in managed server-side secret storage.
- [ ] Register exact callback URL in Google Cloud Console.
- [ ] Set exact production frontend/backend origins.
- [ ] Configure HTTPS and secure session cookies.
- [ ] Generate session/OAuth secrets cryptographically.
- [ ] Configure production session store and CSRF defense.
- [ ] Configure MongoDB TLS, network restrictions, and least-privilege credentials.
- [ ] Configure Gmail credentials/scopes only if mailbox functionality is approved.
- [ ] Configure token encryption with KMS or approved key management.
- [ ] Configure rate limits and per-tenant import quotas.
- [ ] Run migration dry-run, backup, reconciliation, and restore checks.
- [ ] Verify audit redaction and retention.
- [ ] Confirm no secrets exist in Git history or frontend build output.
- [ ] Run tenant-isolation/auth regression tests.
- [ ] Compare UI screenshots.
- [ ] Confirm payment endpoints remain non-executing.

---

## 19. Required implementation deliverables

1. `.env.example` with required variable names and safe placeholders.
2. Central configuration parsing and validation.
3. Google OIDC authentication/session implementation.
4. Authentication and authorization middleware.
5. Workspace/tenant/membership model and bootstrap procedure.
6. Tenant-aware repositories, service methods, queries, and indexes.
7. Safe migration/reconciliation script or documented runbook.
8. Business email verification flow.
9. Optional Gmail connection scaffold and encrypted token storage, disabled until configured.
10. Secure vendor import and tenant-bound job patterns.
11. Structured redacted audit/logging.
12. Security middleware, rate limits, and CSRF controls appropriate to deployment.
13. Automated auth, authorization, tenant-isolation, Gmail, and regression tests.
14. UI screenshot comparison report.
15. Updated setup/deployment documentation and known limitations.

---

## 20. Final instructions

- Implement in small commits on a dedicated branch.
- Do not commit secrets or real customer data.
- Add every required environment variable now, but leave credential values blank/placeholders for the repository owner to fill later.
- Wire backend logic to read and validate these variables; do not merely add unused names to `.env.example`.
- If credentials are missing, the integration must remain disabled and protected routes must fail closed. Never fake successful authentication.
- Do not claim Gmail OAuth is operational until credentials, callback URLs, scopes, token encryption, and provider tests are configured.
- Do not make tenant IDs optional in production service APIs.
- Do not silently assign legacy records to a default tenant.
- Do not change the deterministic decision engine or payment authorization behavior as part of this milestone.
- Do not redesign or visually regress the frontend.
- Run tests after each phase and report failures honestly.
- Document every deliberate deviation and its security rationale.

**Definition of done:** users can authenticate, workspace actions are authorized, and business data is isolated at every access point; environment scaffolding exists; Gmail credentials can be added later without redesigning the code; cross-tenant tests pass; current UI/UX and decision-engine behavior remain intact; and no payment is executed automatically.
