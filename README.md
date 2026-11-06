# Mandate — PayPal AI Hackathon

**Policy-aware purchasing with human-controlled payment authorization.**

Mandate turns a business purchasing request into a transparent vendor recommendation. It compares offers against hard constraints, independently validates the result against policy, and records the decision for review.

> **Safety invariant:** AI may assist with recommendations, deterministic code enforces policy, and a human must authorize any future payment. This prototype does not execute payments.

## Current capabilities

- Deterministic purchase decision engine using integer currency minor units
- MongoDB-backed vendor offer catalog and validated import API
- Independent checks for budget, compatibility, inventory, delivery, approved vendors, quality and reliability
- Express purchase evaluation/retrieval API
- React/Vite purchase desk connected to the evaluation API
- **PayPal Orders API (Sandbox) — server-side order creation, capture, and status with webhook verification**
- Payment, approval, mandate and external AI integrations

## Architecture

```text
React purchase desk -> Express API -> Request validation -> MongoDB vendor offers
                                       |-> Decision engine -> Policy validator
                                       |-> Audit log + purchase record
  Recommendation + policy findings -> Human review
                                       |
                                       v
                              PayPal Orders API
  (order creation -> user approval on PayPal -> server-side capture -> status update)
```

## PayPal Integration

This prototype integrates the PayPal Orders API using **Sandbox credentials only**. No real-money payments are enabled.

- Orders are created server-side from trusted purchase data (`request.maxTotalMinor`)
- The frontend never supplies money or payment details
- `paymentAuthorized` stays `false` throughout — PayPal is order-only, no capture occurs without explicit server-side approval
- A unique invoice_id provides idempotency for order creation
- Capture is gated against amount/tenant verification
- Webhook events are HMAC-SHA256 signature-verified
- Audit events: `PAYMENT_ORDER_CREATED`, `PAYMENT_ORDER_CAPTURED`, `PAYMENT_ORDER_CANCELLED`, `PAYMENT_ORDER_VERIFICATION_FAILED`, `PAYMENT_ORDER_DECLINED`

### Environment variables

See `backend/.env.example` for all supported variables. PayPal-related vars (all optional, disabled by default):

| Variable | Description |
|---|---|
| `PAYPAL_CLIENT_ID` | PayPal OAuth client ID (Sandbox) |
| `PAYPAL_CLIENT_SECRET` | PayPal OAuth client secret (Sandbox) |
| `PAYPAL_ENV` | Set to `sandbox` for test environment |
| `PAYPAL_RETURN_URL` | URL to redirect after PayPal approval |
| `PAYPAL_CANCEL_URL` | URL to redirect if user cancels on PayPal |

### Checkout flow

1. **Create order** — `POST /api/payments/create/:purchaseId` (requires `purchases:create` permission, eligible purchase with `requiresHumanApproval`)
2. **Redirect** — User approves on PayPal; PayPal redirects back to `return_url`
3. **Capture** — `POST /api/payments/capture/:purchaseId` with PayPal `orderId` from query params (requires `purchases:create`, verifies amount+tenant match)
4. **Status** — `GET /api/payments/status/:purchaseId` (requires `purchases:read`)

### Webhook

PayPal posts events to the registered webhook URL. The backend verifies the `PayPal-TRANSMISSION-SIG` + `PayPal-TRANSMISSION-TIME` HMAC-SHA256 signature before processing. Idempotent processing prevents duplicate captures on retry.

## Run locally

Requirements: Node.js 18.18+ and npm.

### Backend

```bash
cd backend
npm ci
# Copy ../.env.example to backend/.env and set your MongoDB URI
npm test
npm run dev
```

Health check: `curl http://localhost:3000/api/health`

### Frontend

Open a second terminal from the repository root:

```bash
cd frontend
npm install
npm run dev
```

Open the Vite URL printed in the terminal, usually `http://localhost:5173`. By default, the UI calls `http://localhost:3000/api`. To override it, create `frontend/.env.local`:

```env
VITE_API_BASE_URL=http://localhost:3000/api
```

Never place PayPal secrets or private credentials in `VITE_*` variables.

## Deployment configuration

### Vercel

