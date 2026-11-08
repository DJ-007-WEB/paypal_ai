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
    /**
     * Webhook lookup: PayPal callbacks contain no tenant context. The order ID is
     * stored at the top level for an indexed, tenant-free lookup; authorization
     * still happens against the record's own tenantId before any write.
     */
    async findByPayPalOrderId(first) {
      const orderId = typeof first === 'string' ? first : first?.orderId;
      if (!orderId) return null;
      if (collection) {
        const entry = await collection.findOne({ paypalOrderId: orderId });
        return entry ? cloneValue(entry) : null;
      }
      for (const value of store.values()) {
        if (value.paypalOrderId === orderId) return cloneValue(value);
      }
      return null;
    },
    /**
     * Atomic payment-state transition. The filter requires the current
     * paymentStatus to be one of expectedStatuses (and, when supplied, the
     * order ID to match), so concurrent captures/webhooks cannot both win.
     */
    async compareAndSetPayment({ tenantId, purchaseId, expectedStatuses = [], expectedOrderId, patch = {}, status } = {}) {
      const tid = requireTenantId(tenantId);
      if (!purchaseId) throw new Error('purchaseId is required.');
      if (!Array.isArray(expectedStatuses) || expectedStatuses.length === 0) throw new Error('expectedStatuses is required.');
      if (!status) throw new Error('status is required.');
      const now = new Date().toISOString();
      const next = { ...cloneValue(patch), paymentStatus: status, updatedAt: now };
      if (collection) {
        const filter = { tenantId: tid, purchaseId, paymentStatus: { $in: expectedStatuses } };
        if (expectedOrderId !== undefined) filter.paypalOrderId = expectedOrderId;
        const result = await collection.updateOne(filter, { $set: next });
        const record = await collection.findOne({ tenantId: tid, purchaseId });
        return { updated: Boolean(result && result.matchedCount > 0), record: record ? cloneValue(record) : null };
      }
      const current = store.get(keyFor(tid, purchaseId));
      if (!current) return { updated: false, record: null };
      if (!expectedStatuses.includes(current.paymentStatus)) return { updated: false, record: cloneValue(current) };
      if (expectedOrderId !== undefined && current.paypalOrderId !== expectedOrderId) return { updated: false, record: cloneValue(current) };
      const merged = { ...current, ...cloneValue(next), tenantId: tid, purchaseId };
      store.set(keyFor(tid, purchaseId), cloneValue(merged));
      return { updated: true, record: cloneValue(merged) };
    },
    /**
     * Atomic approval decision. Expected status defaults to PENDING so a second
     * reviewer cannot overwrite a completed decision; payment must not be
     * COMPLETED (checked by the caller before calling).
     */
    async compareAndSetApproval({ tenantId, purchaseId, expectedStatuses = ['PENDING'], status, patch = {}, expectedPaymentStatuses = null } = {}) {
      const tid = requireTenantId(tenantId);
      if (!purchaseId) throw new Error('purchaseId is required.');
      if (!status) throw new Error('status is required.');
      const now = new Date().toISOString();
      const next = { ...cloneValue(patch), approvalStatus: status, updatedAt: now };
      if (collection) {
        const filter = { tenantId: tid, purchaseId, approvalStatus: { $in: expectedStatuses } };
        if (Array.isArray(expectedPaymentStatuses) && expectedPaymentStatuses.length > 0) {
          filter.paymentStatus = { $in: expectedPaymentStatuses };
        }
        const result = await collection.updateOne(filter, { $set: next });
        const record = await collection.findOne({ tenantId: tid, purchaseId });
        return { updated: Boolean(result && result.matchedCount > 0), record: record ? cloneValue(record) : null };
      }
      const current = store.get(keyFor(tid, purchaseId));
      if (!current) return { updated: false, record: null };
      if (!expectedStatuses.includes(current.approvalStatus)) return { updated: false, record: cloneValue(current) };
      if (Array.isArray(expectedPaymentStatuses) && !expectedPaymentStatuses.includes(current.paymentStatus)) {
        return { updated: false, record: cloneValue(current) };
      }
      const merged = { ...current, ...cloneValue(next), tenantId: tid, purchaseId };
      store.set(keyFor(tid, purchaseId), cloneValue(merged));
      return { updated: true, record: cloneValue(merged) };
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
