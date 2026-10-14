'use strict';

const crypto = require('node:crypto');

/**
 * Server-side session store (§4.4).
 * - Production should use a shared durable store; in-memory is dev/test only.
 * - Sessions: { sessionId, userId, createdAt, lastSeenAt, absoluteExpiresAt, csrfToken }
 */
function createSessionStore({ collection = null, config, now = () => Date.now() } = {}) {
  if (!config) throw new Error('Session store requires validated config.');
  const memory = new Map();
  const idleMs = config.SESSION_IDLE_TIMEOUT_SECONDS * 1000;
  const absoluteMs = config.SESSION_ABSOLUTE_TIMEOUT_SECONDS * 1000;
  const usingMemory = !collection;

  if (usingMemory && config.isProd) {
    console.warn('[SESSION] WARNING: using in-memory session store in production. Configure a shared durable store.');
  }

  function newCsrfToken() {
    return crypto.randomBytes(32).toString('base64url');
  }

  function newSessionId() {
    return crypto.randomUUID();
  }

  async function create(userId) {
    if (!userId) throw new Error('userId is required to create a session.');
    const t = now();
    const session = {
      sessionId: newSessionId(),
      userId,
      createdAt: new Date(t).toISOString(),
      lastSeenAt: new Date(t).toISOString(),
      absoluteExpiresAt: new Date(t + absoluteMs).toISOString(),
      csrfToken: newCsrfToken(),
    };
    if (collection) {
      await collection.insertOne({ ...session });
    } else {
      memory.set(session.sessionId, { ...session });
    }
    return { ...session };
  }

  async function get(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return null;
    let session = null;
    if (collection) {
      session = await collection.findOne({ sessionId });
    } else {
      session = memory.get(sessionId) || null;
    }
    if (!session) return null;
    const t = now();
    const lastSeen = Date.parse(session.lastSeenAt);
    const absExp = Date.parse(session.absoluteExpiresAt);
    if (Number.isNaN(lastSeen) || Number.isNaN(absExp)) {
      await destroy(sessionId);
      return null;
    }
    if (t - lastSeen > idleMs) {
      await destroy(sessionId);
      return null;
    }
    if (t > absExp) {
      await destroy(sessionId);
      return null;
    }
    return { ...session };
  }

  async function touch(sessionId) {
    const session = await get(sessionId);
    if (!session) return null;
    const t = now();
    const updated = { ...session, lastSeenAt: new Date(t).toISOString() };
    if (collection) {
      await collection.updateOne({ sessionId }, { $set: { lastSeenAt: updated.lastSeenAt } });
    } else {
      memory.set(sessionId, { ...updated });
    }
    return { ...updated };
  }

  async function destroy(sessionId) {
    if (!sessionId) return;
    if (collection) {
      try { await collection.deleteOne({ sessionId }); } catch { /* ignore */ }
    } else {
      memory.delete(sessionId);
    }
  }

  async function rotate(oldSessionId) {
    const existing = await get(oldSessionId);
    if (!existing) return null;
    const created = await create(existing.userId);
    await destroy(oldSessionId);
    return { ...created };
  }

  async function destroyAllForUser(userId) {
    if (collection) {
      try { await collection.deleteMany({ userId }); } catch { /* ignore */ }
    } else {
      for (const [sid, sess] of memory.entries()) {
        if (sess.userId === userId) memory.delete(sid);
      }
    }
  }

  function buildCookieHeader(sessionId, { csrfTokenForTestOnly } = {}) {
    // Returns Set-Cookie value; caller sets header. Never logs secret values.
    const parts = [`${config.SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`, 'Path=/', 'HttpOnly'];
    if (config.SESSION_COOKIE_SECURE) parts.push('Secure');
    const sameSite = String(config.SESSION_COOKIE_SAME_SITE || 'lax');
    parts.push(`SameSite=${sameSite.charAt(0).toUpperCase() + sameSite.slice(1)}`);
    if (config.SESSION_COOKIE_DOMAIN) parts.push(`Domain=${config.SESSION_COOKIE_DOMAIN}`);
    // Bounded lifetimes are enforced server-side; cookie Max-Age mirrors absolute timeout.
    parts.push(`Max-Age=${config.SESSION_ABSOLUTE_TIMEOUT_SECONDS}`);
    return parts.join('; ');
  }

  function clearCookieHeader() {
    const parts = [`${config.SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
    if (config.SESSION_COOKIE_SECURE) parts.push('Secure');
    const sameSite = String(config.SESSION_COOKIE_SAME_SITE || 'lax');
    parts.push(`SameSite=${sameSite.charAt(0).toUpperCase() + sameSite.slice(1)}`);
    if (config.SESSION_COOKIE_DOMAIN) parts.push(`Domain=${config.SESSION_COOKIE_DOMAIN}`);
    return parts.join('; ');
  }

  // Test-only introspection (no secrets leaked beyond sessionId/csrf needed by harness)
  function __memorySize() { return memory.size; }

  return { create, get, touch, destroy, rotate, destroyAllForUser, buildCookieHeader, clearCookieHeader, newCsrfToken, __memorySize, usingMemory };
}

module.exports = { createSessionStore };
