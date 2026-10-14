'use strict';

/**
 * Gmail mailbox OAuth connection scaffold (§5.2).
 * - Separate from sign-in; bound to tenantId + connectedByUserId + google sub.
 * - Refresh tokens are stored encrypted; never exposed via APIs.
 * - Disabled until GOOGLE_GMAIL_ENABLED with credentials — fails closed.
 */
function createGmailService({ collection = null, cryptoService, config }) {
  const memory = new Map(); // tenantId -> connection

  function clone(conn) {
    if (!conn) return null;
    const copy = JSON.parse(JSON.stringify(conn));
    // Never expose encrypted token material outside the service
    delete copy.encryptedRefreshToken;
    return copy;
  }

  function isEnabled() {
    return Boolean(config && config.GOOGLE_GMAIL_ENABLED);
  }

  function requireEnabled() {
    if (!isEnabled()) {
      const err = new Error('Gmail mailbox integration is not configured. Connect is disabled.');
      err.statusCode = 501;
      err.code = 'GMAIL_NOT_CONFIGURED';
      throw err;
    }
  }

  async function getConnection(tenantId) {
    if (!tenantId) throw new Error('tenantId is required.');
    if (collection) {
      const doc = await collection.findOne({ tenantId });
      return clone(doc && (({ _id, ...rest }) => rest)(doc));
    }
    return clone(memory.get(tenantId) || null);
  }

  // Internal: fetch raw record including encrypted material (service/worker only)
  async function getConnectionInternal(tenantId) {
    if (collection) {
      const doc = await collection.findOne({ tenantId });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return JSON.parse(JSON.stringify(rest));
    }
    const rec = memory.get(tenantId);
    return rec ? JSON.parse(JSON.stringify(rec)) : null;
  }

  async function saveConnection({ tenantId, connectedByUserId, googleSubject, mailboxEmail, scopes, refreshToken }) {
    requireEnabled();
    if (!tenantId) throw new Error('tenantId is required.');
    if (!connectedByUserId) throw new Error('connectedByUserId is required.');
    if (!mailboxEmail) throw new Error('mailboxEmail is required.');
    if (!cryptoService || !cryptoService.isAvailable()) {
      throw new Error('Token encryption must be configured before storing mailbox credentials.');
    }
    const now = new Date().toISOString();
    const encryptedRefreshToken = refreshToken ? cryptoService.encrypt(refreshToken) : null;
    const record = {
      tenantId,
      connectedByUserId,
      googleSubject: googleSubject || null,
      mailboxEmail: String(mailboxEmail).trim().toLowerCase(),
      scopes: Array.isArray(scopes) ? [...scopes] : [],
      status: 'connected',
      encryptedRefreshToken,
      connectedAt: now,
      updatedAt: now,
    };
    if (collection) {
      await collection.updateOne({ tenantId }, { $set: record, $setOnInsert: { createdAt: now } }, { upsert: true });
    } else {
      const existing = memory.get(tenantId);
      memory.set(tenantId, { ...record, createdAt: existing?.createdAt || now });
    }
    return clone(record);
  }

  async function setStatus(tenantId, status) {
    if (!['connected', 'revoked', 'disconnected', 'error'].includes(status)) throw new Error('Invalid Gmail status.');
    const now = new Date().toISOString();
    if (collection) {
      await collection.updateOne({ tenantId }, { $set: { status, updatedAt: now } });
    } else {
      const existing = memory.get(tenantId);
      if (!existing) return null;
      memory.set(tenantId, { ...existing, status, updatedAt: now });
    }
    return getConnection(tenantId);
  }

  async function disconnect(tenantId) {
    const now = new Date().toISOString();
    if (collection) {
      // Per retention policy: revoke + delete credential material
      await collection.updateOne({ tenantId }, { $set: { status: 'disconnected', encryptedRefreshToken: null, updatedAt: now } });
    } else {
      const existing = memory.get(tenantId);
      if (!existing) return null;
      memory.set(tenantId, { ...existing, status: 'disconnected', encryptedRefreshToken: null, updatedAt: now });
    }
    return getConnection(tenantId);
  }

  async function ensureIndexes() {
    if (!collection) return;
    try {
      await collection.createIndex({ tenantId: 1 }, { unique: true });
    } catch { /* best-effort */ }
  }

  return { isEnabled, requireEnabled, getConnection, getConnectionInternal, saveConnection, setStatus, disconnect, ensureIndexes };
}

module.exports = { createGmailService };
