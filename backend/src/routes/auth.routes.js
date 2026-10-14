'use strict';

const crypto = require('node:crypto');

/**
 * Google OpenID Connect authentication routes (§4).
 * - Authorization-code flow with state, nonce, PKCE.
 * - Transaction state stored server-side with short expiry + transaction cookie.
 * - Exact allowlisted callback URI from config (never derived from Host).
 * - Code exchange + ID-token validation via openid-client when enabled.
 * - Google `sub` is the stable identity key; email must be verified.
 * - Session rotation after login; allowlisted frontend redirects only.
 * - No fake-auth fallback; disabled integration fails closed.
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

function createAuthRoutes({ config, userService, sessionStore, auditService, oidcExchange = null } = {}) {
  const express = require('express');
  const router = express.Router();
  const transactions = createTransactionStore();

  function transactionCookieHeader(transactionId) {
    const parts = [`mandate.oauth_tx=${encodeURIComponent(transactionId)}`, 'Path=/api/auth/google', 'HttpOnly', 'Max-Age=600'];
    if (config.SESSION_COOKIE_SECURE) parts.push('Secure');
    parts.push('SameSite=Lax');
    return parts.join('; ');
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
      const transactionId = transactions.create({ state, nonce, codeVerifier });
      await safeAudit('SIGN_IN_STARTED', {});
      res.set('Set-Cookie', transactionCookieHeader(transactionId));
      // Do not log callback query strings or codes.
      const url = buildGoogleAuthUrl({ config, state, nonce, codeChallenge });
      return res.redirect(302, url);
    } catch (err) { next(err); }
  });

  // Callback: GET /api/auth/google/callback?code=...&state=...
  router.get('/auth/google/callback', async (req, res, next) => {
    try {
      if (!config.GOOGLE_OIDC_ENABLED) {
        return res.status(501).json({
          success: false,
          error: { code: 'OIDC_NOT_CONFIGURED', message: 'Google sign-in is not configured.' },
        });
      }
      const { code, state, error: providerError, error_description } = req.query || {};
      const transactionId = parseTransactionCookie(req);
      // Clear transaction cookie immediately (single-use)
      res.set('Set-Cookie', 'mandate.oauth_tx=; Path=/api/auth/google; HttpOnly; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');

      if (providerError) {
        await safeAudit('SIGN_IN_FAILED', { reason: 'provider_error' });
        return res.redirect(302, frontendRedirect(config, '/login?error=cancelled'));
      }
      if (!code || typeof code !== 'string' || !state || typeof state !== 'string' || !transactionId) {
        await safeAudit('SIGN_IN_FAILED', { reason: 'invalid_transaction' });
        const err = new Error('Invalid OAuth transaction. Please try signing in again.');
        err.statusCode = 400;
        err.code = 'OAUTH_TRANSACTION_INVALID';
        throw err;
      }
      const tx = transactions.consume(transactionId, state);
      if (!tx) {
        await safeAudit('SIGN_IN_FAILED', { reason: 'expired_or_replayed_transaction' });
        const err = new Error('OAuth transaction has expired or was already used. Please try again.');
        err.statusCode = 400;
        err.code = 'OAUTH_TRANSACTION_INVALID';
        throw err;
      }

      // Exchange code server-side only + validate ID token via trusted library.
      let claims;
      if (oidcExchange) {
        claims = await oidcExchange({ code, codeVerifier: tx.codeVerifier, nonce: tx.nonce, state });
      } else {
        claims = await exchangeWithGoogle({ config, code, codeVerifier: tx.codeVerifier, nonce: tx.nonce, state });
      }

      if (!claims || !claims.sub) {
        await safeAudit('SIGN_IN_FAILED', { reason: 'invalid_claims' });
        const err = new Error('Sign-in failed: invalid identity.');
        err.statusCode = 401;
        err.code = 'OIDC_VALIDATION_FAILED';
        throw err;
      }
      if (!claims.email || !claims.email_verified) {
        await safeAudit('SIGN_IN_FAILED', { reason: 'email_not_verified' });
        const err = new Error('A verified Google email is required to sign in.');
        err.statusCode = 401;
        err.code = 'EMAIL_NOT_VERIFIED';
        throw err;
      }

      const user = await userService.findOrCreateFromOidc({
        googleSubject: claims.sub,
        email: String(claims.email).toLowerCase(),
        emailVerified: true,
        displayName: claims.name || '',
      });

      // Rotate application session after successful login
      const session = await sessionStore.create(user.userId);
      res.set('Set-Cookie', sessionStore.buildCookieHeader(session.sessionId));
      // CSRF token for SPA: expose via non-HttpOnly readable endpoint (/api/auth/session), not cookie value.
      await safeAudit('SIGN_IN_SUCCEEDED', { actorId: user.userId });
      return res.redirect(302, frontendRedirect(config, '/app/dashboard?auth=success'));
    } catch (err) {
      // Never expose provider payloads, codes, or tokens.
      if (!err.statusCode) {
        err.statusCode = 502;
        err.code = 'OIDC_PROVIDER_ERROR';
        err.message = 'Sign-in failed due to a provider error. Please try again.';
      }
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

  // Logout: POST /api/auth/logout
  router.post('/auth/logout', async (req, res, next) => {
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

async function exchangeWithGoogle({ config, code, codeVerifier, nonce, state }) {
  // Use openid-client for discovery + code exchange + ID-token validation.
  // Never hand-roll JWT verification.
  const { Issuer } = require('openid-client');
  const issuer = await Issuer.discover(config.GOOGLE_OIDC_ISSUER);
  const client = new issuer.Client({
    client_id: config.GOOGLE_OIDC_CLIENT_ID,
    client_secret: config.getSecrets ? config.getSecrets().GOOGLE_OIDC_CLIENT_SECRET : process.env.GOOGLE_OIDC_CLIENT_SECRET,
    redirect_uris: [config.GOOGLE_OIDC_REDIRECT_URI],
    response_types: ['code'],
  });
  const tokenSet = await client.callback(
    config.GOOGLE_OIDC_REDIRECT_URI,
    { code, state },
    { nonce, state, code_verifier: codeVerifier }
  );
  const claims = tokenSet.claims();
  // Validate issuer/audience/expiry via library (client.callback already does); double-check:
  if (claims.iss !== config.GOOGLE_OIDC_ISSUER && claims.iss !== 'https://accounts.google.com') {
    throw new Error('Invalid issuer.');
  }
  if (claims.aud !== config.GOOGLE_OIDC_CLIENT_ID) throw new Error('Invalid audience.');
  if (claims.nonce !== nonce) throw new Error('Invalid nonce.');
  return {
    sub: claims.sub,
    email: claims.email,
    email_verified: claims.email_verified,
    name: claims.name,
  };
}

module.exports = { createAuthRoutes, createTransactionStore, frontendRedirect };
