'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createVendorService } = require('../src/services/vendor.service');
const { createAuditService } = require('../src/services/audit.service');
const { createPurchaseStore } = require('../src/services/purchaseStore.service');

const makeRequest = (body = {}) => ({
  productId: 'BRG-6204',
  quantity: 100,
  maxTotalMinor: 5000000,
  currency: 'INR',
  maxDeliveryDays: 5,
  requireApprovedVendor: true,
  ...body,
});

const defaultOffers = [
  {
    offerId: 'low-cost',
    vendorId: 'vendor-low',
    productId: 'BRG-6204',
    unitPriceMinor: 42000,
    availableQuantity: 500,
    currency: 'INR',
    deliveryDays: 4,
    vendorApproved: true,
    shippingMinor: 500,
    taxMinor: 250,
    feesMinor: 350,
    qualityScore: 82,
    reliabilityScore: 88,
  },
  {
    offerId: 'fast',
    vendorId: 'vendor-fast',
    productId: 'BRG-6204',
    unitPriceMinor: 46000,
    availableQuantity: 150,
    currency: 'INR',
    deliveryDays: 2,
    vendorApproved: true,
    shippingMinor: 800,
    taxMinor: 300,
    feesMinor: 400,
    qualityScore: 88,
    reliabilityScore: 90,
  },
  {
    offerId: 'insufficient-stock',
    vendorId: 'vendor-stock',
    productId: 'BRG-6204',
    unitPriceMinor: 39000,
    availableQuantity: 25,
    currency: 'INR',
    deliveryDays: 3,
    vendorApproved: true,
    shippingMinor: 600,
    taxMinor: 200,
    feesMinor: 250,
    qualityScore: 70,
    reliabilityScore: 68,
  },
  {
    offerId: 'unapproved',
    vendorId: 'vendor-unapproved',
    productId: 'BRG-6204',
    unitPriceMinor: 37500,
    availableQuantity: 200,
    currency: 'INR',
    deliveryDays: 3,
    vendorApproved: false,
    shippingMinor: 450,
    taxMinor: 180,
    feesMinor: 220,
    qualityScore: 75,
    reliabilityScore: 74,
  },
  {
    offerId: 'budget-breach',
    vendorId: 'vendor-budget',
    productId: 'BRG-6204',
    unitPriceMinor: 99999,
    availableQuantity: 200,
    currency: 'INR',
    deliveryDays: 1,
    vendorApproved: true,
    shippingMinor: 1000,
    taxMinor: 500,
    feesMinor: 600,
    qualityScore: 97,
    reliabilityScore: 96,
  },
];

function testConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    PORT: '3000',
    FRONTEND_ORIGIN: 'http://localhost:5173',
    APP_BASE_URL: 'http://localhost:3000',
    FRONTEND_BASE_URL: 'http://localhost:5173',
    SESSION_COOKIE_SECURE: 'false',
    GOOGLE_OIDC_ENABLED: 'false',
    GOOGLE_GMAIL_ENABLED: 'false',
    LOG_LEVEL: 'error',
  });
}

async function startServer(customOffers = defaultOffers) {
  const config = testConfig();
  const app = createApp({
    config,
    vendorService: createVendorService(customOffers),
    auditService: createAuditService(),
    purchaseStore: createPurchaseStore(),
    allowTestPrincipal: true,
  });
  const { userService, tenantService } = app.__services;
  const user = await userService.__seed({
    googleSubject: `test-sub-${Math.random().toString(36).slice(2)}`,
    email: 'owner@example.com',
    emailVerified: true,
    displayName: 'Test Owner',
    status: 'active',
  });
  const tenant = await tenantService.__seedTenant({
    businessName: 'Test Business',
    status: 'active',
    businessEmail: '',
    businessEmailVerifiedAt: null,
  });
  await tenantService.__seedMembership({
    tenantId: tenant.tenantId,
    userId: user.userId,
    role: 'owner',
    permissions: tenantService.permissionsForRole('owner'),
    status: 'active',
  });

  const authHeaders = {
    'X-Test-User-Id': user.userId,
    'X-Test-Tenant-Id': tenant.tenantId,
  };

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server, authHeaders, user, tenant, app });
    });
    server.on('error', reject);
  });
}

async function apiRequest(baseUrl, method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();

  return {
    status: response.status,
    headers: response.headers,
    body: payload,
  };
}

test('health endpoint returns expected response', async () => {
  const { baseUrl, server } = await startServer();
  try {
    const res = await apiRequest(baseUrl, 'GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.status, 'ok');
    assert.equal(res.body.data.service, 'mandate-api');
  } finally {
    server.close();
  }
});

test('protected routes reject unauthenticated calls', async () => {
  const { baseUrl, server } = await startServer();
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest());
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
  } finally {
    server.close();
  }
});

test('valid purchase evaluation returns a recommendation when eligible offers exist', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest(), authHeaders);
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.decision.status, 'RECOMMENDED');
    assert.equal(res.body.data.decision.recommendedOfferId, 'low-cost');
    assert.equal(res.body.data.policy.passed, true);
    assert.equal(res.body.data.authorization.paymentAuthorized, false);
  } finally {
    server.close();
  }
});

