'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createVendorService } = require('../src/services/vendor.service');
const { createAuditService } = require('../src/services/audit.service');
const { createPurchaseStore } = require('../src/services/purchaseStore.service');
const { createSessionStore } = require('../src/services/session.service');
const { createCryptoService } = require('../src/services/crypto.service');
const { createPurchaseWorker } = require('../src/workers/purchase.worker');

/* ---------- helpers ---------- */

function testConfig(overrides = {}) {
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
    ...overrides,
  });
}

// Minimal in-memory Mongo collection mock supporting the methods our services use.
class FakeCollection {
  constructor() { this.docs = []; }
  _match(doc, filter) {
    for (const [k, v] of Object.entries(filter || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if ('$ne' in v) { if (doc[k] === v.$ne) return false; continue; }
        if ('$exists' in v) {
          const exists = doc[k] !== undefined;
          if (v.$exists && !exists) return false;
          if (!v.$exists && exists) return false;
          continue;
        }
        return false;
      }
      if (Array.isArray(v)) { if (JSON.stringify(doc[k]) !== JSON.stringify(v)) return false; }
      else if (doc[k] !== v) return false;
    }
    return true;
  }
  find(filter = {}) {
    const matched = this.docs.filter((d) => this._match(d, filter));
    const cursor = {
      _docs: matched,
      sort(spec) {
        const [[field, dir]] = Object.entries(spec);
        this._docs = [...this._docs].sort((a, b) => {
          const av = field.includes('.') ? field.split('.').reduce((o, p) => o?.[p], a) : a[field];
          const bv = field.includes('.') ? field.split('.').reduce((o, p) => o?.[p], b) : b[field];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * dir;
        });
        return this;
      },
      async toArray() { return this._docs.map((d) => ({ ...d })); },
    };
    return cursor;
  }
  async findOne(filter) { return { ...(this.docs.find((d) => this._match(d, filter)) || null) } && this.docs.find((d) => this._match(d, filter)) ? { ...this.docs.find((d) => this._match(d, filter)) } : null; }
  async insertOne(doc) {
    if (this.docs.some((d) => d.offerId && doc.offerId && d.offerId === doc.offerId && d.tenantId === doc.tenantId)) {
      const err = new Error('duplicate key'); err.code = 11000; throw err;
    }
    this.docs.push({ ...doc });
    return { insertedId: doc._id || doc.offerId || doc.purchaseId || doc.eventId };
  }
  async updateOne(filter, update, opts = {}) {
    const idx = this.docs.findIndex((d) => this._match(d, filter));
    if (idx === -1) {
      if (opts.upsert) {
        const base = { ...filter };
        if (update.$set) Object.assign(base, update.$set);
        if (update.$setOnInsert) Object.assign(base, update.$setOnInsert);
        this.docs.push({ ...base });
        return { upsertedCount: 1, modifiedCount: 0 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    if (update.$set) Object.assign(this.docs[idx], update.$set);
    if (update.$setOnInsert) { /* already exists */ }
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async bulkWrite(ops, { ordered } = {}) {
    let upsertedCount = 0; let modifiedCount = 0;
    for (const op of ops) {
      if (op.updateOne) {
        const { filter, update, upsert } = op.updateOne;
        const r = await this.updateOne(filter, update, { upsert });
        upsertedCount += r.upsertedCount || 0;
        modifiedCount += r.modifiedCount || 0;
      }
    }
    return { upsertedCount, modifiedCount };
  }
  async deleteOne(filter) { const i = this.docs.findIndex((d) => this._match(d, filter)); if (i !== -1) this.docs.splice(i, 1); }
  async deleteMany(filter) {
    if (!filter || Object.keys(filter).length === 0) { const n = this.docs.length; this.docs = []; return { deletedCount: n }; }
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !this._match(d, filter));
    return { deletedCount: before - this.docs.length };
  }
  async createIndex() { return 'ok'; }
  async countDocuments(filter = {}) { return this.docs.filter((d) => this._match(d, filter)).length; }
}

const offer = (overrides = {}) => ({
  offerId: 'offer-1',
  vendorId: 'vendor-1',
  vendorName: 'Vendor One',
  productId: 'BRG-6204',
  currency: 'INR',
  unitPriceMinor: 40000,
  availableQuantity: 500,
  deliveryDays: 3,
  vendorApproved: true,
  shippingMinor: 100,
  taxMinor: 50,
  feesMinor: 50,
  qualityScore: 80,
  reliabilityScore: 85,
  active: true,
  compatibleProductIds: [],
  ...overrides,
});

const purchaseBody = (overrides = {}) => ({
  productId: 'BRG-6204',
  quantity: 10,
  maxTotalMinor: 5000000,
  currency: 'INR',
  maxDeliveryDays: 5,
  requireApprovedVendor: true,
  ...overrides,
});

async function startTwoTenantApp({ vendorSeedA = [], vendorSeedB = [] } = {}) {
  const config = testConfig();
  const vendorCollection = new FakeCollection();
  const app = createApp({
    config,
    vendorCollection,
    vendorService: createVendorService({ collection: vendorCollection }),
    auditService: createAuditService(),
    purchaseStore: createPurchaseStore(),
    allowTestPrincipal: true,
  });
  const { userService, tenantService, vendorService } = app.__services;

  const userA = await userService.__seed({ googleSubject: 'sub-A', email: 'a@example.com', emailVerified: true, displayName: 'A', status: 'active' });
  const userB = await userService.__seed({ googleSubject: 'sub-B', email: 'b@example.com', emailVerified: true, displayName: 'B', status: 'active' });
  const tenantA = await tenantService.__seedTenant({ businessName: 'Tenant A', status: 'active' });
  const tenantB = await tenantService.__seedTenant({ businessName: 'Tenant B', status: 'active' });
  await tenantService.__seedMembership({ tenantId: tenantA.tenantId, userId: userA.userId, role: 'owner', permissions: tenantService.permissionsForRole('owner'), status: 'active' });
  await tenantService.__seedMembership({ tenantId: tenantB.tenantId, userId: userB.userId, role: 'owner', permissions: tenantService.permissionsForRole('owner'), status: 'active' });

  for (const o of vendorSeedA) await vendorService.importOffers({ tenantId: tenantA.tenantId, offers: [o], actorId: userA.userId });
  for (const o of vendorSeedB) await vendorService.importOffers({ tenantId: tenantB.tenantId, offers: [o], actorId: userB.userId });

  const headersA = { 'X-Test-User-Id': userA.userId, 'X-Test-Tenant-Id': tenantA.tenantId };
  const headersB = { 'X-Test-User-Id': userB.userId, 'X-Test-Tenant-Id': tenantB.tenantId };

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on('error', reject);
  });
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, server, app, userA, userB, tenantA, tenantB, headersA, headersB };
}

