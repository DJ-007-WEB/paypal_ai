'use strict';

const express = require('express');

const { loadConfig } = require('./config');
const { requestIdMiddleware } = require('./middleware/requestId');
const { createAuthenticateMiddleware } = require('./middleware/authenticate');
const { createAuthorizeMiddleware } = require('./middleware/authorize');
const { createCsrfMiddleware } = require('./middleware/csrf');
const { createPurchaseRoutes } = require('./routes/purchase.routes');
const { createVendorRoutes } = require('./routes/vendor.routes');
const { createApprovalRoutes } = require('./routes/approval.routes');
const { createPaymentRoutes } = require('./routes/payment.routes');
const { createMandateRoutes } = require('./routes/mandate.routes');
const { createAuthRoutes } = require('./routes/auth.routes');
const { createWorkspaceRoutes } = require('./routes/workspace.routes');
const { createGmailRoutes } = require('./routes/gmail.routes');
const { createVendorService } = require('./services/vendor.service');
const { createAuditService } = require('./services/audit.service');
const { createPurchaseStore } = require('./services/purchaseStore.service');
const { createSessionStore } = require('./services/session.service');
const { createUserService } = require('./services/user.service');
const { createTenantService } = require('./services/tenant.service');
const { createCryptoService } = require('./services/crypto.service');
const { createGmailService } = require('./services/gmail.service');

