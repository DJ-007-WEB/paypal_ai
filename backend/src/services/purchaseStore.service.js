'use strict';

const { randomUUID } = require('node:crypto');

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function createPurchaseStore() {
  const store = new Map();

  return {
    create(record) {
      const purchaseId = record.purchaseId || `purchase_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const entry = {
        ...cloneValue(record),
        purchaseId,
        createdAt: new Date().toISOString(),
      };
      store.set(purchaseId, cloneValue(entry));
      return cloneValue(entry);
    },
    upsert(purchaseId, updater) {
      const current = store.get(purchaseId) || { purchaseId };
      const next = updater(cloneValue(current));
      const entry = { ...cloneValue(next), purchaseId };
      store.set(purchaseId, cloneValue(entry));
      return cloneValue(entry);
    },
    getById(purchaseId) {
      const entry = store.get(purchaseId);
      if (!entry) {
        return null;
      }
      return cloneValue(entry);
    },
    list() {
      return Array.from(store.values()).map((entry) => cloneValue(entry));
    },
  };
}

module.exports = { createPurchaseStore };
