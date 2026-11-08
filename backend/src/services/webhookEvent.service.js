'use strict';

/**
 * Idempotency ledger for verified PayPal webhook events.
 * The event ID is unique; repeated deliveries are acknowledged without
 * mutating purchase state twice. Events are only recorded after successful
 * processing, so a transient failure can still be retried by PayPal.
 */
function createWebhookEventStore({ collection = null } = {}) {
  const memory = new Set();

  async function hasProcessed(eventId) {
    if (!eventId) return false;
    if (collection) return Boolean(await collection.findOne({ eventId }));
    return memory.has(eventId);
  }

  async function markProcessed({ eventId, eventType, orderId = null, purchaseId = null, tenantId = null }) {
    if (!eventId) return;
    if (collection) {
      try {
        await collection.insertOne({
          eventId,
          eventType: eventType || null,
          orderId,
          purchaseId,
          tenantId,
          processedAt: new Date().toISOString(),
        });
      } catch (err) {
        if (!err || err.code !== 11000) throw err;
      }
      return;
    }
    memory.add(eventId);
  }

  async function ensureIndexes() {
    if (!collection) return;
    try { await collection.createIndex({ eventId: 1 }, { unique: true }); } catch { /* best-effort */ }
    try { await collection.createIndex({ processedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }); } catch { /* TTL best-effort */ }
  }

  return { hasProcessed, markProcessed, ensureIndexes };
}

module.exports = { createWebhookEventStore };
