'use strict';

// Production vendor data comes from MongoDB. Explicit offer arrays are supported
// only for isolated tests; there is no built-in production/demo catalog.
//
// Tenant isolation (§9): every method requires tenantId. Missing/invalid tenant
// context fails closed. Payload tenant fields are never trusted.

function requireTenantId(tenantId) {
  if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
    const err = new Error('Tenant context is required.');
    err.statusCode = 400;
    err.code = 'TENANT_CONTEXT_REQUIRED';
    throw err;
  }
  return tenantId.trim();
}

function cloneOffer(offer) {
  const { _id, ...rest } = offer;
  return { ...rest, compatibleProductIds: Array.isArray(rest.compatibleProductIds) ? [...rest.compatibleProductIds] : [] };
}

function createVendorService(source = {}) {
  // Backwards-compatible construction:
  // - createVendorService([{...}]) → in-memory test offers (no tenant enforcement at store level,
  //   but service methods still require tenantId and partition in-memory data by tenant)
  // - createVendorService({ collection }) → Mongo-backed
  // - createVendorService({ collection, testOffers }) → explicit combination (tests)
  let testOffers = null;
  let collection = null;
  if (Array.isArray(source)) {
    testOffers = source.map(cloneOffer);
  } else if (source && typeof source === 'object') {
    collection = source.collection || null;
    if (Array.isArray(source.testOffers)) testOffers = source.testOffers.map(cloneOffer);
    else if (Array.isArray(source.offers)) testOffers = source.offers.map(cloneOffer);
  }

  if (!testOffers && !collection) throw new Error('MongoDB vendor collection is required.');

  // In-memory test path partitions offers by tenantId once tenant scoping is active.
  // Legacy seed offers without tenantId are treated as belonging to the requesting
  // tenant on first scoped read (test convenience only; production always has tenantId).
  function scopedTestOffers(tenantId) {
    return testOffers
      .filter((offer) => offer.active !== false)
      .filter((offer) => !offer.tenantId || offer.tenantId === tenantId)
      .map(cloneOffer);
  }

  async function getAll({ tenantId, includeInactive = false } = {}) {
    const tid = requireTenantId(tenantId);
    if (testOffers) {
      return testOffers
        .filter((offer) => includeInactive || offer.active !== false)
        .filter((offer) => !offer.tenantId || offer.tenantId === tid)
        .map(cloneOffer);
    }
    const filter = includeInactive ? { tenantId: tid } : { tenantId: tid, active: { $ne: false } };
    return (await collection.find(filter).sort({ vendorName: 1, offerId: 1 }).toArray()).map(cloneOffer);
  }

  return {
    async getCatalog(options = {}) {
      // Support legacy getCatalog() with no args in isolated unit tests by failing closed
      // when tenantId is absent in production paths; tests must pass { tenantId }.
      if (!options || !options.tenantId) {
        requireTenantId(options && options.tenantId);
      }
      return getAll(options);
    },
    async getOffersForRequest(requestOrArgs, maybeRequest) {
      // New contract: getOffersForRequest({ tenantId, request })
      // Legacy contract: getOffersForRequest(request) — fails closed unless test harness
      // supplies tenant via request.tenantId explicitly (never from untrusted payload in prod).
      let tenantId;
      let request;
      if (requestOrArgs && typeof requestOrArgs === 'object' && ('tenantId' in requestOrArgs || 'request' in requestOrArgs)) {
        tenantId = requestOrArgs.tenantId;
        request = requestOrArgs.request;
      } else {
        request = requestOrArgs || maybeRequest;
        tenantId = request && request.tenantId;
      }
      const tid = requireTenantId(tenantId);
      if (!request || typeof request.productId !== 'string') return [];
      const productId = request.productId.trim();
      if (testOffers) {
        return scopedTestOffers(tid).filter((offer) => offer.active !== false && (offer.productId === productId ||
          (Array.isArray(offer.compatibleProductIds) && offer.compatibleProductIds.includes(productId)))).map(cloneOffer);
      }
      const offers = await collection.find({
        tenantId: tid,
        active: { $ne: false },
        $or: [{ productId }, { compatibleProductIds: productId }],
      }).toArray();
      return offers.map(cloneOffer);
    },
    async importOffers(args, maybeOffers, maybeActor) {
      // New contract: importOffers({ tenantId, offers, actorId, importId })
      // Legacy contract: importOffers(offers) — retained only to fail closed with a clear error.
      let tenantId;
      let offers;
      let actorId = null;
      let importId = null;
      if (args && typeof args === 'object' && !Array.isArray(args) && ('tenantId' in args || 'offers' in args)) {
        tenantId = args.tenantId;
        offers = args.offers;
        actorId = args.actorId || null;
        importId = args.importId || null;
      } else if (Array.isArray(args)) {
        throw new Error('importOffers requires { tenantId, offers, actorId }. Tenant context is required.');
      } else {
        offers = maybeOffers;
        tenantId = args && args.tenantId;
      }
      const tid = requireTenantId(tenantId);
      if (!Array.isArray(offers) || offers.length === 0) throw new Error('Provide at least one vendor offer.');
      if (testOffers) throw new Error('Vendor imports require MongoDB-backed storage.');
      const now = new Date().toISOString();
      const normalized = offers.map((offer) => {
        if (offer.tenantId && offer.tenantId !== tid) {
          const err = new Error('Offer tenant mismatch: payload tenant is never trusted.');
          err.statusCode = 403;
          err.code = 'TENANT_MISMATCH';
          throw err;
        }
        const { tenantId: _ignored, ...rest } = offer;
        return { ...rest, tenantId: tid, active: rest.active !== false, updatedAt: now, lastImportedBy: actorId, lastImportId: importId };
      });
      const ids = normalized.map((offer) => offer.offerId);
      if (new Set(ids).size !== ids.length) throw new Error('Each offerId must be unique within an import.');
      const result = await collection.bulkWrite(normalized.map((offer) => ({
        updateOne: { filter: { tenantId: tid, offerId: offer.offerId }, update: { $set: offer, $setOnInsert: { createdAt: now } }, upsert: true },
      })), { ordered: true });
      return { received: normalized.length, inserted: result.upsertedCount, updated: result.modifiedCount, tenantId: tid, importId };
    },
  };
}

module.exports = { createVendorService };
