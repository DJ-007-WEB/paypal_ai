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
Copy the example environment file from the project root to the backend directory:
```bash
cp ../.env.example .env
```
Set `MONGODB_URI` in `backend/.env` to your connection string. Do not commit or share that file.

```env
PORT=3000
NODE_ENV=development
FRONTEND_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
MONGODB_URI=mongodb://127.0.0.1:27017/mandate
MONGODB_DB_NAME=mandate
```

MongoDB is required at startup. Vendor offers are read from the `vendorOffers` collection. Purchase records and audit logs still use in-memory stores in this milestone and are not durable across restarts.

## Commands
```bash
npm run dev
npm start
npm test
```

## API endpoints
- `GET /api/health`
- `GET /api/vendors`
- `POST /api/vendors/import`
- `POST /api/purchases/evaluate`
- `GET /api/purchases/:purchaseId`
- Approval, payment and mandate routes intentionally return 501. No real payment authorization or execution is active.

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

## Limitations
- Purchase and audit storage is still in-memory and resets on restart.
- Spreadsheet upload UI is not yet connected to the import API.
- Approval and payment execution remain disabled.
- No external AI call or real PayPal payment flow is active.
