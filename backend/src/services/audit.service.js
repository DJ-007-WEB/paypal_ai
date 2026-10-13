'use strict';

const { randomUUID } = require('node:crypto');

function safeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  const copy = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('key')) {
      continue;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      copy[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      copy[key] = value.map((entry) => (typeof entry === 'object' ? safeMetadata(entry) : entry));
      continue;
    }

    if (value && typeof value === 'object') {
      copy[key] = safeMetadata(value);
    }
  }

  return copy;
}

function createAuditService() {
  const events = [];

  return {
    recordEvent({ eventType, requestId = null, purchaseId = null, actorId = null, metadata = {} }) {
      const event = {
        eventId: randomUUID(),
        eventType,
        timestamp: new Date().toISOString(),
        requestId,
        purchaseId,
        actorId,
        metadata: safeMetadata(metadata),
      };
      events.push(event);
      return { ...event, metadata: { ...event.metadata } };
    },
    listEvents() {
      return events.map((event) => ({ ...event, metadata: { ...event.metadata } }));
    },
    getEventsByRequestId(requestId) {
      return events
        .filter((event) => event.requestId === requestId)
        .map((event) => ({ ...event, metadata: { ...event.metadata } }));
    },
    getEventsForPurchase(purchaseId) {
      return events
        .filter((event) => event.purchaseId === purchaseId)
        .map((event) => ({ ...event, metadata: { ...event.metadata } }));
    },
    clear() {
      events.length = 0;
    },
  };
}

module.exports = { createAuditService };