test('malformed request returns HTTP 400', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', { quantity: 'lots' }, authHeaders);
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(res.body.error.details));
  } finally {
    server.close();
  }
});

test('unsupported currency is rejected', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest({ currency: 'XYZ' }), authHeaders);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.match(JSON.stringify(res.body), /currency/i);
  } finally {
    server.close();
  }
});

test('no eligible offer returns NO_ELIGIBLE_OFFER', async () => {
  const { baseUrl, server, authHeaders } = await startServer([
    { ...defaultOffers[3], vendorApproved: false },
  ]);
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest(), authHeaders);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.decision.status, 'NO_ELIGIBLE_OFFER');
    assert.equal(res.body.data.policy.passed, false);
  } finally {
    server.close();
  }
});

test('over-budget offers are not recommended', async () => {
  const { baseUrl, server, authHeaders } = await startServer([
    { ...defaultOffers[4], unitPriceMinor: 60000, availableQuantity: 500 },
  ]);
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest({ maxTotalMinor: 4000000 }), authHeaders);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.decision.status, 'NO_ELIGIBLE_OFFER');
  } finally {
    server.close();
  }
});

test('unapproved vendors are excluded when approval is required', async () => {
  const { baseUrl, server, authHeaders } = await startServer([
    { ...defaultOffers[0], vendorApproved: true },
    { ...defaultOffers[3], vendorApproved: false },
  ]);
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest({ requireApprovedVendor: true }), authHeaders);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.decision.recommendedVendorId, 'vendor-low');
  } finally {
    server.close();
  }
});

test('insufficient inventory prevents recommendation', async () => {
  const { baseUrl, server, authHeaders } = await startServer([
    { ...defaultOffers[2], availableQuantity: 10 },
  ]);
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest(), authHeaders);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.decision.status, 'NO_ELIGIBLE_OFFER');
  } finally {
    server.close();
  }
});

test('policy violations prevent an acceptable recommendation from being returned', async () => {
  const { baseUrl, server, authHeaders } = await startServer([
    {
      ...defaultOffers[0],
      qualityScore: 40,
      reliabilityScore: 55,
    },
  ]);
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest({ minQualityScore: 80, minReliabilityScore: 80 }), authHeaders);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.policy.passed, false);
    assert.notEqual(res.body.data.decision.status, 'RECOMMENDED');
  } finally {
    server.close();
  }
});

test('purchase evaluation is retrievable by purchase ID', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    const evaluation = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest({ requestId: 'req-123' }), authHeaders);
    const purchaseId = evaluation.body.data.purchaseId;
    const retrieval = await apiRequest(baseUrl, 'GET', `/api/purchases/${purchaseId}`, null, authHeaders);
    assert.equal(retrieval.status, 200);
    assert.equal(retrieval.body.success, true);
    assert.equal(retrieval.body.data.purchaseId, purchaseId);
  } finally {
    server.close();
  }
});

test('unknown purchase ID returns HTTP 404', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    const res = await apiRequest(baseUrl, 'GET', '/api/purchases/unknown-purchase', null, authHeaders);
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
  } finally {
    server.close();
  }
});

test('evaluation creates audit events', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest({ requestId: 'audit-req' }), authHeaders);
    assert.equal(res.status, 200);
    const events = await apiRequest(baseUrl, 'GET', `/api/purchases/${res.body.data.purchaseId}`, null, authHeaders);
    assert.equal(events.body.data.auditEvents.length > 0, true);
  } finally {
    server.close();
  }
});

test('error responses do not expose stack traces', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', { productId: 'BRG-6204', quantity: 0, maxTotalMinor: 1000, currency: 'USD', maxDeliveryDays: 5, requireApprovedVendor: true }, authHeaders);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message.includes('stack'), false);
    assert.equal(`${res.body}`.includes('TypeError'), false);
  } finally {
    server.close();
  }
});

test('request IDs are present in responses', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    // Server-authoritative request ID is returned; client correlation is validated separately.
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest(), authHeaders);
    assert.equal(res.status, 200);
    assert.ok(res.body.meta.requestId);
    assert.ok(res.headers.get('x-request-id'));
  } finally {
    server.close();
  }
});

test('repeated evaluation with identical input and offers produces deterministic decisions', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    const first = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest({ requestId: 'repeated-1' }), authHeaders);
    const second = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest({ requestId: 'repeated-2' }), authHeaders);
    assert.deepEqual(first.body.data.decision, second.body.data.decision);
    assert.deepEqual(first.body.data.policy, second.body.data.policy);
  } finally {
    server.close();
  }
});

test('system never claims payment has been authorized', async () => {
  const { baseUrl, server, authHeaders } = await startServer();
  try {
    const res = await apiRequest(baseUrl, 'POST', '/api/purchases/evaluate', makeRequest(), authHeaders);
    assert.equal(res.body.data.authorization.paymentAuthorized, false);
    assert.equal(res.body.data.policy.paymentAuthorized, false);
  } finally {
    server.close();
  }
});
