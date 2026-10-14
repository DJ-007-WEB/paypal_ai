'use strict';

const crypto = require('node:crypto');
const express = require('express');

function badRequest(message, details = []) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  error.details = details;
  return error;
}

function validateOffer(offer, index) {
  const errors = [];
  const requiredStrings = ['offerId', 'vendorId', 'vendorName', 'productId', 'currency'];
  for (const key of requiredStrings) {
    if (typeof offer[key] !== 'string' || !offer[key].trim()) errors.push({ field: `offers[${index}].${key}`, message: 'A non-empty string is required.' });
  }
  for (const key of ['unitPriceMinor', 'availableQuantity', 'deliveryDays', 'shippingMinor', 'taxMinor', 'feesMinor', 'qualityScore', 'reliabilityScore']) {
    if (!Number.isFinite(offer[key]) || offer[key] < 0) errors.push({ field: `offers[${index}].${key}`, message: 'A non-negative number is required; charges must be explicit.' });
  }
  if (!Number.isInteger(offer.availableQuantity) || !Number.isInteger(offer.deliveryDays)) errors.push({ field: `offers[${index}]`, message: 'availableQuantity and deliveryDays must be integers.' });
  if (typeof offer.vendorApproved !== 'boolean') errors.push({ field: `offers[${index}].vendorApproved`, message: 'A boolean vendorApproved value is required.' });
  if (offer.active !== undefined && typeof offer.active !== 'boolean') errors.push({ field: `offers[${index}].active`, message: 'active must be a boolean when provided.' });
  if (offer.compatibleProductIds !== undefined && (!Array.isArray(offer.compatibleProductIds) || offer.compatibleProductIds.some((id) => typeof id !== 'string'))) errors.push({ field: `offers[${index}].compatibleProductIds`, message: 'Must be an array of product ID strings.' });
  return errors;
}

// Per-tenant import quotas (§11): hard max from config + daily/concurrency guards.
function createImportQuotaTracker() {
  const daily = new Map(); // tenantId -> { date, count }
  const concurrent = new Map(); // tenantId -> count
  const seenImportIds = new Map(); // `${tenantId}:${importId}` -> result
  const MAX_DAILY_IMPORTS_PER_TENANT = 20;
  const MAX_CONCURRENT_IMPORTS_PER_TENANT = 2;

  function checkAndAcquire(tenantId, importId) {
    const today = new Date().toISOString().slice(0, 10);
    const d = daily.get(tenantId);
    if (!d || d.date !== today) daily.set(tenantId, { date: today, count: 0 });
    const entry = daily.get(tenantId);
    if (entry.count >= MAX_DAILY_IMPORTS_PER_TENANT) {
      const err = new Error('Daily import quota exceeded for this workspace. Try again tomorrow.');
      err.statusCode = 429;
      err.code = 'IMPORT_QUOTA_EXCEEDED';
      throw err;
    }
    const running = concurrent.get(tenantId) || 0;
    if (running >= MAX_CONCURRENT_IMPORTS_PER_TENANT) {
      const err = new Error('Too many concurrent imports for this workspace. Wait and retry.');
      err.statusCode = 429;
      err.code = 'IMPORT_CONCURRENCY_EXCEEDED';
      throw err;
    }
    if (importId) {
      const key = `${tenantId}:${importId}`;
      if (seenImportIds.has(key)) {
        return { idempotentReplay: seenImportIds.get(key) };
      }
    }
    entry.count += 1;
    concurrent.set(tenantId, running + 1);
    return { idempotentReplay: null };
  }

  function release(tenantId, importId, result) {
    const running = concurrent.get(tenantId) || 1;
    concurrent.set(tenantId, Math.max(0, running - 1));
    if (importId && result) seenImportIds.set(`${tenantId}:${importId}`, result);
  }

  function releaseWithoutCache(tenantId) {
    const running = concurrent.get(tenantId) || 1;
    concurrent.set(tenantId, Math.max(0, running - 1));
    // Roll back daily count on validation failure (quota should count attempts that reach storage)
    const today = new Date().toISOString().slice(0, 10);
    const d = daily.get(tenantId);
    if (d && d.date === today && d.count > 0) d.count -= 1;
  }

  return { checkAndAcquire, release, releaseWithoutCache };
}

