'use strict';

const crypto = require('node:crypto');
const { createOAuthTransactionStore } = require('../services/oauthTransaction.service');
const { createCsrfMiddleware } = require('../middleware/csrf');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('../services/password.service');

/**
 * Google OpenID Connect authentication routes (§4).
 * - Authorization-code flow with state, nonce, PKCE.
 * - Transaction state stored server-side with short expiry + transaction cookie.
 * - Mongo-backed transaction store when available (Render restarts/multi-instance).
 * - Exact allowlisted callback URI from config (never derived from Host).
 * - Code exchange + ID-token validation via openid-client v6 when enabled.
 * - Google `sub` is the stable identity key; email must be verified.
 * - Session rotation after login; allowlisted frontend redirects only.
 * - No fake-auth fallback; disabled integration fails closed.
 * - Idempotent first-login workspace creation.
 */

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

function createTransactionStore({ ttlMs = 10 * 60 * 1000 } = {}) {
  const map = new Map();
  function create({ state, nonce, codeVerifier }) {
    const transactionId = crypto.randomUUID();
    map.set(transactionId, { state, nonce, codeVerifier, createdAt: Date.now() });
    return transactionId;
  }
  function consume(transactionId, state) {
    const rec = map.get(transactionId);
    if (!rec) return null;
    map.delete(transactionId);
    if (Date.now() - rec.createdAt > ttlMs) return null;
    if (!state || state !== rec.state) return null;
    return rec;
  }
  function size() { return map.size; }
  // Periodic cleanup best-effort
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of map.entries()) {
      if (now - v.createdAt > ttlMs) map.delete(k);
    }
  }, 60 * 1000).unref?.();
  return { create, consume, size };
}

