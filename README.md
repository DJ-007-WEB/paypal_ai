# Mandate — PayPal AI Hackathon

**Policy-aware purchasing with human-controlled payment authorization.**

Mandate turns a business purchasing request into a transparent vendor recommendation. It compares offers against hard constraints, independently validates the result against policy, and records the decision for review.

> **Safety invariant:** AI may assist with recommendations, deterministic code enforces policy, and a human must authorize any future payment. This prototype does not execute payments.

## Current capabilities
- Deterministic purchase decision engine using integer currency minor units.
- Mock vendor catalog for sample SKU `BRG-6204`.
- Independent checks for budget, compatibility, inventory, delivery, approved vendors, quality and reliability.
- Express purchase evaluation/retrieval API, in-memory store and audit events.
- React/Vite purchase desk connected to the evaluation API.
- Payment, approval, mandate and external AI integrations are intentionally not enabled yet.

## Architecture
```text
React purchase desk -> Express API -> Request validation -> Mock vendor catalog
                                         |-> Decision engine -> Policy validator
                                         |-> Audit log + in-memory purchase store
                                      Recommendation + policy findings -> Human review
```

## Run locally
Requirements: Node.js 18.18+ and npm.

### Backend
```bash
cd backend
npm ci
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

## Example API request
```bash
curl -X POST http://localhost:3000/api/purchases/evaluate \
  -H "Content-Type: application/json" \
  -d '{"productId":"BRG-6204","quantity":40,"maxTotalMinor":2000000,"currency":"INR","maxDeliveryDays":5,"minQualityScore":70,"minReliabilityScore":70,"requireApprovedVendor":true}'
```
`maxTotalMinor` uses currency minor units; ₹20,000 is `2000000` paise.

## Prototype limitations
- Vendor offers are mock data.
- Purchases and audit events are in memory and reset when the server restarts.
- Approval, mandate, scheduler, invoice, AI and PayPal payment integrations are not implemented.
- A recommendation is not a payment instruction; payment authorization remains false.
- This is a hackathon prototype, not production financial software.

Run backend tests with `cd backend && npm test`.