function createVendorRoutes({ vendorService, auditService, config, quotaTracker } = {}) {
  if (!vendorService) throw new Error('vendor routes require vendorService.');
  const router = express.Router();
  const quotas = quotaTracker || createImportQuotaTracker();
  const maxRows = config ? config.MAX_IMPORT_ROWS : 2000;

  // Auth + tenant + permission wiring is applied in app.js via middleware chain.
  // These handlers assume req.auth.tenantId is present (fail closed otherwise).

  router.get('/vendors', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const offers = await vendorService.getCatalog({ tenantId: req.auth.tenantId });
      res.json({ success: true, data: offers, meta: { count: offers.length } });
    } catch (error) { next(error); }
  });

  router.post('/vendors/import', async (req, res, next) => {
    let tenantId = null;
    let importId = null;
    let acquired = false;
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      tenantId = req.auth.tenantId;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const offers = body.offers;
      importId = typeof body.importId === 'string' && body.importId.trim()
        ? body.importId.trim().slice(0, 128)
        : (req.get('Idempotency-Key') || '').trim().slice(0, 128) || `import_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

      if (!Array.isArray(offers) || offers.length === 0) throw badRequest('The request must include a non-empty offers array.');
      if (offers.length > maxRows) throw badRequest(`A single import is limited to ${maxRows} offers.`);

      // Reject untrusted tenant ownership in payload (§11)
      for (let i = 0; i < offers.length; i++) {
        const o = offers[i];
        if (o && typeof o === 'object' && o.tenantId !== undefined && o.tenantId !== null && String(o.tenantId).trim() !== '' && String(o.tenantId).trim() !== tenantId) {
          const err = new Error('Payload tenant identifiers are never trusted. Remove tenantId from import rows.');
          err.statusCode = 403;
          err.code = 'TENANT_MISMATCH';
          throw err;
        }
      }

      const details = offers.flatMap((offer, index) => validateOffer(offer && typeof offer === 'object' ? offer : {}, index));
      if (details.length) throw badRequest('Vendor offers failed validation.', details);
      const offerIds = offers.map((offer) => offer.offerId.trim());
      if (new Set(offerIds).size !== offerIds.length) throw badRequest('offerId values must be unique within the import.');

      const quotaCheck = quotas.checkAndAcquire(tenantId, importId);
      acquired = true;
      if (quotaCheck.idempotentReplay) {
        return res.status(200).json({ success: true, data: quotaCheck.idempotentReplay, meta: { idempotentReplay: true, importId } });
      }

      const normalized = offers.map((offer) => {
        const { tenantId: _ignored, ...rest } = offer;
        return {
          ...rest,
          offerId: rest.offerId.trim(),
          vendorId: rest.vendorId.trim(),
          vendorName: rest.vendorName.trim(),
          productId: rest.productId.trim(),
          currency: rest.currency.trim().toUpperCase(),
          compatibleProductIds: rest.compatibleProductIds || [],
        };
      });

      const result = await vendorService.importOffers({ tenantId, offers: normalized, actorId: req.auth.userId, importId });
      const payload = { ...result, importId };
      quotas.release(tenantId, importId, payload);

      if (auditService) {
        try {
          await auditService.recordEvent({
            tenantId,
            eventType: 'VENDOR_IMPORT_COMPLETED',
            requestId: req.requestId || null,
            actorId: req.auth.userId,
            metadata: { importId, received: payload.received, inserted: payload.inserted, updated: payload.updated },
          });
        } catch { /* audit best-effort */ }
      }

      res.status(200).json({ success: true, data: payload, meta: { importId } });
    } catch (error) {
      if (acquired && tenantId) {
        // Validation errors should not consume quota/replay cache; storage errors keep quota accounting.
        if (error.code === 'VALIDATION_ERROR') {
          try { quotas.releaseWithoutCache(tenantId); } catch { /* ignore */ }
          acquired = false;
        } else if (error.code === 11000) {
          try { quotas.release(tenantId, importId, null); } catch { /* ignore */ }
          acquired = false;
          return next(badRequest('An offerId conflicts with an existing offer.'));
        }
      }
      if (error && error.code === 11000) return next(badRequest('An offerId conflicts with an existing offer.'));
      // Avoid raw database errors in responses
      if (error && error.code && String(error.code).startsWith(' Koh')) {
        const safe = new Error('Import failed due to a storage error.');
        safe.statusCode = 500;
        safe.code = 'IMPORT_FAILED';
        return next(safe);
      }
      next(error);
    }
  });

  router.__quotaTracker = quotas;
  return router;
}

module.exports = { createVendorRoutes, createImportQuotaTracker };