function buildGoogleAuthUrl({ config, state, nonce, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_OIDC_CLIENT_ID,
    redirect_uri: config.GOOGLE_OIDC_REDIRECT_URI,
    response_type: 'code',
    scope: config.GOOGLE_OIDC_SCOPES,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function frontendRedirect(config, path) {
  // Allowlisted frontend destinations only — no arbitrary return URLs.
  const base = String(config.FRONTEND_BASE_URL || '').replace(/\/$/, '');
  const safePath = String(path || '/app/dashboard');
  if (!safePath.startsWith('/')) throw new Error('Unsafe redirect path.');
  if (safePath.includes('//') || safePath.toLowerCase().startsWith('/javascript:')) {
    throw new Error('Unsafe redirect path.');
  }
  return `${base}${safePath}`;
}

function createAuthRoutes({ config, userService, sessionStore, auditService, tenantService, oidcExchange = null, oauthTransactionStore = null } = {}) {
  const express = require('express');
  const router = express.Router();
  const transactions = oauthTransactionStore || createOAuthTransactionStore();
  const { csrfProtection } = createCsrfMiddleware({ sessionStore, config });

  function transactionCookieHeader(transactionId) {
    const parts = [`mandate.oauth_tx=${encodeURIComponent(transactionId)}`, 'Path=/api/auth/google', 'HttpOnly', 'Max-Age=600'];
    if (config.SESSION_COOKIE_SECURE) parts.push('Secure');
    if (config.SESSION_COOKIE_DOMAIN) parts.push(`Domain=${config.SESSION_COOKIE_DOMAIN}`);
    parts.push('SameSite=Lax');
    return parts.join('; ');
  }

  function clearTransactionCookieHeader() {
    const parts = ['mandate.oauth_tx=', 'Path=/api/auth/google', 'HttpOnly', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
    if (config.SESSION_COOKIE_SECURE) parts.push('Secure');
    if (config.SESSION_COOKIE_DOMAIN) parts.push(`Domain=${config.SESSION_COOKIE_DOMAIN}`);
    parts.push('SameSite=Lax');
    return parts.join('; ');
  }

  // Structured failure logs contain only an allowlisted reason, request ID, and
  // error metadata. Never log query strings, codes, state, cookies, tokens, or PII.
  function logAuthFailure(req, reason, err) {
    // Classify the innermost OAuth error without logging raw provider messages.
    const nestedCauseText = [err?.cause?.message, err?.cause?.cause?.message]
      .filter((value) => typeof value === 'string').join(' ').toLowerCase();
    const causeClass = /nonce/.test(nestedCauseText) ? 'nonce_validation'
      : /state/.test(nestedCauseText) ? 'state_validation'
        : /id.?token|identity token/.test(nestedCauseText) ? 'id_token_validation'
          : /audience|\\baud\\b/.test(nestedCauseText) ? 'audience_validation'
            : /issuer|\\biss\\b/.test(nestedCauseText) ? 'issuer_validation'
              : /redirect.?uri/.test(nestedCauseText) ? 'redirect_uri'
                : /verifier|pkce|code challenge/.test(nestedCauseText) ? 'pkce_validation'
                  : /json|content.?type|parse|response body/.test(nestedCauseText) ? 'malformed_provider_response'
                    : nestedCauseText ? 'oauth_response_processing' : 'no_nested_cause';
    const entry = {
      event: 'oidc_callback_failed',
      causeClass,
      reason: String(reason || 'unknown'),
      requestId: req.requestId || null,
      errorCode: err && (typeof err.code === 'string' || typeof err.code === 'number') ? err.code : null,
      errorName: err && typeof err.name === 'string' ? err.name : null,
      statusCode: err && Number.isInteger(err.statusCode) ? err.statusCode : null,
      // Preserve only safe, allowlisted metadata from the underlying OIDC failure.
      oidcStage: err && typeof err.oidcStage === 'string' ? err.oidcStage : null,
      providerCode: err && (typeof err.providerCode === 'string' || typeof err.providerCode === 'number') ? err.providerCode : null,
      providerErrorName: err && typeof err.providerErrorName === 'string' ? err.providerErrorName : null,
      providerError: err && typeof err.error === 'string' ? err.error.slice(0, 100) : null,
      providerStatus: err && Number.isInteger(err.response?.status) ? err.response.status : null,
      causeCode: err && typeof err.cause?.code === 'string' ? err.cause.code : null,
      causeName: err && typeof err.cause?.name === 'string' ? err.cause.name : null,
      nestedCauseCode: err && typeof err.cause?.cause?.code === 'string' ? err.cause.cause.code : null,
      nestedCauseName: err && typeof err.cause?.cause?.name === 'string' ? err.cause.cause.name : null,
      nestedCauseResponseStatus: err && Number.isInteger(err.cause?.cause?.response?.status) ? err.cause.cause.response.status : null,
      oauthResponseStatus: err && Number.isInteger(err.cause?.response?.status) ? err.cause.response.status : null,
      oauthResponseContentType: err && typeof err.cause?.response?.headers?.get === 'function'
        ? String(err.cause.response.headers.get('content-type') || '').slice(0, 80) : null,
    };
    console.error(`[AUTH] ${JSON.stringify(entry)}`);
  }

  async function consumeOidcTransaction({ transactionId, state }) {
    if (typeof transactions.consumeWithReason === 'function') {
      return transactions.consumeWithReason({ transactionId, state, kind: 'oidc' });
    }
    const record = await transactions.consume({ transactionId, state, kind: 'oidc' });
    return { record, reason: record ? null : 'invalid_or_expired' };
  }

  function parseTransactionCookie(req) {
    const header = req.get('Cookie') || '';
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      if (part.slice(0, idx).trim() === 'mandate.oauth_tx') return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
  }

  async function safeAudit(eventType, metadata = {}) {
    try {
      await auditService.recordEvent({ tenantId: null, eventType, metadata });
    } catch { /* audit best-effort; never block auth */ }
  }

  function publicUser(user) {
    return {
      userId: user.userId,
      email: user.email,
      emailVerified: Boolean(user.emailVerified),
      displayName: user.displayName || '',
    };
  }

  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isValidEmail(value) {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function cleanText(value, max = 120) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function authError(message, statusCode, code) {
    const err = new Error(message);
    err.statusCode = statusCode;
    err.code = code;
    return err;
  }

  async function establishSession(res, user, statusCode = 200) {
    const session = await sessionStore.create(user.userId);
    res.set('Set-Cookie', sessionStore.buildCookieHeader(session.sessionId));
    res.set('Cache-Control', 'no-store');
    return res.status(statusCode).json({
      success: true,
      data: {
        authenticated: true,
        user: publicUser(user),
        csrfToken: session.csrfToken,
      },
    });
  }

  // Local email/password sign-up. Creates an isolated personal workspace using
  // only the new server-side user ID; client-supplied tenant IDs are ignored.
  router.post('/auth/register', async (req, res, next) => {
    let failedOperation = 'validate_registration';
    try {
      const email = normalizeEmail(req.body?.email);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!isValidEmail(email)) {
        throw authError('Enter a valid email address.', 400, 'INVALID_EMAIL');
      }
      if (password.length < 12 || password.length > 128) {
        throw authError('Use a password between 12 and 128 characters.', 400, 'INVALID_PASSWORD');
      }
      const displayName = cleanText(req.body?.displayName) || email.split('@')[0];
      failedOperation = 'hash_password';
      const passwordHash = await hashPassword(password);
      let user;
      try {
        failedOperation = 'create_local_user';
        user = await userService.createLocalUser({ email, passwordHash, displayName });
      } catch (err) {
        if (err.code === 'EMAIL_IN_USE') {
          return res.status(409).json({
            success: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
      failedOperation = 'create_workspace';
      await maybeCreateFirstWorkspace({
        user,
        tenantService,
        businessName: cleanText(req.body?.businessName) || undefined,
      });
      failedOperation = 'create_session';
      await safeAudit('SIGN_UP_SUCCEEDED', { actorId: user.userId });
      return await establishSession(res, user, 201);
    } catch (err) {
      if (!err || err.code !== 'EMAIL_IN_USE') {
        console.error('[AUTH] registration_failed', JSON.stringify({
          requestId: req.requestId || null,
          operation: failedOperation,
          errorName: err && typeof err.name === 'string' ? err.name : null,
          errorCode: err && (typeof err.code === 'string' || typeof err.code === 'number') ? err.code : null,
          mongoCode: err && Number.isInteger(err.code) ? err.code : null,
          keyPattern: err && err.keyPattern && typeof err.keyPattern === 'object' ? err.keyPattern : null,
        }));
      }
      next(err);
    }
  });

  // Local email/password sign-in. Missing users still perform a scrypt check so
  // timing does not reveal whether an email is registered. Workspace access is
  // always resolved from the authenticated user, never from the request body.
  router.post('/auth/login', async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!email || password.length > 128) {
        await verifyPassword(password, DUMMY_HASH);
        throw authError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
      }
      const user = await userService.findByEmail(email);
      const hasLocalPassword = Boolean(user && typeof user.passwordHash === 'string');
      const valid = await verifyPassword(password, hasLocalPassword ? user.passwordHash : DUMMY_HASH);
      if (!user || !hasLocalPassword || !valid) {
        await safeAudit('SIGN_IN_FAILED', { reason: 'invalid_credentials' });
        throw authError('Email or password is incorrect.', 401, 'INVALID_CREDENTIALS');
      }
      if (user.status !== 'active') {
        throw authError('This account is disabled.', 403, 'USER_DISABLED');
      }
      const updated = await userService.updateLogin(user, {});
      await maybeCreateFirstWorkspace({ user: updated, tenantService });
      await safeAudit('SIGN_IN_SUCCEEDED', { actorId: updated.userId });
      return await establishSession(res, updated);
    } catch (err) { next(err); }
  });

  // Start: GET /api/auth/google
  router.get('/auth/google', async (req, res, next) => {
    try {
      if (!config.GOOGLE_OIDC_ENABLED) {
        return res.status(501).json({
          success: false,
          error: { code: 'OIDC_NOT_CONFIGURED', message: 'Google sign-in is not configured. No demo authentication is available.' },
        });
      }
      const state = base64url(crypto.randomBytes(32));
      const nonce = base64url(crypto.randomBytes(32));
      const codeVerifier = base64url(crypto.randomBytes(64));
      const codeChallenge = sha256Base64Url(codeVerifier);
      const transactionId = await transactions.create({ kind: 'oidc', state, nonce, codeVerifier });
      await safeAudit('SIGN_IN_STARTED', {});
      res.set('Set-Cookie', transactionCookieHeader(transactionId));
      // Do not log callback query strings or codes.
      const url = buildGoogleAuthUrl({ config, state, nonce, codeChallenge });
      return res.redirect(302, url);
    } catch (err) { next(err); }
  });

  // Callback: GET /api/auth/google/callback?code=...&state=...
  router.get('/auth/google/callback', async (req, res, next) => {
    let failureReason = 'callback_failed';
    try {
      if (!config.GOOGLE_OIDC_ENABLED) {
        return res.status(501).json({
          success: false,
          error: { code: 'OIDC_NOT_CONFIGURED', message: 'Google sign-in is not configured.' },
        });
      }
      const { code, state, error: providerError } = req.query || {};
      const transactionId = parseTransactionCookie(req);
      // Clear transaction cookie immediately (single-use). Use append so the
      // session cookie set later on success does not replace this header.
      res.append('Set-Cookie', clearTransactionCookieHeader());

      if (providerError) {
        failureReason = 'provider_error';
        logAuthFailure(req, failureReason, null);
        await safeAudit('SIGN_IN_FAILED', { reason: failureReason });
        return res.redirect(302, frontendRedirect(config, '/login?error=cancelled'));
      }
      if (!transactionId) {
        failureReason = 'transaction_cookie_missing';
      } else if (!code || typeof code !== 'string') {
        failureReason = 'authorization_code_missing';
      } else if (!state || typeof state !== 'string') {
        failureReason = 'state_missing';
      }
      if (failureReason !== 'callback_failed') {
        const err = new Error('Invalid OAuth transaction. Please try signing in again.');
        err.statusCode = 400;
        err.code = 'OAUTH_TRANSACTION_INVALID';
        throw err;
      }
      const { record: tx, reason: consumeReason } = await consumeOidcTransaction({ transactionId, state });
      if (!tx) {
        failureReason = `transaction_${consumeReason || 'invalid'}`;
        const err = new Error('OAuth transaction has expired or was already used. Please try again.');
        err.statusCode = 400;
        err.code = 'OAUTH_TRANSACTION_INVALID';
        throw err;
      }

      // Exchange code server-side only + validate ID token via trusted library.
      // The same configured redirect URI is used for authorization and exchange.
      failureReason = 'token_exchange_failed';
      let claims;
      if (oidcExchange) {
        claims = await oidcExchange({ code, codeVerifier: tx.codeVerifier, nonce: tx.nonce, state });
      } else {
        claims = await exchangeWithGoogle({ config, code, codeVerifier: tx.codeVerifier, nonce: tx.nonce, state });
      }

      failureReason = 'invalid_claims';
      if (!claims || !claims.sub) {
        const err = new Error('Sign-in failed: invalid identity.');
        err.statusCode = 401;
        err.code = 'OIDC_VALIDATION_FAILED';
        throw err;
      }
      failureReason = 'email_not_verified';
      if (!claims.email || !claims.email_verified) {
        const err = new Error('A verified Google email is required to sign in.');
        err.statusCode = 401;
        err.code = 'EMAIL_NOT_VERIFIED';
        throw err;
      }

      failureReason = 'user_upsert_failed';
      const user = await userService.findOrCreateFromOidc({
        googleSubject: claims.sub,
        email: String(claims.email).toLowerCase(),
        emailVerified: true,
        displayName: claims.name || '',
      });

      // Rotate application session after successful login
      failureReason = 'session_creation_failed';
      const session = await sessionStore.create(user.userId);
      res.append('Set-Cookie', sessionStore.buildCookieHeader(session.sessionId));
      // Auto-create workspace for new users on first Google sign-in
      failureReason = 'workspace_bootstrap_failed';
      await maybeCreateFirstWorkspace({ user, tenantService });
      // CSRF token for SPA: expose via non-HttpOnly readable endpoint (/api/auth/session), not cookie value.
      await safeAudit('SIGN_IN_SUCCEEDED', { actorId: user.userId });
      failureReason = 'redirect_failed';
      return res.redirect(302, frontendRedirect(config, '/app/dashboard?auth=success'));
    } catch (err) {
      // Preserve the original library error metadata for server logs before
      // mapping it to a generic public error. Never expose provider payloads,
      // authorization codes, tokens, secrets, or raw error messages.
      if (!err.statusCode) {
        err.oidcStage = err.oidcStage || failureReason;
        err.providerCode = typeof err.code === 'string' || typeof err.code === 'number' ? err.code : null;
        err.providerErrorName = typeof err.name === 'string' ? err.name : null;
        err.statusCode = 502;
        err.code = 'OIDC_PROVIDER_ERROR';
        err.message = 'Sign-in failed due to a provider error. Please try again.';
      }
      logAuthFailure(req, failureReason, err);
      await safeAudit('SIGN_IN_FAILED', { reason: failureReason });
      // For callback, redirect to login with generic error unless API request expects JSON
      const acceptsJson = (req.get('Accept') || '').includes('application/json');
      if (!acceptsJson && err.statusCode !== 500) {
        try {
          return res.redirect(302, frontendRedirect(config, '/login?error=auth_failed'));
        } catch { /* fall through to JSON */ }
      }
      next(err);
    }
  });

  // Auto-create workspace for new users on first Google sign-in.
  // Idempotent and deterministic; never duplicates tenants on callback retries.
  async function maybeCreateFirstWorkspace({ user, tenantService: service, businessName } = {}) {
    if (!service || !user || !user.userId) return null;
    const emailLocal = String(user.email || '').split('@')[0];
    const workspaceName = businessName
      || (user.displayName ? `${user.displayName}'s workspace` : `${emailLocal || 'My'} workspace`);
    return service.ensureWorkspaceForUser({
      userId: user.userId,
      businessName: workspaceName,
      businessEmail: user.emailVerified ? user.email : '',
    });
  }

  // Session status: GET /api/auth/session (used by frontend instead of local-storage authority)
  router.get('/auth/session', async (req, res, next) => {
    try {
      const cookieName = config.SESSION_COOKIE_NAME;
      const header = req.get('Cookie') || '';
      let sessionId = null;
      for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx !== -1 && part.slice(0, idx).trim() === cookieName) sessionId = decodeURIComponent(part.slice(idx + 1).trim());
      }
      if (!sessionId) return res.json({ success: true, data: { authenticated: false } });
      const session = await sessionStore.get(sessionId);
      if (!session) return res.json({ success: true, data: { authenticated: false } });
      const user = await userService.findById(session.userId);
      if (!user || user.status !== 'active') return res.json({ success: true, data: { authenticated: false } });
      return res.json({
        success: true,
        data: {
          authenticated: true,
          user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified, displayName: user.displayName },
          csrfToken: session.csrfToken,
        },
      });
    } catch (err) { next(err); }
  });

  // CSRF token helper: GET /api/auth/csrf (requires session; returns token for SPA header)
  router.get('/auth/csrf', async (req, res, next) => {
    try {
      const cookieName = config.SESSION_COOKIE_NAME;
      const header = req.get('Cookie') || '';
      let sessionId = null;
      for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx !== -1 && part.slice(0, idx).trim() === cookieName) sessionId = decodeURIComponent(part.slice(idx + 1).trim());
      }
      if (!sessionId) {
        const err = new Error('Authentication required.');
        err.statusCode = 401;
        err.code = 'UNAUTHENTICATED';
        throw err;
      }
      const session = await sessionStore.get(sessionId);
      if (!session) {
        const err = new Error('Session has expired.');
        err.statusCode = 401;
        err.code = 'SESSION_INVALID';
        throw err;
      }
      return res.json({ success: true, data: { csrfToken: session.csrfToken } });
    } catch (err) { next(err); }
  });

  // Logout: POST /api/auth/logout (CSRF-protected for cookie sessions)
  router.post('/auth/logout', csrfProtection, async (req, res, next) => {
    try {
      const cookieName = config.SESSION_COOKIE_NAME;
      const header = req.get('Cookie') || '';
      let sessionId = null;
      for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx !== -1 && part.slice(0, idx).trim() === cookieName) sessionId = decodeURIComponent(part.slice(idx + 1).trim());
      }
      let actorId = null;
      if (sessionId) {
        const sess = await sessionStore.get(sessionId);
        actorId = sess ? sess.userId : null;
        await sessionStore.destroy(sessionId);
      }
      res.set('Set-Cookie', sessionStore.clearCookieHeader());
      try {
        await auditService.recordEvent({ tenantId: null, eventType: 'SIGN_OUT', actorId, metadata: {} });
      } catch { /* ignore */ }
      return res.json({ success: true, data: { signedOut: true } });
    } catch (err) { next(err); }
  });

  // Expose transaction store size for tests (no secrets)
  router.__transactions = transactions;

  return router;
}

