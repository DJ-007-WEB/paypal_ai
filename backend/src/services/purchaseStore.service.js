'use strict';

const { randomUUID } = require('node:crypto');
function cloneValue(value) { return JSON.parse(JSON.stringify(value)); }

function createPurchaseStore({ collection } = {}) {
  const store = new Map();
  return {
    async create(record) {
      const purchaseId = record.purchaseId || `purchase_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const entry = { ...cloneValue(record), purchaseId, createdAt: record.createdAt || new Date().toISOString() };
      if (collection) await collection.insertOne(entry);
      else store.set(purchaseId, cloneValue(entry));
      return cloneValue(entry);
    },
    async upsert(purchaseId, updater) {
      const current = collection ? (await collection.findOne({ purchaseId })) : store.get(purchaseId);
      const next = updater(cloneValue(current || { purchaseId }));
      const entry = { ...cloneValue(next), purchaseId };
      // MongoDB _id is immutable. JSON cloning converts ObjectId to a string,
      // so never pass a cloned _id back through replaceOne.
      delete entry._id;
      if (collection) {
        await collection.updateOne({ purchaseId }, { $set: entry }, { upsert: true });
        const saved = await collection.findOne({ purchaseId });
        return cloneValue(saved);
      }
      store.set(purchaseId, cloneValue(entry));
      return cloneValue(entry);
    },
    async getById(purchaseId) {
      const entry = collection ? await collection.findOne({ purchaseId }) : store.get(purchaseId);
      return entry ? cloneValue(entry) : null;
    },
    async list() {
      const entries = collection ? await collection.find({}).sort({ createdAt: -1 }).toArray() : Array.from(store.values());
      return entries.map(cloneValue);
    },
  };
}
module.exports = { createPurchaseStore };
