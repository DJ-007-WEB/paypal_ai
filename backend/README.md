# Mandate Backend API

## Prerequisites

- Node.js 18.18.0 or later
- npm 9+
- A local shell with access to the workspace

## Installation

From the backend directory:

```bash
npm install
```

## Environment configuration

Copy the example environment file from the project root:

```bash
cp ../.env.example .env
```

The API currently uses the following environment variables:

```env
PORT=3000
NODE_ENV=development
```

The app does not require a database or external AI credentials for this milestone. In-memory stores are used for purchases and audit logs and are intentionally not durable across restarts.

## Development command

```bash
npm run dev
```

## Production command

```bash
npm start
```

## Test command

```bash
npm test
```

## API endpoints

### Health

- GET /api/health

### Purchase evaluation

- POST /api/purchases/evaluate

### Purchase history lookup

- GET /api/purchases/:purchaseId

### Approval and payment endpoints

- Approval and payment routes are intentionally not implemented in this milestone.
- These endpoints return a clear 501 response and require separate human approval logic in a future milestone.

## Example request payload

```json
{
  "productId": "BRG-6204",
  "quantity": 100,
  "maxTotalMinor": 5000000,
  "currency": "INR",
  "maxDeliveryDays": 5,
  "requireApprovedVendor": true,
  "minQualityScore": 80,
  "minReliabilityScore": 80
}
```

## Example response

```json
{
  "success": true,
  "data": {
    "purchaseId": "purchase_4cf8f1f9d81d",
    "decision": {
      "status": "RECOMMENDED",
      "recommendedOfferId": "low-cost",
      "recommendedVendorId": "vendor-low"
    },
    "policy": {
      "passed": true,
      "violations": [],
      "paymentAuthorized": false
    },
    "explanation": "Evaluated 5 offer(s); 1 eligible and 4 rejected. Recommended low-cost from vendor-low at INR 4,250,000. This is a recommendation only; policy validation and human approval are required before payment.",
    "uncertainties": [],
    "authorization": {
      "paymentAuthorized": false,
      "requiresHumanApproval": true
    }
  },
  "meta": {
    "requestId": "4a0b0d9b-71d2-4fb4-a36a-c930d7b5f9d3"
  }
}
```

## Architecture and request flow

1. The request enters the Express app with correlation IDs and JSON parsing enabled.
2. Purchase requests are validated against the deterministic engine contract before evaluation is attempted.
3. The vendor service returns mock offers for the requested product.
4. The purchase decision engine chooses the best eligible offer using deterministic score calculations.
5. A separate policy service validates the selected recommendation against hard constraints and configured business rules.
6. Audit events are recorded in memory for all important stages.
7. The completed evaluation is stored in an in-memory purchase repository and can be retrieved by purchase ID.

This preserves a clean separation between ranking logic, policy enforcement, and audit capture.

## Current limitations

- Purchase and audit data are kept in memory only and are lost when the backend process restarts.
- Approval and payment execution are intentionally not implemented in this milestone.
- Real vendor APIs, external AI calls, and database persistence are deliberately out of scope for this phase.
- The API does not perform payment authorization or payment execution. It only provides deterministic evaluation and policy checks.

## Replacing in-memory stores with persistent storage

The design currently exposes storage behind a small service interface. To replace the in-memory repository later:

- implement a new repository backed by a database or another durable system,
- keep the same create/getById/list contract,
- continue returning deep-cloned records so callers cannot mutate internal state,
- keep the route handlers and app bootstrap unchanged.

The same pattern applies to audit storage and vendor data access.

## Payment boundary

This milestone does not implement real payment execution. Any payment authorization or capture flow remains intentionally disabled and must require explicit human approval in a later milestone. The evaluation API only returns `paymentAuthorized: false` and does not infer authorization from a client-supplied value.
