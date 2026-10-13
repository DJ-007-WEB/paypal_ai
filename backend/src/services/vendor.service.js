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

  if (!testOffers && !collection) {
    throw new Error('MongoDB vendor collection is required.');
  }

  async function getAll() {
    if (testOffers) return testOffers.map(cloneOffer);
    return (await collection.find({ active: { $ne: false } }).toArray()).map(cloneOffer);
  }

  return {
    async getCatalog() {
      return getAll();
    },
    async getOffersForRequest(request) {
      if (!request || typeof request.productId !== 'string') return [];
      const productId = request.productId.trim();
      if (testOffers) {
        return testOffers.filter((offer) => offer.productId === productId ||
          (Array.isArray(offer.compatibleProductIds) && offer.compatibleProductIds.includes(productId))).map(cloneOffer);
      }
      const offers = await collection.find({
        active: { $ne: false },
        $or: [{ productId }, { compatibleProductIds: productId }],
      }).toArray();
      return offers.map(cloneOffer);
    },
  };
}

module.exports = { createVendorService };