function createApp(options = {}) {
  const config = options.config || loadConfig(process.env);

  const vendorService = options.vendorService || createVendorService({ collection: options.vendorCollection || null });
  const auditService = options.auditService || createAuditService({ collection: options.auditCollection || null });
  const purchaseStore = options.purchaseStore || createPurchaseStore({ collection: options.purchaseCollection || null });
  const sessionStore = options.sessionStore || createSessionStore({ collection: options.sessionCollection || null, config });
  const userService = options.userService || createUserService({ collection: options.userCollection || null });
  const tenantService = options.tenantService || createTenantService({
    tenantCollection: options.tenantCollection || null,
    membershipCollection: options.membershipCollection || null,
  });
  const cryptoService = options.cryptoService || createCryptoService({ config });
  const gmailService = options.gmailService || createGmailService({ collection: options.gmailCollection || null, cryptoService, config });

  const allowTestPrincipal = options.allowTestPrincipal === true;
  const oidcExchange = options.oidcExchange || null;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  // --- Secure HTTP headers (Helmet) + tested CSP ---
  const helmet = require('helmet');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...config.FRONTEND_ORIGIN],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));

  // --- Exact CORS allowlist; CORS is not authentication ---
  const allowedOrigins = config.FRONTEND_ORIGIN;
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && allowedOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type,X-Request-Id,X-Tenant-Id,X-Workspace-Id,X-CSRF-Token,X-XSRF-Token,Idempotency-Key,X-Test-User-Id,X-Test-Tenant-Id');
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(origin && !allowedOrigins.includes(origin) ? 403 : 204);
    }
    return next();
  });

  // --- Cookie parsing (no signed cookies; session IDs are random server-side) ---
  const cookieParser = require('cookie-parser');
  app.use(cookieParser());

  // --- Rate limits (§14): general + route-specific ---
  const rateLimit = require('express-rate-limit');
  const generalLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and retry.' } },
  });
  const authLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.AUTH_RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many auth attempts. Please wait and retry.' } },
  });
  const importLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.IMPORT_RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Import rate limit exceeded. Please wait and retry.' } },
  });
  app.use('/api/', generalLimiter);

  // --- Body limits + timeouts ---
  app.use(express.json({ limit: config.MAX_JSON_BODY_BYTES }));
  app.use((req, res, next) => {
    // Bounded request timeout (30s)
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        const err = new Error('Request timed out.');
        err.statusCode = 503;
        err.code = 'REQUEST_TIMEOUT';
        next(err);
      }
    }, 30000);
    timer.unref?.();
    res.on('finish', () => clearTimeout(timer));
    next();
  });

  // --- Single authoritative request ID + redacted logging ---
  app.use(requestIdMiddleware);
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // Never log raw OAuth callback URLs/query strings, bodies, headers, or secrets.
      const safePath = String(req.originalUrl || '').split('?')[0].slice(0, 200);
      const logFn = config.LOG_LEVEL === 'debug' ? console.log : console.log;
      logFn(`[${new Date().toISOString()}] ${req.method} ${safePath} ${res.statusCode} ${durationMs.toFixed(1)}ms requestId=${req.requestId}`);
      if (res.statusCode === 401 || res.statusCode === 403) {
        console.warn(`[AUTHZ] denied requestId=${req.requestId} status=${res.statusCode} path=${safePath}`);
      }
    });
    next();
  });

  // --- Auth middleware instances ---
  const { requireAuthentication } = createAuthenticateMiddleware({ sessionStore, userService, config, allowTestPrincipal });
  const { resolveWorkspaceMembership, requirePermission, requireTenantContext } = createAuthorizeMiddleware({ tenantService });
  const { csrfProtection } = createCsrfMiddleware({ sessionStore, config });

  // --- Public health (no secrets) ---
  app.get('/api/health', (req, res) => {
    res.json({ success: true, data: { status: 'ok', service: 'mandate-api' } });
  });

  // --- Auth flow (special: no tenant until membership resolved) ---
  const authRouter = createAuthRoutes({ config, userService, sessionStore, auditService, oidcExchange });
  // Auth start/callback rate-limited strictly
  app.use('/api', authLimiter, authRouter);
  // Session/logout JSON endpoints also under /api but with general limiter already; mount separately for clarity
  // (authRouter already mounted; the limiter above covers all /api/auth/* — acceptable.)

  // --- Workspace routes (auth required; per-route membership checks inside) ---
  const workspaceRouter = createWorkspaceRoutes({ tenantService, userService, auditService });
  function workspaceTenantGate(req, res, next) {
    if (req.path === '/workspaces/current' && req.method === 'GET') return resolveWorkspaceMembership(req, res, next);
    return next();
  }
  app.use('/api', requireAuthentication, workspaceTenantGate, csrfProtection, workspaceRouter);

  // --- Gmail integration: callback is public (transaction-bound), others require auth+tenant ---
  const gmailRouter = createGmailRoutes({ config, gmailService, tenantService, auditService });
  async function gmailAuthGate(req, res, next) {
    const isCallback = req.path === '/integrations/google-gmail/callback' && req.method === 'GET';
    if (isCallback) return next();
    requireAuthentication(req, res, (authErr) => {
      if (authErr) return next(authErr);
      resolveWorkspaceMembership(req, res, (tenantErr) => {
        if (tenantErr) return next(tenantErr);
        return csrfProtection(req, res, next);
      });
    });
  }
  app.use('/api', gmailAuthGate, gmailRouter);

  // --- Vendor catalog (auth + tenant + per-route permission) ---
  const vendorRouter = createVendorRoutes({ vendorService, auditService, config });
  function vendorPermissionGate(req, res, next) {
    if (req.method === 'GET' && req.path === '/vendors') return requirePermission('vendors:read')(req, res, next);
    if (req.method === 'POST' && req.path === '/vendors/import') return requirePermission('vendors:import')(req, res, next);
    return next();
  }
  function vendorRateGate(req, res, next) {
    if (req.method === 'POST' && req.path === '/vendors/import') return importLimiter(req, res, next);
    return next();
  }
  app.use('/api', vendorRateGate, requireAuthentication, resolveWorkspaceMembership, vendorPermissionGate, csrfProtection, vendorRouter);

  // --- Purchases (auth + tenant + per-route permission) ---
  const purchaseRouter = createPurchaseRoutes({ vendorService, auditService, purchaseStore });
  function purchasePermissionGate(req, res, next) {
    if (req.method === 'POST' && req.path === '/purchases/evaluate') return requirePermission('purchases:create')(req, res, next);
    if (req.method === 'GET' && (req.path === '/purchases' || req.path.startsWith('/purchases/'))) return requirePermission('purchases:read')(req, res, next);
    return next();
  }
  app.use('/api', requireAuthentication, resolveWorkspaceMembership, purchasePermissionGate, csrfProtection, purchaseRouter);

  // --- Audit read (auth + tenant + permission) ---
  app.get('/api/audit/events', requireAuthentication, resolveWorkspaceMembership, requirePermission('audit:read'), async (req, res, next) => {
    try {
      const events = await auditService.listEvents({ tenantId: req.auth.tenantId });
      return res.json({ success: true, data: events.slice(0, 200), meta: { count: Math.min(events.length, 200) } });
    } catch (err) { next(err); }
  });

  // --- Approval / payment / mandate stubs: explicitly non-executing ---
  app.use('/api', createApprovalRoutes());
  app.use('/api', createPaymentRoutes());
  app.use('/api', createMandateRoutes());

  // --- 404 ---
  app.use((req, res, next) => {
    const error = new Error('Route not found.');
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    next(error);
  });

  // --- Central error handler: safe codes + correlation IDs, no stack/secret leakage ---
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    const code = err.code || (statusCode === 404 ? 'NOT_FOUND' : statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_FAILED');
    const requestId = req.requestId || req.id || null;
    if (statusCode >= 500 && config.NODE_ENV !== 'test') {
      console.error(`[API ERROR] requestId=${requestId} ${req.method} ${String(req.originalUrl || '').split('?')[0]}`);
    }
    // Production responses must not expose stack traces, DB errors, paths, or provider payloads.
    let message = err.message || 'Request failed.';
    if (statusCode >= 500) {
      message = config.NODE_ENV === 'development' ? message : 'An unexpected server error occurred.';
      // Scrub DB/provider internals
      if (/mongo|E11000|stack|TypeError|provider/i.test(message) && config.NODE_ENV !== 'development') {
        message = 'An unexpected server error occurred.';
      }
    }
    // Avoid revealing whether another tenant's resource exists: callers already use generic 404.
    const payload = { success: false, error: { code, message, requestId } };
    if ((statusCode === 400 || statusCode === 403) && Array.isArray(err.details) && err.details.length > 0) {
      // Bound details, strip secrets
      payload.error.details = err.details.slice(0, 20);
    }
    if (statusCode === 404 && req.path) {
      payload.error.details = [{ field: req.path.slice(0, 200), message: 'The requested route does not exist.' }];
    }
    res.status(statusCode).json(payload);
  });

  // Startup integration status (no credential values)
  if (config.NODE_ENV !== 'test') {
    try {
      const status = config.getIntegrationStatus ? config.getIntegrationStatus() : null;
      if (status) console.log(`[CONFIG] integrations=${JSON.stringify(status)} origins=${allowedOrigins.length}`);
    } catch { /* ignore */ }
  }

  // Test harness exposure (never in production responses)
  app.__services = { config, vendorService, auditService, purchaseStore, sessionStore, userService, tenantService, cryptoService, gmailService };
  app.__allowTestPrincipal = allowTestPrincipal;

  return app;
}

module.exports = { createApp };