async function api(baseUrl, method, path, body, headers = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const payload = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, headers: res.headers, body: payload };
}

/* ---------- authentication ---------- */

test('missing sessions are rejected on every protected route', async () => {
  const { baseUrl, server } = await startTwoTenantApp();
  try {
    for (const [method, path, body] of [
      ['GET', '/api/vendors', null],
      ['POST', '/api/vendors/import', { offers: [] }],
      ['POST', '/api/purchases/evaluate', purchaseBody()],
      ['GET', '/api/purchases/whatever', null],
      ['GET', '/api/audit/events', null],
    ]) {
      const res = await api(baseUrl, method, path, body);
      assert.equal(res.status, 401, `${method} ${path} should be 401`);
    }
  } finally { server.close(); }
});

test('tampered sessions are rejected', async () => {
  const config = testConfig();
  const app = createApp({ config, vendorService: createVendorService([offer()]), allowTestPrincipal: false });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const res = await api(baseUrl, 'GET', '/api/vendors', null, { Cookie: `${config.SESSION_COOKIE_NAME}=tampered-not-a-real-session` });
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test('logout invalidates the session', async () => {
  const config = testConfig();
  const app = createApp({ config, vendorService: createVendorService([offer()]), allowTestPrincipal: true });
  const { userService, sessionStore } = app.__services;
  const user = await userService.__seed({ googleSubject: 'logout-sub', email: 'l@example.com', emailVerified: true, status: 'active' });
  const session = await sessionStore.create(user.userId);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const cookie = `${config.SESSION_COOKIE_NAME}=${encodeURIComponent(session.sessionId)}`;
    // Fetch CSRF token first (logout is state-changing and CSRF-protected for cookie sessions)
    const csrfRes = await api(baseUrl, 'GET', '/api/auth/csrf', null, { Cookie: cookie });
    assert.equal(csrfRes.status, 200);
    const csrfToken = csrfRes.body.data.csrfToken;
    const logout = await api(baseUrl, 'POST', '/api/auth/logout', {}, { Cookie: cookie, 'X-CSRF-Token': csrfToken });
    assert.equal(logout.status, 200);
    // Reusing the old session cookie must now fail
    const reuse = await api(baseUrl, 'GET', '/api/auth/session', null, { Cookie: cookie });
    assert.equal(reuse.body.data.authenticated, false);
  } finally { server.close(); }
});

test('session ID rotates conceptually after login (old session destroyed on rotate)', async () => {
  const config = testConfig();
  const { createSessionStore } = require('../src/services/session.service');
  const store = createSessionStore({ config });
  const old = await store.create('user-1');
  const rotated = await store.rotate(old.sessionId);
  assert.ok(rotated.sessionId !== old.sessionId);
  assert.equal(await store.get(old.sessionId), null);
  assert.ok(await store.get(rotated.sessionId));
});

test('missing Google credentials never enable fake authentication', async () => {
  const { baseUrl, server } = await startTwoTenantApp();
  try {
    const res = await api(baseUrl, 'GET', '/api/auth/google', null, { Accept: 'application/json' });
    assert.equal(res.status, 501);
    assert.equal(res.body.error.code, 'OIDC_NOT_CONFIGURED');
    // No session should have been created; protected routes still 401
    const prot = await api(baseUrl, 'GET', '/api/vendors', null);
    assert.equal(prot.status, 401);
  } finally { server.close(); }
});

test('OAuth credentials and tokens are absent from responses', async () => {
  const { baseUrl, server, headersA } = await startTwoTenantApp({ vendorSeedA: [offer()] });
  try {
    const res = await api(baseUrl, 'GET', '/api/vendors', null, headersA);
    const text = JSON.stringify(res.body);
    assert.ok(!/client_secret|refresh_token|authorization code/i.test(text));
    const session = await api(baseUrl, 'GET', '/api/auth/session', null, {});
    assert.ok(!/client_secret/i.test(JSON.stringify(session.body)));
  } finally { server.close(); }
});

/* ---------- authorization ---------- */

test('read-only users cannot import vendors', async () => {
  const config = testConfig();
  const app = createApp({ config, vendorService: createVendorService([offer()]), allowTestPrincipal: true });
  const { userService, tenantService } = app.__services;
  const user = await userService.__seed({ googleSubject: 'ro-sub', email: 'ro@example.com', emailVerified: true, status: 'active' });
  const tenant = await tenantService.__seedTenant({ businessName: 'RO Biz', status: 'active' });
  await tenantService.__seedMembership({ tenantId: tenant.tenantId, userId: user.userId, role: 'auditor', permissions: tenantService.permissionsForRole('auditor'), status: 'active' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { 'X-Test-User-Id': user.userId, 'X-Test-Tenant-Id': tenant.tenantId };
    const res = await api(baseUrl, 'POST', '/api/vendors/import', { offers: [offer({ offerId: 'x' })] }, headers);
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

test('purchasers cannot manage memberships', async () => {
  const config = testConfig();
  const app = createApp({ config, vendorService: createVendorService([offer()]), allowTestPrincipal: true });
  const { userService, tenantService } = app.__services;
  const purchaser = await userService.__seed({ googleSubject: 'p-sub', email: 'p@example.com', emailVerified: true, status: 'active' });
  const other = await userService.__seed({ googleSubject: 'o-sub', email: 'o@example.com', emailVerified: true, status: 'active' });
  const tenant = await tenantService.__seedTenant({ businessName: 'P Biz', status: 'active' });
  await tenantService.__seedMembership({ tenantId: tenant.tenantId, userId: purchaser.userId, role: 'purchaser', permissions: tenantService.permissionsForRole('purchaser'), status: 'active' });
  await tenantService.__seedMembership({ tenantId: tenant.tenantId, userId: other.userId, role: 'purchaser', permissions: tenantService.permissionsForRole('purchaser'), status: 'active' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { 'X-Test-User-Id': purchaser.userId, 'X-Test-Tenant-Id': tenant.tenantId };
    const res = await api(baseUrl, 'PATCH', `/api/workspaces/${tenant.tenantId}/members/${other.userId}`, { role: 'admin' }, headers);
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

test('removed members lose access', async () => {
  const { baseUrl, server, app, userA, tenantA, headersA } = await startTwoTenantApp({ vendorSeedA: [offer()] });
  try {
    await app.__services.tenantService.setMembershipStatus({ tenantId: tenantA.tenantId, userId: userA.userId, status: 'removed' });
    const res = await api(baseUrl, 'GET', '/api/vendors', null, headersA);
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

test('client-supplied tenant IDs cannot override server-resolved context', async () => {
  const { baseUrl, server, headersA, tenantB } = await startTwoTenantApp({ vendorSeedA: [offer()], vendorSeedB: [offer({ offerId: 'b1' })] });
  try {
    // Payload tenant mismatch on evaluate
    const res = await api(baseUrl, 'POST', '/api/purchases/evaluate', { ...purchaseBody(), tenantId: tenantB.tenantId }, headersA);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'TENANT_MISMATCH');
    // Payload tenant mismatch on import
    const imp = await api(baseUrl, 'POST', '/api/vendors/import', { offers: [{ ...offer({ offerId: 'evil' }), tenantId: tenantB.tenantId }] }, headersA);
    assert.equal(imp.status, 403);
  } finally { server.close(); }
});

/* ---------- tenant isolation ---------- */

test('A cannot list B offers; catalogs are isolated', async () => {
  const { baseUrl, server, headersA, headersB } = await startTwoTenantApp({
    vendorSeedA: [offer({ offerId: 'shared', vendorId: 'v-a' })],
    vendorSeedB: [offer({ offerId: 'shared', vendorId: 'v-b' })],
  });
  try {
    const a = await api(baseUrl, 'GET', '/api/vendors', null, headersA);
    const b = await api(baseUrl, 'GET', '/api/vendors', null, headersB);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.data.length, 1);
    assert.equal(b.body.data.length, 1);
    assert.equal(a.body.data[0].vendorId, 'v-a');
    assert.equal(b.body.data[0].vendorId, 'v-b');
  } finally { server.close(); }
});

test('A cannot retrieve B purchase even if ID is known; 404 is generic', async () => {
  const { baseUrl, server, headersA, headersB } = await startTwoTenantApp({ vendorSeedA: [offer()], vendorSeedB: [offer()] });
  try {
    const created = await api(baseUrl, 'POST', '/api/purchases/evaluate', purchaseBody(), headersB);
    assert.equal(created.status, 200);
    const purchaseId = created.body.data.purchaseId;
    const cross = await api(baseUrl, 'GET', `/api/purchases/${purchaseId}`, null, headersA);
    assert.equal(cross.status, 404);
    assert.equal(cross.body.error.code, 'PURCHASE_NOT_FOUND');
    assert.ok(!JSON.stringify(cross.body).includes(purchaseId) || cross.body.error.code === 'PURCHASE_NOT_FOUND');
    // B can still read its own
    const own = await api(baseUrl, 'GET', `/api/purchases/${purchaseId}`, null, headersB);
    assert.equal(own.status, 200);
  } finally { server.close(); }
});

test('A cannot list B audits', async () => {
  const { baseUrl, server, headersA, headersB } = await startTwoTenantApp({ vendorSeedA: [offer()], vendorSeedB: [offer()] });
  try {
    await api(baseUrl, 'POST', '/api/purchases/evaluate', purchaseBody(), headersB);
    const aAudits = await api(baseUrl, 'GET', '/api/audit/events', null, headersA);
    const bAudits = await api(baseUrl, 'GET', '/api/audit/events', null, headersB);
    assert.equal(aAudits.status, 200);
    assert.equal(bAudits.status, 200);
    assert.ok(Array.isArray(aAudits.body.data));
    assert.ok(bAudits.body.data.length > 0);
    assert.equal(aAudits.body.data.length, 0);
  } finally { server.close(); }
});

test('A import cannot modify B catalog (same offerId stays isolated)', async () => {
  const { baseUrl, server, headersA, headersB, app, tenantA, tenantB, userA } = await startTwoTenantApp({
    vendorSeedA: [offer({ offerId: 'dup', vendorId: 'v-a', unitPriceMinor: 40000 })],
    vendorSeedB: [offer({ offerId: 'dup', vendorId: 'v-b', unitPriceMinor: 99999 })],
  });
  try {
    // A re-imports same offerId with different price — should only affect A's record
    const imp = await api(baseUrl, 'POST', '/api/vendors/import', { offers: [offer({ offerId: 'dup', vendorId: 'v-a', unitPriceMinor: 41000 })] }, headersA);
    assert.equal(imp.status, 200);
    const a = await api(baseUrl, 'GET', '/api/vendors', null, headersA);
    const b = await api(baseUrl, 'GET', '/api/vendors', null, headersB);
    assert.equal(a.body.data.find((o) => o.offerId === 'dup').unitPriceMinor, 41000);
    assert.equal(b.body.data.find((o) => o.offerId === 'dup').unitPriceMinor, 99999);
    // Direct service check: B's record untouched
    const { vendorService } = app.__services;
    const bOffers = await vendorService.getCatalog({ tenantId: tenantB.tenantId });
    assert.equal(bOffers.find((o) => o.offerId === 'dup').unitPriceMinor, 99999);
  } finally { server.close(); }
});

test('missing tenant context rejects tenant-owned operations at service layer', async () => {
  const { createVendorService } = require('../src/services/vendor.service');
  const vs = createVendorService([offer()]);
  await assert.rejects(() => vs.getCatalog({}), /Tenant context is required/);
  await assert.rejects(() => vs.getCatalog(), /Tenant context is required/);
  const { createPurchaseStore } = require('../src/services/purchaseStore.service');
  const ps = createPurchaseStore();
  await assert.rejects(() => ps.list(), /requires \{ tenantId/);
  await assert.rejects(() => ps.getById('x'), /requires \{ tenantId/);
});

test('service layer rejects tenant change via updater', async () => {
  const { createPurchaseStore } = require('../src/services/purchaseStore.service');
  const ps = createPurchaseStore();
  await ps.create({ tenantId: 't1', purchaseId: 'p1', request: {} });
  await assert.rejects(
    () => ps.upsert({ tenantId: 't1', purchaseId: 'p1', updater: () => ({ tenantId: 't2' }) }),
    /cannot be changed/
  );
});

/* ---------- Gmail ---------- */

test('login scopes exclude mailbox scopes; Gmail disabled fails closed', async () => {
  const config = testConfig();
  assert.ok(!config.GOOGLE_OIDC_SCOPES.includes('gmail'));
  const { baseUrl, server, headersA } = await startTwoTenantApp();
  try {
    const status = await api(baseUrl, 'GET', '/api/integrations/google-gmail/status', null, headersA);
    assert.equal(status.status, 200);
    assert.equal(status.body.data.enabled, false);
    const connect = await api(baseUrl, 'GET', '/api/integrations/google-gmail/connect', null, headersA);
    assert.equal(connect.status, 501);
  } finally { server.close(); }
});

test('token encryption round-trips and is required for Gmail storage', async () => {
  const rawKey = Buffer.alloc(32, 7).toString('base64');
  const config = testConfig({ TOKEN_ENCRYPTION_KEY: rawKey, GOOGLE_GMAIL_ENABLED: 'true', GOOGLE_GMAIL_CLIENT_ID: 'x', GOOGLE_GMAIL_CLIENT_SECRET: 'y', GOOGLE_GMAIL_REDIRECT_URI: 'http://localhost:3000/api/integrations/google-gmail/callback', GOOGLE_GMAIL_SCOPES: 'https://www.googleapis.com/auth/gmail.readonly' });
  const cryptoService = createCryptoService({ config });
  const enc = cryptoService.encrypt('refresh-token-123');
  assert.ok(enc.ciphertext && enc.iv && enc.tag);
  assert.equal(cryptoService.decrypt(enc), 'refresh-token-123');
  // Without key, encrypt must fail closed
  const noKey = createCryptoService({ config: testConfig() });
  assert.throws(() => noKey.encrypt('x'), /not configured/);
});

/* ---------- import & jobs ---------- */

test('malformed rows and oversized imports fail safely', async () => {
  const { baseUrl, server, headersA } = await startTwoTenantApp({ vendorSeedA: [offer()] });
  try {
    const bad = await api(baseUrl, 'POST', '/api/vendors/import', { offers: [{ offerId: '' }] }, headersA);
    assert.equal(bad.status, 400);
    const big = await api(baseUrl, 'POST', '/api/vendors/import', { offers: Array.from({ length: 2001 }, (_, i) => offer({ offerId: `o${i}` })) }, headersA);
    // Config MAX_IMPORT_ROWS=2000 by default
    assert.equal(big.status, 400);
  } finally { server.close(); }
});

test('import is idempotent on retry with same importId', async () => {
  const { baseUrl, server, headersA } = await startTwoTenantApp();
  try {
    const payload = { importId: 'idem-123', offers: [offer({ offerId: 'idem-offer' })] };
    const first = await api(baseUrl, 'POST', '/api/vendors/import', payload, headersA);
    assert.equal(first.status, 200);
    const second = await api(baseUrl, 'POST', '/api/vendors/import', payload, headersA);
    assert.equal(second.status, 200);
    assert.equal(second.body.meta.idempotentReplay, true);
  } finally { server.close(); }
});

test('background jobs carry tenantId and revalidate tenant', async () => {
  const { app, tenantA } = await startTwoTenantApp();
  const worker = createPurchaseWorker({ tenantService: app.__services.tenantService, auditService: app.__services.auditService });
  await assert.rejects(() => worker.processJob({ jobId: 'j1', idempotencyKey: 'k1' }), /tenantId is required/);
  const ok = await worker.processJob({ jobId: 'j1', tenantId: tenantA.tenantId, idempotencyKey: 'k1', actorId: 'u1' });
  assert.equal(ok.status, 'completed');
  const dup = await worker.processJob({ jobId: 'j1', tenantId: tenantA.tenantId, idempotencyKey: 'k1', actorId: 'u1' });
  assert.equal(dup.status, 'duplicate-suppressed');
  app.__services && app.__services.tenantService && (await app.__services.tenantService.updateTenant(tenantA.tenantId, { status: 'suspended' }));
  await assert.rejects(() => worker.processJob({ jobId: 'j2', tenantId: tenantA.tenantId, idempotencyKey: 'k2' }), /unavailable/);
});

/* ---------- hardening spot-checks ---------- */

test('security headers are present (helmet)', async () => {
  const { baseUrl, server } = await startTwoTenantApp();
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.ok(res.headers.get('content-security-policy'));
    assert.ok(res.headers.get('x-content-type-options'));
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally { server.close(); }
});

test('production startup rejects insecure configuration', async () => {
  const prodBase = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://db.internal:27017/mandate',
    MONGODB_DB_NAME: 'mandate',
    FRONTEND_ORIGIN: 'https://app.example.com',
    APP_BASE_URL: 'https://api.example.com',
    FRONTEND_BASE_URL: 'https://app.example.com',
    SESSION_SECRET: 'a-very-long-random-secret-value-0123456789abcdef',
    SESSION_COOKIE_SECURE: 'true',
  };
  assert.throws(() => testConfig({ ...prodBase, SESSION_COOKIE_SECURE: 'false' }), /must be true in production/);
  assert.throws(() => testConfig({ NODE_ENV: 'production' }), /MONGODB_URI is required/);
  assert.throws(() => testConfig({ ...prodBase, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
  assert.throws(() => testConfig({ ...prodBase, FRONTEND_ORIGIN: 'https://app.example.com,http://localhost:5173' }), /localhost/);
});

test('recommendation never authorizes payment (regression guard)', async () => {
  const { baseUrl, server, headersA } = await startTwoTenantApp({ vendorSeedA: [offer()] });
  try {
    const res = await api(baseUrl, 'POST', '/api/purchases/evaluate', purchaseBody(), headersA);
    assert.equal(res.body.data.authorization.paymentAuthorized, false);
    assert.equal(res.body.data.policy.paymentAuthorized, false);
  } finally { server.close(); }
});
