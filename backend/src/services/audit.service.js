'use strict';

const { randomUUID } = require('node:crypto');
function safeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') return {};
  const copy = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('key')) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) copy[key] = value;
    else if (Array.isArray(value)) copy[key] = value.map((entry) => entry && typeof entry === 'object' ? safeMetadata(entry) : entry);
    else if (value && typeof value === 'object') copy[key] = safeMetadata(value);
  }
  return copy;
}
function createAuditService({ collection } = {}) {
  const events = [];
  return {
    async recordEvent({ eventType, requestId = null, purchaseId = null, actorId = null, metadata = {} }) {
      const event = { eventId: randomUUID(), eventType, timestamp: new Date().toISOString(), requestId, purchaseId, actorId, metadata: safeMetadata(metadata) };
      if (collection) await collection.insertOne(event);
      else events.push(event);
      return { ...event, metadata: { ...event.metadata } };
    },
    async listEvents() {
      const all = collection ? await collection.find({}).sort({ timestamp: -1 }).toArray() : events;
      return all.map((event) => ({ ...event, metadata: { ...event.metadata } }));
    },
    async getEventsByRequestId(requestId) {
      const found = collection ? await collection.find({ requestId }).sort({ timestamp: 1 }).toArray() : events.filter((event) => event.requestId === requestId);
      return found.map((event) => ({ ...event, metadata: { ...event.metadata } }));
    },
    async getEventsForPurchase(purchaseId) {
      const found = collection ? await collection.find({ purchaseId }).sort({ timestamp: 1 }).toArray() : events.filter((event) => event.purchaseId === purchaseId);
      return found.map((event) => ({ ...event, metadata: { ...event.metadata } }));
    },
    async clear() {
      if (collection) await collection.deleteMany({});
      else events.length = 0;
    },
  };
}
module.exports = { createAuditService };
