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

async function startTwoTenantApp({ vendorSeedA = [], vendorSeedB = [], paypalService } = {}) {
  const config = testConfig();
  const vendorCollection = new FakeCollection();
  const app = createApp({
    config,
    vendorCollection,
    vendorService: createVendorService({ collection: vendorCollection }),
    auditService: createAuditService(),
    purchaseStore: createPurchaseStore(),
    paypalService,
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

async function closeServer(server) {
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
});

test('email/password signup and login create isolated personal workspaces', async () => {
  const config = testConfig();
  const app = createApp({ config, vendorCollection: new FakeCollection(), allowTestPrincipal: false });
  const { userService } = app.__services;
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on('error', reject);
  });
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const password = 'correct horse battery staple';
    const sessionCookie = (response) => {
      const cookie = response.headers.getSetCookie()
        .find((value) => value.startsWith(`${config.SESSION_COOKIE_NAME}=`));
      assert.ok(cookie, 'a session cookie must be issued');
      return cookie.split(';')[0];
    };

    const signupA = await api(baseUrl, 'POST', '/api/auth/register', {
      email: 'Alice@Example.com',
      password,
      displayName: 'Alice',
      businessName: 'Alice Co',
      // Client-supplied tenant IDs must never choose the new workspace.
      tenantId: 'tenant_attacker',
    });
    assert.equal(signupA.status, 201);
    assert.equal(signupA.body.data.user.email, 'alice@example.com');
    assert.equal(signupA.body.data.authenticated, true);
    assert.equal(signupA.body.data.user.authProvider, 'local');
    assert.equal(signupA.body.data.user.emailVerified, false);
    assert.ok(signupA.body.data.user.lastLoginAt);
    assert.ok(!Object.prototype.hasOwnProperty.call(signupA.body.data.user, 'passwordHash'));
    assert.ok(!Object.prototype.hasOwnProperty.call(signupA.body.data.user, 'googleSubject'));
    const cookieA = sessionCookie(signupA);
    assert.match(cookieA, new RegExp(`^${config.SESSION_COOKIE_NAME}=`));

    const storedA = await userService.findByEmail('alice@example.com');
    assert.match(storedA.passwordHash, /^scrypt\$/);
    assert.notEqual(storedA.passwordHash, password);
    assert.equal(storedA.googleSubject, undefined, 'local users must not occupy the Google subject index');

    const workspacesA = await api(baseUrl, 'GET', '/api/workspaces/me', null, { Cookie: cookieA });
    assert.equal(workspacesA.status, 200);
    assert.equal(workspacesA.body.data.memberships.length, 1);
    const tenantA = workspacesA.body.data.memberships[0].tenantId;
    assert.match(tenantA, /^tenant_personal_/);
    assert.notEqual(tenantA, 'tenant_attacker');

    const signupB = await api(baseUrl, 'POST', '/api/auth/register', {
      email: 'bob@example.com',
      password,
      displayName: 'Bob',
    });
    assert.equal(signupB.status, 201);
    const cookieB = sessionCookie(signupB);
    const workspacesB = await api(baseUrl, 'GET', '/api/workspaces/me', null, { Cookie: cookieB });
    assert.equal(workspacesB.status, 200);
    assert.equal(workspacesB.body.data.memberships.length, 1);
    const tenantB = workspacesB.body.data.memberships[0].tenantId;
    assert.notEqual(tenantA, tenantB, 'each local user gets a separate workspace');

    const duplicate = await api(baseUrl, 'POST', '/api/auth/register', {
      email: 'alice@example.com', password, displayName: 'Other Alice',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'EMAIL_IN_USE');

    const wrong = await api(baseUrl, 'POST', '/api/auth/login', {
      email: 'alice@example.com', password: 'wrong password value',
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');

    const login = await api(baseUrl, 'POST', '/api/auth/login', {
      email: 'alice@example.com', password,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.data.user.email, 'alice@example.com');
    assert.ok(!JSON.stringify(login.body).includes(storedA.passwordHash));
    const loginCookie = sessionCookie(login);
    const loginWorkspaces = await api(baseUrl, 'GET', '/api/workspaces/me', null, { Cookie: loginCookie });
    assert.deepEqual(
      loginWorkspaces.body.data.memberships.map((m) => m.tenantId),
      [tenantA],
      'login only resolves the authenticated user\'s workspace'
    );

    const crossTenant = await api(
      baseUrl,
      'GET',
      '/api/vendors',
      null,
      { Cookie: cookieA, 'X-Tenant-Id': tenantB }
    );
    assert.equal(crossTenant.status, 403);
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
});

test('OAuth credentials and tokens are absent from responses', async () => {
  const { baseUrl, server, headersA } = await startTwoTenantApp({ vendorSeedA: [offer()] });
  try {
    const res = await api(baseUrl, 'GET', '/api/vendors', null, headersA);
    const text = JSON.stringify(res.body);
    assert.ok(!/client_secret|refresh_token|authorization code/i.test(text));
    const session = await api(baseUrl, 'GET', '/api/auth/session', null, {});
    assert.ok(!/client_secret/i.test(JSON.stringify(session.body)));
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
});

test('removed members lose access', async () => {
  const { baseUrl, server, app, userA, tenantA, headersA } = await startTwoTenantApp({ vendorSeedA: [offer()] });
  try {
    await app.__services.tenantService.setMembershipStatus({ tenantId: tenantA.tenantId, userId: userA.userId, status: 'removed' });
    const res = await api(baseUrl, 'GET', '/api/vendors', null, headersA);
    assert.equal(res.status, 403);
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
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
  } finally { await closeServer(server); }
});

test('background jobs carry tenantId and revalidate tenant', async () => {
  const { app, tenantA, server } = await startTwoTenantApp();
  try {
    const worker = createPurchaseWorker({ tenantService: app.__services.tenantService, auditService: app.__services.auditService });
    await assert.rejects(() => worker.processJob({ jobId: 'j1', idempotencyKey: 'k1' }), /tenantId is required/);
    const ok = await worker.processJob({ jobId: 'j1', tenantId: tenantA.tenantId, idempotencyKey: 'k1', actorId: 'u1' });
    assert.equal(ok.status, 'completed');
    const dup = await worker.processJob({ jobId: 'j1', tenantId: tenantA.tenantId, idempotencyKey: 'k1', actorId: 'u1' });
    assert.equal(dup.status, 'duplicate-suppressed');
    app.__services && app.__services.tenantService && (await app.__services.tenantService.updateTenant(tenantA.tenantId, { status: 'suspended' }));
    await assert.rejects(() => worker.processJob({ jobId: 'j2', tenantId: tenantA.tenantId, idempotencyKey: 'k2' }), /unavailable/);
  } finally { await closeServer(server); }
});

/* ---------- hardening spot-checks ---------- */

test('security headers are present (helmet)', async () => {
  const { baseUrl, server } = await startTwoTenantApp();
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.ok(res.headers.get('content-security-policy'));
    assert.ok(res.headers.get('x-content-type-options'));
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally { await closeServer(server); }
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

test('TRUST_PROXY accepts an explicit hop count and still rejects blind trust in production', () => {
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

  // Render terminates TLS in front of the service, so one trusted hop.
  assert.equal(testConfig({ TRUST_PROXY: '1' }).TRUST_PROXY, 1);
  assert.equal(testConfig({ ...prodBase, TRUST_PROXY: '1' }).TRUST_PROXY, 1);
  assert.equal(testConfig({ TRUST_PROXY: '2' }).TRUST_PROXY, 2);
  assert.equal(testConfig({ TRUST_PROXY: '0' }).TRUST_PROXY, false);
  assert.equal(testConfig({ TRUST_PROXY: 'false' }).TRUST_PROXY, false);

  // Blind trust remains dev-only.
  assert.equal(testConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY, true);
  assert.throws(() => testConfig({ ...prodBase, TRUST_PROXY: 'true' }), /blindly trust all proxies/);

  const app = createApp({
    config: testConfig({ TRUST_PROXY: '1' }),
    vendorCollection: new FakeCollection(),
    allowTestPrincipal: false,
  });
  assert.equal(app.get('trust proxy'), 1, 'Express must receive the numeric hop count');
});

test('rate limiting uses the client IP from X-Forwarded-For behind the proxy', async () => {
  const config = testConfig({ TRUST_PROXY: '1', RATE_LIMIT_MAX_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '60000' });
  const app = createApp({ config, vendorCollection: new FakeCollection(), allowTestPrincipal: false });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on('error', reject);
  });
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;
    const hit = (clientIp) => fetch(`${baseUrl}/api/health`, { headers: { 'X-Forwarded-For': clientIp } });

    assert.equal((await hit('203.0.113.10')).status, 200);
    // A different forwarded client IP has its own bucket, proving the limiter
    // keys on req.ip rather than the proxy's socket address.
    assert.equal((await hit('203.0.113.11')).status, 200);
    assert.equal((await hit('203.0.113.10')).status, 429);
  } finally { await closeServer(server); }
});

test('production Google callback must use the browser-facing frontend origin', () => {
  const prodBase = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb://db.internal:27017/mandate',
    MONGODB_DB_NAME: 'mandate',
    FRONTEND_ORIGIN: 'https://app.example.com',
    APP_BASE_URL: 'https://api.example.com',
    FRONTEND_BASE_URL: 'https://app.example.com',
    SESSION_SECRET: 'a-very-long-random-secret-value-0123456789abcdef',
    SESSION_COOKIE_SECURE: 'true',
    GOOGLE_OIDC_ENABLED: 'true',
    GOOGLE_OIDC_CLIENT_ID: 'client-id',
    GOOGLE_OIDC_CLIENT_SECRET: 'client-secret',
  };

  const frontendCallback = 'https://app.example.com/api/auth/google/callback';
  assert.equal(
    testConfig({ ...prodBase, GOOGLE_OIDC_REDIRECT_URI: frontendCallback }).GOOGLE_OIDC_REDIRECT_URI,
    frontendCallback
  );

  // The transaction cookie is host-scoped to the Vercel origin, so a Render
  // callback URL cannot read it.
  assert.throws(
    () => testConfig({ ...prodBase, GOOGLE_OIDC_REDIRECT_URI: 'https://api.example.com/api/auth/google/callback' }),
    /frontend origin/
  );
  assert.throws(
    () => testConfig({ ...prodBase, GOOGLE_OIDC_REDIRECT_URI: 'https://app.example.com/auth/callback' }),
    /\/api\/auth\/google\/callback/
  );
});

test('Google login succeeds with the transaction cookie and preserves state, nonce, and PKCE', async () => {
  const crypto = require('node:crypto');
  const config = testConfig({
    GOOGLE_OIDC_ENABLED: 'true',
    GOOGLE_OIDC_CLIENT_ID: 'client-id',
    GOOGLE_OIDC_CLIENT_SECRET: 'client-secret',
    GOOGLE_OIDC_REDIRECT_URI: 'http://localhost:5173/api/auth/google/callback',
    SESSION_COOKIE_SECURE: 'true',
  });
  const exchangeCalls = [];
  const oidcExchange = async (args) => {
    exchangeCalls.push(args);
    return { sub: 'google-sub-1', email: 'user@example.com', email_verified: true, name: 'Test User' };
  };
  const app = createApp({
    config,
    vendorCollection: new FakeCollection(),
    allowTestPrincipal: false,
    oidcExchange,
  });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on('error', reject);
  });
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const authUrl = new URL(start.headers.get('location'));
    const state = authUrl.searchParams.get('state');
    const nonce = authUrl.searchParams.get('nonce');
    const challenge = authUrl.searchParams.get('code_challenge');
    assert.equal(authUrl.searchParams.get('redirect_uri'), config.GOOGLE_OIDC_REDIRECT_URI);
    assert.ok(state && nonce && challenge);

    const startCookies = start.headers.getSetCookie();
    const txCookie = startCookies.find((cookie) => cookie.startsWith('mandate.oauth_tx='));
    assert.ok(txCookie, 'transaction cookie must be issued');
    const cookiePath = (txCookie.match(/Path=([^;]+)/) || [])[1];
    assert.equal(cookiePath, '/api/auth/google');
    assert.ok('/api/auth/google/callback'.startsWith(cookiePath), 'cookie path must cover the callback');
    assert.match(txCookie, /; Secure(?:;|$)/);
    assert.match(txCookie, /; HttpOnly(?:;|$)/);
    assert.match(txCookie, /; SameSite=Lax(?:;|$)/);
    assert.ok(!/;\s*Domain=/i.test(txCookie), 'transaction cookie must be host-only');
    const txCookiePair = txCookie.split(';')[0];

    const callback = await fetch(
      `${baseUrl}/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}&iss=${encodeURIComponent('https://accounts.google.com')}`,
      { redirect: 'manual', headers: { Cookie: txCookiePair } }
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), 'http://localhost:5173/app/dashboard?auth=success');

    const callbackCookies = callback.headers.getSetCookie();
    assert.ok(callbackCookies.some((cookie) => cookie.startsWith('mandate.oauth_tx=;')), 'transaction cookie is cleared');
    const sessionCookie = callbackCookies.find((cookie) => cookie.startsWith(`${config.SESSION_COOKIE_NAME}=`));
    assert.ok(sessionCookie, 'session cookie must be issued');

    assert.equal(exchangeCalls.length, 1);
    assert.equal(exchangeCalls[0].code, 'test-code');
    assert.equal(exchangeCalls[0].state, state);
    assert.equal(exchangeCalls[0].authorizationResponseIssuer, 'https://accounts.google.com');
    assert.equal(exchangeCalls[0].nonce, nonce);
    assert.ok(exchangeCalls[0].codeVerifier);
    assert.equal(
      crypto.createHash('sha256').update(exchangeCalls[0].codeVerifier).digest('base64url'),
      challenge,
      'PKCE verifier must match the authorization challenge'
    );

    const sessionRes = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: sessionCookie.split(';')[0] },
    });
    const sessionBody = await sessionRes.json();
    assert.equal(sessionBody.data.authenticated, true);
    assert.equal(sessionBody.data.user.email, 'user@example.com');
    assert.equal(sessionBody.data.workspaces.length, 1, 'Google sign-in must provision a personal workspace');
    assert.equal(sessionBody.data.workspaces[0].role, 'owner');
    assert.ok(sessionBody.data.workspaces[0].tenantId);
    assert.equal(sessionBody.data.user.authProvider, 'google');
    assert.equal(sessionBody.data.user.emailVerified, true);
    assert.ok(sessionBody.data.user.lastLoginAt);
    assert.ok(sessionBody.data.user.createdAt);
    assert.equal(Object.hasOwn(sessionBody.data.user, 'googleSubject'), false);
    assert.equal(Object.hasOwn(sessionBody.data.user, 'passwordHash'), false);
  } finally { await closeServer(server); }
});

