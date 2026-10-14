'use strict';

/**
 * Authentication middleware (§4, §8).
 * - Validates the application session cookie server-side.
 * - Loads the active user; disabled users lose access.
 * - Never trusts client-supplied req.auth, tenantId headers, or local storage.
 * - Test harness: when options.allowTestPrincipal is true AND NODE_ENV=test,
 *   accepts X-Test-User-Id for isolated tests (membership still verified server-side
 *   before any tenant context is granted in authorize.js).
 */

function parseCookies(req, cookieName) {
  const header = req.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out[cookieName] || null;
}

function createAuthenticateMiddleware({ sessionStore, userService, config, allowTestPrincipal = false } = {}) {
  if (!sessionStore || !userService || !config) throw new Error('authenticate middleware requires sessionStore, userService, config.');

  const testMode = config.NODE_ENV === 'test' && allowTestPrincipal === true;

  async function loadPrincipal(req) {
    // Test harness path — identity only, no tenant yet.
    if (testMode) {
      const testUserId = req.get('X-Test-User-Id');
      if (testUserId) {
        const user = await userService.findById(testUserId.trim());
        if (!user) {
          const err = new Error('Authentication required.');
          err.statusCode = 401;
          err.code = 'UNAUTHENTICATED';
          throw err;
        }
        if (user.status !== 'active') {
          const err = new Error('User account is disabled.');
          err.statusCode = 403;
          err.code = 'USER_DISABLED';
          throw err;
        }
        req.session = null;
        req.sessionId = null;
        req.user = user;
        return { user, session: null };
      }
    }

    const sessionId = parseCookies(req, config.SESSION_COOKIE_NAME);
    if (!sessionId) {
      const err = new Error('Authentication required.');
      err.statusCode = 401;
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    const session = await sessionStore.get(sessionId);
    if (!session) {
      const err = new Error('Session has expired or is invalid. Please sign in again.');
      err.statusCode = 401;
      err.code = 'SESSION_INVALID';
      throw err;
    }
    const user = await userService.findById(session.userId);
    if (!user || user.status !== 'active') {
      try { await sessionStore.destroy(sessionId); } catch { /* ignore */ }
      const err = new Error('User account is unavailable.');
      err.statusCode = 401;
      err.code = 'UNAUTHENTICATED';
      throw err;
    }
    // Refresh idle window
    await sessionStore.touch(sessionId);
    req.session = session;
    req.sessionId = session.sessionId;
    req.user = user;
    return { user, session };
  }

  async function requireAuthentication(req, res, next) {
    try {
      await loadPrincipal(req);
      next();
    } catch (err) {
      next(err);
    }
  }

  async function requireActiveUser(req, res, next) {
    try {
      const { user } = await loadPrincipal(req);
      if (!user || user.status !== 'active') {
        const err = new Error('User account is disabled.');
        err.statusCode = 403;
        err.code = 'USER_DISABLED';
        throw err;
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  return { requireAuthentication, requireActiveUser, loadPrincipal, parseCookies };
}

module.exports = { createAuthenticateMiddleware, parseCookies };
