'use strict';

const crypto = require('node:crypto');

/**
 * Durable, single-use OAuth transaction store.
 *
 * OAuth/OIDC state, nonce, PKCE verifier, and (for Gmail) tenant/user bindings
 * must survive more than one Render instance and process restart. When a Mongo
 * collection is available the transaction is persisted with a TTL index; the
 * in-memory Map is only a development/test fallback.
 *
 * Every record is consumed with `deleteOne` before validation, so a replayed
 * transaction ID can never be accepted twice even under concurrent callbacks.
 */
function createOAuthTransactionStore({ collection = null, ttlMs = 10 * 60 * 1000 } = {}) {
  const memory = new Map();

  function now() { return Date.now(); }

  function clone(record) {
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  async function create({ kind, state, nonce, codeVerifier, tenantId = null, userId = null } = {}) {
    if (!kind || typeof kind !== 'string') throw new Error('OAuth transaction kind is required.');
    if (!state || typeof state !== 'string') throw new Error('OAuth transaction state is required.');
    if (!codeVerifier || typeof codeVerifier !== 'string') throw new Error('OAuth transaction codeVerifier is required.');
    const createdAt = new Date().toISOString();
    const record = {
      transactionId: crypto.randomUUID(),
      kind,
      state,
      nonce: nonce || null,
      codeVerifier,
      tenantId,
      userId,
      createdAt,
      expiresAt: new Date(now() + ttlMs).toISOString(),
    };
    if (collection) await collection.insertOne({ ...record });
    else memory.set(record.transactionId, { ...record });
    return record.transactionId;
  }

  async function consume({ transactionId, state, kind } = {}) {
    if (!transactionId || typeof transactionId !== 'string') return null;
    let record = null;
    if (collection) {
      record = await collection.findOne({ transactionId });
      if (record) {
        // Delete first: concurrent/replayed callbacks see no record.
        await collection.deleteOne({ transactionId });
        const { _id, ...rest } = record;
        record = rest;
      }
    } else {
      record = memory.get(transactionId) || null;
      memory.delete(transactionId);
    }
    if (!record) return null;
    if (kind && record.kind !== kind) return null;
    if (!state || typeof state !== 'string' || state !== record.state) return null;
    if (!record.expiresAt || Date.parse(record.expiresAt) < now()) return null;
    return clone(record);
  }

  function size() { return memory.size; }

  async function ensureIndexes() {
    if (!collection) return;
    try { await collection.createIndex({ transactionId: 1 }, { unique: true }); } catch { /* best-effort */ }
    try { await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); } catch { /* TTL best-effort */ }
  }

  return { create, consume, size, ensureIndexes };
}

module.exports = { createOAuthTransactionStore };