test('callback failures log a specific safe reason and fail closed', async (t) => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));

  const config = testConfig({
    GOOGLE_OIDC_ENABLED: 'true',
    GOOGLE_OIDC_CLIENT_ID: 'client-id',
    GOOGLE_OIDC_CLIENT_SECRET: 'client-secret',
    GOOGLE_OIDC_REDIRECT_URI: 'http://localhost:5173/api/auth/google/callback',
  });
  const app = createApp({ config, vendorCollection: new FakeCollection(), allowTestPrincipal: false });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on('error', reject);
  });
  try {
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Missing transaction cookie: the exact production failure mode when the
    // callback lands on a different host than the one that set the cookie.
    const missing = await fetch(
      `${baseUrl}/api/auth/google/callback?code=secret-code&state=secret-state`,
      { redirect: 'manual', headers: { Accept: 'application/json' } }
    );
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.error.code, 'OAUTH_TRANSACTION_INVALID');
    let entry = logs.find((line) => line.includes('[AUTH]') && line.includes('transaction_cookie_missing'));
    assert.ok(entry, 'missing cookie reason must be logged');
    assert.ok(!entry.includes('secret-code'));
    assert.ok(!entry.includes('secret-state'));

    // State mismatch consumes the transaction and is logged precisely.
    const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: 'manual' });
    const authUrl = new URL(start.headers.get('location'));
    const state = authUrl.searchParams.get('state');
    const txCookie = start.headers.getSetCookie()
      .find((cookie) => cookie.startsWith('mandate.oauth_tx='))
      .split(';')[0];

    const mismatch = await fetch(
      `${baseUrl}/api/auth/google/callback?code=test-code&state=wrong-state`,
      { redirect: 'manual', headers: { Accept: 'application/json', Cookie: txCookie } }
    );
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, 'OAUTH_TRANSACTION_INVALID');
    entry = logs.find((line) => line.includes('[AUTH]') && line.includes('transaction_state_mismatch'));
    assert.ok(entry, 'state mismatch reason must be logged');

    // The mis-matching callback consumed the single-use transaction.
    const replay = await fetch(
      `${baseUrl}/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual', headers: { Accept: 'application/json', Cookie: txCookie } }
    );
    assert.equal(replay.status, 400);
    entry = logs.find((line) => line.includes('[AUTH]') && line.includes('transaction_not_found'));
    assert.ok(entry, 'replayed transaction reason must be logged');
  } finally { await closeServer(server); }
});

test('recommendation never authorizes payment (regression guard)', async () => {
  const { baseUrl, server, headersA } = await startTwoTenantApp({ vendorSeedA: [offer()] });
  try {
    const res = await api(baseUrl, 'POST', '/api/purchases/evaluate', purchaseBody(), headersA);
    assert.equal(res.body.data.authorization.paymentAuthorized, false);
    assert.equal(res.body.data.policy.paymentAuthorized, false);
  } finally { await closeServer(server); }
});


/* ---------- approvals, payments, webhooks ---------- */

function seedPurchase(tenantId, purchaseId, overrides = {}) {
  return {
    tenantId,
    purchaseId,
    requestId: `req_${purchaseId}`,
    request: { productId: 'BRG-6204', quantity: 10, maxTotalMinor: 5000000, currency: 'INR', maxDeliveryDays: 5 },
    decision: { status: 'RECOMMENDED' },
    policy: { passed: true },
    recommendation: { offerId: 'offer-1', vendorId: 'vendor-1', totalMinor: 400000, currency: 'INR', score: 90 },
    authorization: { requiresHumanApproval: true, humanApproved: false, paymentAuthorized: false, paymentCaptured: false },
    approvalStatus: 'PENDING',
    paymentStatus: 'NONE',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakePaypal({ enabled = true, captureResult } = {}) {
  const calls = { createOrder: [], captureOrder: [], verifyOrder: [], verifyWebhookSignature: [] };
  return {
    calls,
    isEnabled: () => enabled,
    async createOrder(args) {
      calls.createOrder.push(args);
      return { id: 'ORDER-TEST', status: 'CREATED', links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-TEST' }] };
    },
    async getOrder(orderId) {
      return { id: orderId, status: 'CREATED', links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-TEST' }] };
    },
    async captureOrder(args) {
      calls.captureOrder.push(args);
      return captureResult || { status: 'COMPLETED', amountMinor: args.expectedAmountMinor, currency: args.expectedCurrency, captureId: 'CAP-TEST' };
    },
    async verifyOrder(args) {
      calls.verifyOrder.push(args);
      return { valid: true, reasons: [] };
    },
    async verifyWebhookSignature(args) {
      calls.verifyWebhookSignature.push(args);
      return false;
    },
    parseWebhookEvent() { return { eventType: 'CHECKOUT.ORDER.APPROVED', eventId: 'EVT-TEST', orderId: 'ORDER-TEST' }; },
  };
}

test('PayPal configuration is sandbox-only and credentials must be paired', () => {
  assert.throws(() => testConfig({ PAYPAL_ENV: 'live', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' }), /must be "sandbox"/i);
  assert.throws(() => testConfig({ PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'id' }), /must both be set/i);
});

test('approval requires the server permission and is single-use', async () => {
  const { baseUrl, server, app, headersA, tenantA } = await startTwoTenantApp();
  try {
    const { userService, tenantService, purchaseStore } = app.__services;
    const purchaser = await userService.__seed({ googleSubject: 'apr-purchaser', email: 'purchaser@example.com', emailVerified: true, status: 'active' });
    await tenantService.__seedMembership({ tenantId: tenantA.tenantId, userId: purchaser.userId, role: 'purchaser', permissions: tenantService.permissionsForRole('purchaser'), status: 'active' });
    const record = await purchaseStore.create(seedPurchase(tenantA.tenantId, 'purchase_approve_1'));
    const purchaserHeaders = { 'X-Test-User-Id': purchaser.userId, 'X-Test-Tenant-Id': tenantA.tenantId };

    const forbidden = await api(baseUrl, 'POST', `/api/approvals/purchase/${record.purchaseId}/approve`, { rationale: 'nope' }, purchaserHeaders);
    assert.equal(forbidden.status, 403);

    const approved = await api(baseUrl, 'POST', `/api/approvals/purchase/${record.purchaseId}/approve`, { rationale: 'checked' }, headersA);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.data.approvalStatus, 'APPROVED');
    assert.equal(approved.body.data.authorization.paymentCaptured, false);

    const again = await api(baseUrl, 'POST', `/api/approvals/purchase/${record.purchaseId}/approve`, { rationale: 'again' }, headersA);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_DECIDED');
  } finally { await closeServer(server); }
});

test('payment requires approval, uses the recommendation amount, and completes only on verified capture', async () => {
  const paypal = fakePaypal();
  const { baseUrl, server, app, headersA, tenantA } = await startTwoTenantApp({ paypalService: paypal });
  try {
    const purchaseStore = app.__services.purchaseStore;
    const pending = await purchaseStore.create(seedPurchase(tenantA.tenantId, 'purchase_pending_1'));

    const blocked = await api(baseUrl, 'POST', `/api/payments/create/${pending.purchaseId}`, {}, headersA);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'APPROVAL_REQUIRED');
    assert.equal(paypal.calls.createOrder.length, 0);

    const approved = await purchaseStore.create(seedPurchase(tenantA.tenantId, 'purchase_approved_1', {
      // PayPal Checkout does not support INR; use USD in this sandbox test
      // so the test exercises approval/order/capture rather than currency rejection.
      request: { productId: 'BRG-6204', quantity: 10, maxTotalMinor: 5000000, currency: 'USD', maxDeliveryDays: 5 },
      recommendation: { offerId: 'offer-1', vendorId: 'vendor-1', totalMinor: 400000, currency: 'USD', score: 90 },
      approvalStatus: 'APPROVED',
      approval: { decision: 'APPROVED', approvedAt: new Date().toISOString(), approvedBy: 'owner' },
      authorization: { requiresHumanApproval: false, humanApproved: true, paymentAuthorized: false, paymentCaptured: false },
    }));
    const created = await api(baseUrl, 'POST', `/api/payments/create/${approved.purchaseId}`, {}, headersA);
    assert.equal(created.status, 200);
    assert.equal(created.body.data.paypalOrderId, 'ORDER-TEST');
    assert.equal(paypal.calls.createOrder.length, 1);
    assert.equal(paypal.calls.createOrder[0].amountMinor, 400000, 'uses recommendation total, not the budget ceiling');
    assert.notEqual(paypal.calls.createOrder[0].amountMinor, approved.request.maxTotalMinor);

    const captured = await api(baseUrl, 'POST', `/api/payments/capture/${approved.purchaseId}`, { orderId: 'ORDER-TEST' }, headersA);
    assert.equal(captured.status, 200);
    assert.equal(captured.body.data.captureStatus, 'COMPLETED');

    const status = await api(baseUrl, 'GET', `/api/payments/status/${approved.purchaseId}`, null, headersA);
    assert.equal(status.status, 200);
    assert.equal(status.body.data.paymentStatus, 'COMPLETED');
    assert.equal(status.body.data.authorization.paymentCaptured, true);
  } finally { await closeServer(server); }
});

test('an unverified PayPal capture never marks the purchase paid', async () => {
  const paypal = fakePaypal({ captureResult: { status: 'PENDING', amountMinor: 400000, currency: 'INR', captureId: null } });
  const { baseUrl, server, app, headersA, tenantA } = await startTwoTenantApp({ paypalService: paypal });
  try {
    const record = await app.__services.purchaseStore.create(seedPurchase(tenantA.tenantId, 'purchase_pending_capture', {
      // Use a PayPal-supported currency to reach the capture verification path.
      request: { productId: 'BRG-6204', quantity: 10, maxTotalMinor: 5000000, currency: 'USD', maxDeliveryDays: 5 },
      recommendation: { offerId: 'offer-1', vendorId: 'vendor-1', totalMinor: 400000, currency: 'USD', score: 90 },
      approvalStatus: 'APPROVED',
      approval: { approvedAt: new Date().toISOString() },
      authorization: { requiresHumanApproval: false, humanApproved: true, paymentAuthorized: false, paymentCaptured: false },
    }));
    await api(baseUrl, 'POST', `/api/payments/create/${record.purchaseId}`, {}, headersA);
    const captured = await api(baseUrl, 'POST', `/api/payments/capture/${record.purchaseId}`, { orderId: 'ORDER-TEST' }, headersA);
    assert.equal(captured.status, 502);
    assert.equal(captured.body.error.code, 'PAYMENT_NOT_COMPLETED');
    const status = await api(baseUrl, 'GET', `/api/payments/status/${record.purchaseId}`, null, headersA);
    assert.notEqual(status.body.data.paymentStatus, 'COMPLETED');
    assert.equal(status.body.data.authorization.paymentCaptured, false);
  } finally { await closeServer(server); }
});

test('PayPal webhook fails closed for invalid signatures and when not configured', async () => {
  const paypal = fakePaypal();
  const enabled = await startTwoTenantApp({ paypalService: paypal });
  try {
    const res = await fetch(`${enabled.baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'EVT-TEST', event_type: 'CHECKOUT.ORDER.APPROVED' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'WEBHOOK_SIGNATURE_INVALID');
    assert.equal(paypal.calls.verifyWebhookSignature.length, 1);
  } finally { await closeServer(enabled.server); }

  const disabled = await startTwoTenantApp({ paypalService: fakePaypal({ enabled: false }) });
  try {
    const res = await fetch(`${disabled.baseUrl}/api/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'EVT-TEST' }),
    });
    assert.equal(res.status, 503);
  } finally { await closeServer(disabled.server); }
});
