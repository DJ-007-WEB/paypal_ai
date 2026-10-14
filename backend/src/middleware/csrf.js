'use strict';

/**
 * CSRF defense for cookie-authenticated state-changing requests (§14).
 * - Session carries a csrfToken issued at login.
 * - Client must send X-CSRF-Token matching the session token for POST/PUT/PATCH/DELETE.
 * - Test-harness principals (header-based, no cookie) skip CSRF since they carry no cookie.
 * - Safe methods (GET/HEAD/OPTIONS) are exempt.
 */
function createCsrfMiddleware({ sessionStore, config } = {}) {
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  function csrfProtection(req, res, next) {
    try {
      if (SAFE_METHODS.has(req.method)) return next();
      // No cookie session (e.g., test-harness header principal) → no cookie-CSRF surface
      if (!req.session || !req.session.csrfToken) {
        // If a session cookie was presented, session would have been loaded by auth.
        // Without a cookie session, allow through (auth still required downstream).
        return next();
      }
      const supplied = req.get('X-CSRF-Token') || req.get('X-XSRF-Token');
      if (!supplied || supplied !== req.session.csrfToken) {
        const err = new Error('CSRF validation failed. Refresh and retry with a valid CSRF token.');
        err.statusCode = 403;
        err.code = 'CSRF_INVALID';
        throw err;
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  return { csrfProtection };
}

module.exports = { createCsrfMiddleware };
