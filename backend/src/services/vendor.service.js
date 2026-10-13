'use strict';

// Production vendor data comes from MongoDB. Explicit offer arrays are supported
// only for isolated tests; there is no built-in production/demo catalog.
function cloneOffer(offer) {
  const { _id, ...rest } = offer;
  return { ...rest, compatibleProductIds: Array.isArray(rest.compatibleProductIds) ? [...rest.compatibleProductIds] : [] };
}

function createVendorService(source = {}) {
  const testOffers = Array.isArray(source) ? source.map(cloneOffer) : null;
  const collection = Array.isArray(source) ? null : source.collection;

  if (!testOffers && !collection) throw new Error('MongoDB vendor collection is required.');

  async function getAll({ includeInactive = false } = {}) {
    if (testOffers) return testOffers.filter((offer) => includeInactive || offer.active !== false).map(cloneOffer);
    return (await collection.find(includeInactive ? {} : { active: { $ne: false } }).sort({ vendorName: 1, offerId: 1 }).toArray()).map(cloneOffer);
  }

  return {
    async getCatalog(options) {
      return getAll(options);
    },
    async getOffersForRequest(request) {
      if (!request || typeof request.productId !== 'string') return [];
      const productId = request.productId.trim();
      if (testOffers) {
        return testOffers.filter((offer) => offer.active !== false && (offer.productId === productId ||
          (Array.isArray(offer.compatibleProductIds) && offer.compatibleProductIds.includes(productId)))).map(cloneOffer);
      }
      const offers = await collection.find({
        active: { $ne: false },
        $or: [{ productId }, { compatibleProductIds: productId }],
      }).toArray();
      return offers.map(cloneOffer);
    },
    async importOffers(offers) {
      if (!Array.isArray(offers) || offers.length === 0) throw new Error('Provide at least one vendor offer.');
      if (testOffers) throw new Error('Vendor imports require MongoDB-backed storage.');
      const now = new Date().toISOString();
      const normalized = offers.map((offer) => ({ ...offer, active: offer.active !== false, updatedAt: now, createdAt: offer.createdAt || now }));
      const ids = normalized.map((offer) => offer.offerId);
      if (new Set(ids).size !== ids.length) throw new Error('Each offerId must be unique within an import.');
      const result = await collection.bulkWrite(normalized.map((offer) => ({
        updateOne: { filter: { offerId: offer.offerId }, update: { $set: offer, $setOnInsert: { createdAt: now } }, upsert: true },
      })), { ordered: true });
      return { received: normalized.length, inserted: result.upsertedCount, updated: result.modifiedCount };
    },
  };
}

module.exports = { createVendorService };
