'use strict';

function findOfferById(offers, offerId) {
  return offers.find((offer) => offer.offerId === offerId) || null;
}

function validatePurchasePolicy({ request, offers = [], engineResult }) {
  const violations = [];
  const add = (code, message, details = {}) => {
    violations.push({ code, message, details });
  };

  if (!request || typeof request !== 'object') {
    return { passed: false, violations: [{ code: 'INVALID_REQUEST', message: 'Request is required.' }], paymentAuthorized: false };
  }

  if (!engineResult || engineResult.status === 'INVALID_REQUEST') {
    return { passed: false, violations: [{ code: 'INVALID_REQUEST', message: 'The request was not valid for evaluation.' }], paymentAuthorized: false };
  }

  if (!engineResult.recommendation) {
    return {
      passed: false,
      violations: [{ code: 'NO_ELIGIBLE_OFFER', message: 'No eligible offer is available for policy validation.' }],
      paymentAuthorized: false,
    };
  }

  const offer = findOfferById(offers, engineResult.recommendation.offerId);
  if (!offer) {
    add('MISSING_OFFER', 'The selected offer could not be found in the evaluated vendor catalog.', { offerId: engineResult.recommendation.offerId });
    return { passed: false, violations, paymentAuthorized: false };
  }

  if (offer.productId !== request.productId && !(Array.isArray(offer.compatibleProductIds) && offer.compatibleProductIds.includes(request.productId))) {
    add('PRODUCT_INCOMPATIBLE', 'Selected offer does not match the requested product.', { offerId: offer.offerId, productId: request.productId });
  }

  if (offer.currency !== request.currency) {
    add('CURRENCY_MISMATCH', 'Selected offer currency does not match the request currency.', { offerCurrency: offer.currency, requestCurrency: request.currency });
  }

  if (offer.availableQuantity < request.quantity) {
    add('INSUFFICIENT_QUANTITY', 'Selected offer does not have enough inventory for the requested quantity.', { availableQuantity: offer.availableQuantity, requestedQuantity: request.quantity });
  }

  if (request.requireApprovedVendor && !offer.vendorApproved) {
    add('VENDOR_NOT_APPROVED', 'Selected vendor approval is required and was not satisfied.', { vendorId: offer.vendorId });
  }

  if (offer.deliveryDays > request.maxDeliveryDays) {
    add('DELIVERY_TOO_LATE', 'Selected offer exceeds the maximum allowed delivery days.', { deliveryDays: offer.deliveryDays, maxDeliveryDays: request.maxDeliveryDays });
  }

  const totalCost = (offer.unitPriceMinor * request.quantity) + offer.shippingMinor + offer.taxMinor + offer.feesMinor;
  if (totalCost > request.maxTotalMinor) {
    add('BUDGET_EXCEEDED', 'Selected offer total cost exceeds the maximum configured budget.', { totalCost, maxTotalMinor: request.maxTotalMinor });
  }

  if (request.minQualityScore !== undefined && (offer.qualityScore === null || offer.qualityScore === undefined || offer.qualityScore < request.minQualityScore)) {
    add('QUALITY_BELOW_MINIMUM', 'Selected offer quality does not meet the minimum quality requirement.', { qualityScore: offer.qualityScore, minimum: request.minQualityScore });
  }

  if (request.minReliabilityScore !== undefined && (offer.reliabilityScore === null || offer.reliabilityScore === undefined || offer.reliabilityScore < request.minReliabilityScore)) {
    add('RELIABILITY_BELOW_MINIMUM', 'Selected offer reliability does not meet the minimum reliability requirement.', { reliabilityScore: offer.reliabilityScore, minimum: request.minReliabilityScore });
  }

  return {
    passed: violations.length === 0,
    violations,
    paymentAuthorized: false,
  };
}

module.exports = { validatePurchasePolicy };
