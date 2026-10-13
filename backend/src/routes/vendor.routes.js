'use strict';

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

function createVendorRoutes({ vendorService }) {
  const router = express.Router();

  router.get('/vendors', async (req, res, next) => {
    try {
      const offers = await vendorService.getCatalog();
      res.json({ success: true, data: offers, meta: { count: offers.length } });
    } catch (error) { next(error); }
  });

  router.post('/vendors/import', async (req, res, next) => {
    try {
      const offers = req.body && req.body.offers;
      if (!Array.isArray(offers) || offers.length === 0) throw badRequest('The request must include a non-empty offers array.');
      if (offers.length > 2000) throw badRequest('A single import is limited to 2,000 offers.');
      const details = offers.flatMap((offer, index) => validateOffer(offer && typeof offer === 'object' ? offer : {}, index));
      if (details.length) throw badRequest('Vendor offers failed validation.', details);
      const offerIds = offers.map((offer) => offer.offerId.trim());
      if (new Set(offerIds).size !== offerIds.length) throw badRequest('offerId values must be unique within the import.');
      const result = await vendorService.importOffers(offers.map((offer) => ({
        ...offer,
        offerId: offer.offerId.trim(),
        vendorId: offer.vendorId.trim(),
        vendorName: offer.vendorName.trim(),
        productId: offer.productId.trim(),
        currency: offer.currency.trim().toUpperCase(),
        compatibleProductIds: offer.compatibleProductIds || [],
      })));
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      if (error.code === 11000) return next(badRequest('An offerId conflicts with an existing offer.'));
      next(error);
    }
  });

  return router;
}

module.exports = { createVendorRoutes };