1. Set the following Environment Variables in the Vercel dashboard:

   ```
   NODE_ENV=production
   PORT=3000
   MONGODB_URI=<your-atlas-connection-string>
   MONGODB_DB_NAME=mandate
   FRONTEND_ORIGIN=https://your-domain.com,http://localhost:5173
   APP_BASE_URL=https://your-domain.com
   FRONTEND_BASE_URL=https://your-domain.com
   TRUST_PROXY=false
   SESSION_SECRET=<random>
   GOOGLE_OIDC_ENABLED=false
   GOOGLE_OIDC_CLIENT_ID=<your-google-client-id>
   GOOGLE_OIDC_CLIENT_SECRET=<your-google-client-secret>
   GOOGLE_OIDC_REDIRECT_URI=https://your-domain.com/api/auth/google/callback
   GOOGLE_OIDC_ISSUER=https://accounts.google.com
   GOOGLE_OIDC_SCOPES=openid email profile
   PAYPAL_CLIENT_ID=<sandbox-client-id>
   PAYPAL_CLIENT_SECRET=<sandbox-client-secret>
   PAYPAL_ENV=sandbox
   PAYPAL_RETURN_URL=https://your-domain.com/app/purchases/new
   PAYPAL_CANCEL_URL=https://your-domain.com/app/purchases/new
   ```

2. Framework: Node.js (auto-detected)
3. Build Command: `cd backend && npm run build` (or let Vercel use the root package.json)
   - Or set separate Frontend and Backend projects with Vite + Express

### Render

1. Create a new Web Service pointing to the repo root.
2. Set the same Environment Variables as Vercel above.
3. Build Command: `npm install`
4. Start Command: `cd backend && node src/app.js` (or use the `package.json` start script)
5. Enable Private DNS if using MongoDB Atlas with VPC peering.

### MongoDB Atlas

1. Create a free cluster at <https://www.mongodb.com/atlas>.
2. Whitelist `0.0.0.0/0` (or your IP/VPC) in Network Access.
3. Create a database user with readWrite permissions on `mandate`.
4. Use the connection string as `MONGODB_URI`:
   ```
   mongodb+srv://<username>:<password>@cluster0.<atlas-id>.mongodb.net/mandate
   ```

### PayPal Dashboard

1. Create a PayPal Developer Account at <https://developer.paypal.com>.
2. Create a new OAuth app, selecting **Sandbox** as the environment.
3. Copy the **Client ID** and **Client Secret** into the `backend/.env` file.
4. Set the **Return URL** and **Cancel URL** to your frontend purchase flow URL.
5. (Optional) Register a webhook URL in the PayPal Dashboard if you want automatic event processing:
   - URL: `https://your-domain.com/api/payments/webhook`
   - Select events: `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.MONEY_TRANSFER.DECLINED`, `ORDER.VOIDED`
   - Enable "Sandbox mode" if using the test environment.

## API reference

### Purchase evaluation

```bash
POST /api/purchases/evaluate
{
  "productId": "BRG-6204",
  "quantity": 40,
  "maxTotalMinor": 2000000,
  "currency": "INR",
  "maxDeliveryDays": 5,
  "minQualityScore": 70,
  "minReliabilityScore": 70,
  "requireApprovedVendor": true
}
```

### Payment endpoints

```bash
POST /api/payments/create/:purchaseId
# Requires purchases:create permission
# Returns: paypalOrderId, approvalUrl, amountMinor, currency

POST /api/payments/capture/:purchaseId
# Requires purchases:create permission
# Body: { "orderId": "<paypal-order-id>" }
# Verifies amount match before capturing

GET /api/payments/status/:purchaseId
# Requires purchases:read permission
# Returns current payment state

POST /api/payments/cancel/:purchaseId
# Handles user cancellation on PayPal

POST /api/payments/webhook
# PayPal webhook endpoint (verify signature internally)
```

### Currency

`maxTotalMinor` uses currency minor units. ₹20,000 is `2000000` paise. Supported: `INR`.

## Prototype limitations

- Purchase records and audit events are volatile on server restart (in-memory or MongoDB-backed in production)
- PayPal is order-only in Sandbox; no real-money payments are executed; `paymentAuthorized` stays `false`
- Human approval is always required; the deterministic purchase decision engine remains authoritative
- PayPal Sandbox credentials must be set in `backend/.env` for the integration to activate; leaving them empty disables routes with appropriate errors
- Webhook replay may occur — the backend is idempotent but may still receive duplicate PayPal retries
- Google Gmail integration is optional and disabled by default
- AI integration assists recommendations but never overrides the deterministic engine or authorizes payment
- This is a hackathon prototype, not production financial software

## Run tests

```bash
cd backend && npm test
# All 41 API + security tests must pass
```

## License

See `LICENSE` for full licensing terms.