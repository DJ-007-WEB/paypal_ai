'use strict';

const { randomUUID } = require('node:crypto');

function requireTenantId(tenantId) {
  if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
    const err = new Error('Tenant context is required.');
    err.statusCode = 400;
    err.code = 'TENANT_CONTEXT_REQUIRED';
    throw err;
  }
  return tenantId.trim();
}

function cloneValue(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeArgs(first, second, third) {
  // New: { tenantId, purchaseId, updater } / { tenantId, purchaseId } / { tenantId, filters }
  // Legacy: (purchaseId, updater) / (purchaseId) / () — fails closed with clear error.
  if (first && typeof first === 'object' && !Array.isArray(first) && ('tenantId' in first || 'purchaseId' in first || 'filters' in first)) {
    return first;
  }
  return null;
}

function createPurchaseStore({ collection } = {}) {
  const store = new Map(); // `${tenantId}:${purchaseId}` -> record
  const keyFor = (tenantId, purchaseId) => `${tenantId}:${purchaseId}`;

  return {
    async create(record) {
      const tid = requireTenantId(record && record.tenantId);
      if (record.tenantId !== tid) throw new Error('Tenant mismatch.');
      const purchaseId = record.purchaseId || `purchase_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const entry = { ...cloneValue(record), tenantId: tid, purchaseId, createdAt: record.createdAt || new Date().toISOString() };
      delete entry._id;
      if (collection) await collection.insertOne(entry);
      else {
        if (store.has(keyFor(tid, purchaseId))) {
          const err = new Error('Purchase already exists.');
          err.code = 11000;
          throw err;
        }
        store.set(keyFor(tid, purchaseId), cloneValue(entry));
      }
      return cloneValue(entry);
    },
    async upsert(first, second) {
      const normalized = normalizeArgs(first);
      let tenantId;
      let purchaseId;
      let updater;
      if (normalized) {
        tenantId = requireTenantId(normalized.tenantId);
        purchaseId = normalized.purchaseId;
        updater = normalized.updater;
      } else {
        // Legacy (purchaseId, updater) without tenant — fail closed
        throw new Error('purchaseStore.upsert requires { tenantId, purchaseId, updater }.');
      }
      if (!purchaseId) throw new Error('purchaseId is required.');
      if (typeof updater !== 'function') throw new Error('updater function is required.');
      const current = collection ? (await collection.findOne({ tenantId, purchaseId })) : store.get(keyFor(tenantId, purchaseId));
      const next = updater(cloneValue(current || { tenantId, purchaseId }));
      if (next.tenantId && next.tenantId !== tenantId) {
        const err = new Error('Purchase tenant cannot be changed.');
        err.statusCode = 403;
        err.code = 'TENANT_MISMATCH';
        throw err;
      }
      const entry = { ...cloneValue(next), tenantId, purchaseId };
      delete entry._id;
      if (collection) {
        await collection.updateOne({ tenantId, purchaseId }, { $set: entry }, { upsert: true });
        const saved = await collection.findOne({ tenantId, purchaseId });
        return cloneValue(saved);
      }
      store.set(keyFor(tenantId, purchaseId), cloneValue(entry));
      return cloneValue(entry);
    },
    async getById(first, second) {
      const normalized = normalizeArgs(first);
      if (normalized) {
        const tenantId = requireTenantId(normalized.tenantId);
        const purchaseId = normalized.purchaseId || second;
        if (!purchaseId) return null;
        const entry = collection ? await collection.findOne({ tenantId, purchaseId }) : store.get(keyFor(tenantId, purchaseId));
        return entry ? cloneValue(entry) : null;
      }
      // Legacy getById(purchaseId) — fail closed
      throw new Error('purchaseStore.getById requires { tenantId, purchaseId }.');
    },
    async list(first) {
      const normalized = (first && typeof first === 'object' && ('tenantId' in first || 'filters' in first)) ? first : null;
      if (!normalized) {
        throw new Error('purchaseStore.list requires { tenantId, filters }.');
      }
      const tenantId = requireTenantId(normalized.tenantId);
      const filters = normalized.filters || {};
      if (collection) {
        const query = { tenantId };
        // Allowlist safe filters only
        if (filters.status) query['decision.status'] = filters.status;
        const entries = await collection.find(query).sort({ createdAt: -1 }).toArray();
        return entries.map(cloneValue);
      }
      const entries = [];
      for (const [key, value] of store.entries()) {
        if (key.startsWith(`${tenantId}:`)) {
          if (filters.status && value.decision?.status !== filters.status) continue;
          entries.push(cloneValue(value));
        }
      }
      entries.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return entries;
    },
    // Test/compat helper: direct lookup without tenant is NOT exposed in production paths.
  };
}
module.exports = { createPurchaseStore };