// Use openid-client v6 for discovery + code exchange + ID-token validation.
// Never hand-roll JWT verification.
let cachedProvider = null;
async function exchangeWithGoogle({ config, code, codeVerifier, nonce, state }) {
  let stage = 'provider_discovery';
  try {
    const key = `${config.GOOGLE_OIDC_ISSUER}|${config.GOOGLE_OIDC_CLIENT_ID}`;
    if (!cachedProvider || cachedProvider.key !== key) {
      const { discovery, ClientSecretPost } = await import('openid-client');
      const secret = config.getSecrets ? config.getSecrets().GOOGLE_OIDC_CLIENT_SECRET : '';
      const value = await discovery(
        new URL(config.GOOGLE_OIDC_ISSUER),
        config.GOOGLE_OIDC_CLIENT_ID,
        { client_secret: secret, redirect_uris: [config.GOOGLE_OIDC_REDIRECT_URI], response_types: ['code'] },
        ClientSecretPost(secret)
      );
      cachedProvider = { key, value };
    }

    stage = 'authorization_code_exchange';
    const { authorizationCodeGrant } = await import('openid-client');
    const currentUrl = new URL(config.GOOGLE_OIDC_REDIRECT_URI);
    currentUrl.searchParams.set('code', code);
    currentUrl.searchParams.set('state', state);
    const tokenSet = await authorizationCodeGrant(cachedProvider.value, currentUrl, {
      expectedState: state,
      expectedNonce: nonce,
      pkceCodeVerifier: codeVerifier,
      idTokenExpected: true,
    });

    stage = 'id_token_claims';
    const claims = tokenSet.claims();
    if (!claims) throw new Error('Missing ID token claims.');
    // Library validates signature/issuer/audience/expiry/nonce; keep defensive checks.
    if (claims.iss !== config.GOOGLE_OIDC_ISSUER && claims.iss !== 'https://accounts.google.com') {
      throw new Error('Invalid issuer.');
    }
    if (claims.aud !== config.GOOGLE_OIDC_CLIENT_ID) throw new Error('Invalid audience.');
    if (claims.nonce !== nonce) throw new Error('Invalid nonce.');
    return {
      sub: claims.sub,
      email: claims.email,
      email_verified: claims.email_verified === true,
      name: claims.name,
    };
  } catch (err) {
    // Attach only stage and safe error metadata; callback logger never emits raw
    // messages, response bodies, credentials, codes, or tokens.
    if (err && typeof err === 'object') {
      err.oidcStage = stage;
      err.providerCode = typeof err.code === 'string' || typeof err.code === 'number' ? err.code : null;
      err.providerErrorName = typeof err.name === 'string' ? err.name : null;
    }
    throw err;
  }
}

module.exports = { createAuthRoutes, createTransactionStore, frontendRedirect };