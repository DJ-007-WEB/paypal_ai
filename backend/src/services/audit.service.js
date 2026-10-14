'use strict';

const { randomUUID } = require('node:crypto');

const SENSITIVE_KEY_FRAGMENTS = ['token', 'secret', 'password', 'authorization', 'cookie', 'key'];

function safeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') return {};
  const copy = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEY_FRAGMENTS.some((frag) => lower.includes(frag))) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      // Bound string length to avoid unbounded log growth
      copy[key] = typeof value === 'string' && value.length > 2000 ? value.slice(0, 2000) : value;
    } else if (Array.isArray(value)) {
      copy[key] = value.slice(0, 100).map((entry) => entry && typeof entry === 'object' ? safeMetadata(entry) : entry);
    } else if (value && typeof value === 'object') copy[key] = safeMetadata(value);
  }
  return copy;
}

function requireTenantForTenantOwned(eventType, tenantId) {
  // Auth/session events may be global; business-data events must carry tenantId.
  const GLOBAL_EVENTS = new Set([
    'SIGN_IN_STARTED', 'SIGN_IN_SUCCEEDED', 'SIGN_IN_FAILED', 'SIGN_OUT',
    'SESSION_EXPIRED', 'OAUTH_TRANSACTION_INVALID',
  ]);
  if (GLOBAL_EVENTS.has(eventType)) return;
  if (!tenantId) {
    const err = new Error('Tenant context is required for audit events.');
    err.statusCode = 400;
    err.code = 'TENANT_CONTEXT_REQUIRED';
    throw err;
  }
}

function createAuditService({ collection } = {}) {
  const events = [];
  return {
    async recordEvent({ tenantId = null, eventType, requestId = null, purchaseId = null, actorId = null, metadata = {} }) {
      if (!eventType) throw new Error('eventType is required.');
      requireTenantForTenantOwned(eventType, tenantId);
      const event = {
        eventId: randomUUID(),
        tenantId,
        eventType,
        timestamp: new Date().toISOString(),
        requestId,
        purchaseId,
        actorId,
        metadata: safeMetadata(metadata),
      };
      if (collection) await collection.insertOne(event);
      else events.push(event);
      return { ...event, metadata: { ...event.metadata } };
    },
    async listEvents(first) {
      // New: listEvents({ tenantId }) — tenant required. Legacy listEvents() fails closed.
      const tenantId = first && typeof first === 'object' ? first.tenantId : undefined;
      if (!tenantId) {
        throw new Error('auditService.listEvents requires { tenantId }.');
      }
      const all = collection ? await collection.find({ tenantId }).sort({ timestamp: -1 }).toArray() : events.filter((e) => e.tenantId === tenantId);
      return all.map((event) => ({ ...event, metadata: { ...event.metadata } }));
    },
    async getEventsByRequestId(first, second) {
      let tenantId;
      let requestId;
      if (first && typeof first === 'object' && ('tenantId' in first || 'requestId' in first)) {
        tenantId = first.tenantId;
        requestId = first.requestId;
      } else {
        throw new Error('auditService.getEventsByRequestId requires { tenantId, requestId }.');
      }
      if (!tenantId) throw new Error('tenantId is required.');
      if (!requestId) return [];
      const found = collection
        ? await collection.find({ tenantId, requestId }).sort({ timestamp: 1 }).toArray()
        : events.filter((event) => event.tenantId === tenantId && event.requestId === requestId);
      return found.map((event) => ({ ...event, metadata: { ...event.metadata } }));
    },
    async getEventsForPurchase(first, second) {
      let tenantId;
      let purchaseId;
      if (first && typeof first === 'object' && ('tenantId' in first || 'purchaseId' in first)) {
        tenantId = first.tenantId;
        purchaseId = first.purchaseId;
      } else {
        throw new Error('auditService.getEventsForPurchase requires { tenantId, purchaseId }.');
      }
      if (!tenantId) throw new Error('tenantId is required.');
      if (!purchaseId) return [];
      const found = collection
        ? await collection.find({ tenantId, purchaseId }).sort({ timestamp: 1 }).toArray()
        : events.filter((event) => event.tenantId === tenantId && event.purchaseId === purchaseId);
      return found.map((event) => ({ ...event, metadata: { ...event.metadata } }));
    },
    async clear(tenantId) {
      // Scoped clear: production code must not wipe all tenants.
      if (collection) {
        if (tenantId) await collection.deleteMany({ tenantId });
        else await collection.deleteMany({});
      } else {
        if (tenantId) {
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].tenantId === tenantId) events.splice(i, 1);
          }
        } else events.length = 0;
      }
    },
  };
}
module.exports = { createAuditService };
