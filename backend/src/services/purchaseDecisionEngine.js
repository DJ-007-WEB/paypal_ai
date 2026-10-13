'use strict';

/**
 * Mandate Core Purchase Decision Engine
 *
 * Pure deterministic recommendation logic. No AI, network, database, or payment
 * integration. This module recommends an offer only; it never authorizes payment.
 *
 * Money is expressed as integer minor units. Supported currencies and exponents
 * are explicit below. No currency conversion is performed.
 *
 * Required offer pricing fields (shippingMinor, taxMinor, feesMinor) must be
 * present, even when their verified value is zero. Unknown charges are not zero.
 */

const ENGINE_VERSION = '1.1.0';
const CRITERIA = Object.freeze(['cost', 'delivery', 'quality', 'reliability']);
const DEFAULT_WEIGHTS = Object.freeze({ cost: 1, delivery: 0, quality: 0, reliability: 0 });
const CURRENCY_EXPONENT = Object.freeze({
  INR: 2, USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, CHF: 2, CNY: 2,
  SGD: 2, NZD: 2, HKD: 2, AED: 2, SAR: 2, BRL: 2, MXN: 2, ZAR: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
});
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string' && v.trim().length > 0;
const isSafeInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);
const isNonNegativeInt = (v) => isSafeInt(v) && v >= 0;
const isPositiveInt = (v) => isSafeInt(v) && v > 0;
const isScore = (v) => isNonNegativeInt(v) && v <= 100;
const isCurrency = (v) => typeof v === 'string' && Object.hasOwn(CURRENCY_EXPONENT, v);
const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function formatMoney(minor, currency) {
  const exponent = CURRENCY_EXPONENT[currency];
  const amount = BigInt(minor);
  const negative = amount < 0n;
  let digits = (negative ? -amount : amount).toString();
  if (exponent > 0) {
    digits = digits.padStart(exponent + 1, '0');
    digits = digits.slice(0, -exponent) + '.' + digits.slice(-exponent);
  }
  return (negative ? '-' : '') + currency + ' ' + digits;
}

function validateRequest(request) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  if (!isObject(request)) return [{ field: 'request', message: 'request must be an object' }];
  if (request.requestId !== undefined && !isString(request.requestId)) add('requestId', 'requestId must be a non-empty string');
  if (!isString(request.productId)) add('productId', 'productId must be a non-empty string');
  if (!isPositiveInt(request.quantity)) add('quantity', 'quantity must be a positive safe integer');
  if (!isPositiveInt(request.maxTotalMinor)) add('maxTotalMinor', 'maxTotalMinor must be a positive safe integer in minor units');
  if (!isCurrency(request.currency)) add('currency', 'currency is unsupported; use an explicitly supported currency');
  if (!isNonNegativeInt(request.maxDeliveryDays)) add('maxDeliveryDays', 'maxDeliveryDays must be a non-negative safe integer');
  if (typeof request.requireApprovedVendor !== 'boolean') add('requireApprovedVendor', 'requireApprovedVendor must be an explicit boolean');
  for (const field of ['minQualityScore', 'minReliabilityScore']) {
    if (request[field] !== undefined && !isScore(request[field])) add(field, field + ' must be an integer from 0 to 100');
  }
  let weights = { ...DEFAULT_WEIGHTS };
  if (request.rankingWeights !== undefined) {
    if (!isObject(request.rankingWeights)) add('rankingWeights', 'rankingWeights must be an object');
    else {
      weights = { cost: 0, delivery: 0, quality: 0, reliability: 0 };
      for (const [key, value] of Object.entries(request.rankingWeights)) {
        if (!CRITERIA.includes(key)) add('rankingWeights', 'unknown ranking criterion: ' + key);
        else if (!isNonNegativeInt(value)) add('rankingWeights.' + key, 'weight must be a non-negative safe integer');
        else weights[key] = value;
      }
      if (CRITERIA.every((key) => weights[key] === 0)) add('rankingWeights', 'at least one ranking weight must be greater than zero');
    }
  }
  if (errors.length) return errors;
  return {
    normalized: {
      requestId: request.requestId ?? null,
      productId: request.productId,
      quantity: request.quantity,
      maxTotalMinor: request.maxTotalMinor,
      currency: request.currency,
      maxDeliveryDays: request.maxDeliveryDays,
      requireApprovedVendor: request.requireApprovedVendor,
      minQualityScore: request.minQualityScore ?? null,
      minReliabilityScore: request.minReliabilityScore ?? null,
      rankingWeights: weights,
    },
  };
}

function validateOffer(offer, index, quantity) {
  const issues = [];
  const add = (field, message) => issues.push({ field, message });
  const ref = isObject(offer) && isString(offer.offerId) ? offer.offerId : 'offers[' + index + ']';
  if (!isObject(offer)) return { ref, issues: [{ field: 'offer', message: 'offer must be an object' }] };
  for (const field of ['offerId', 'vendorId', 'productId']) {
    if (!isString(offer[field])) add(field, field + ' must be a non-empty string');
  }
  if (offer.compatibleProductIds !== undefined &&
      (!Array.isArray(offer.compatibleProductIds) || !offer.compatibleProductIds.every(isString))) {
    add('compatibleProductIds', 'compatibleProductIds must be an array of non-empty strings');
  }
  if (!isPositiveInt(offer.unitPriceMinor)) add('unitPriceMinor', 'unitPriceMinor must be a positive safe integer');
  if (!isNonNegativeInt(offer.availableQuantity)) add('availableQuantity', 'availableQuantity must be a non-negative safe integer');
  if (!isCurrency(offer.currency)) add('currency', 'currency is unsupported');
  if (!isNonNegativeInt(offer.deliveryDays)) add('deliveryDays', 'deliveryDays must be a non-negative safe integer');
  if (typeof offer.vendorApproved !== 'boolean') add('vendorApproved', 'vendorApproved must be a boolean');
  for (const field of ['shippingMinor', 'taxMinor', 'feesMinor']) {
    if (!owns(offer, field)) add(field, field + ' must be explicitly supplied; unknown charges cannot be assumed to be zero');
    else if (!isNonNegativeInt(offer[field])) add(field, field + ' must be a non-negative safe integer');
  }
  for (const field of ['qualityScore', 'reliabilityScore']) {
    if (offer[field] !== undefined && !isScore(offer[field])) add(field, field + ' must be an integer from 0 to 100');
  }
  if (issues.length) return { ref, issues };
  const subtotal = BigInt(offer.unitPriceMinor) * BigInt(quantity);
  const total = subtotal + BigInt(offer.shippingMinor) + BigInt(offer.taxMinor) + BigInt(offer.feesMinor);
  if (total > MAX_SAFE_BIGINT) return { ref, issues: [{ field: 'totalCost', message: 'total cost exceeds the safe integer range' }] };
  return {
    ref, issues,
    offer: {
      offerId: offer.offerId, vendorId: offer.vendorId, productId: offer.productId,
      compatibleProductIds: offer.compatibleProductIds ? [...offer.compatibleProductIds] : [],
      unitPriceMinor: offer.unitPriceMinor, availableQuantity: offer.availableQuantity,
      currency: offer.currency, deliveryDays: offer.deliveryDays, vendorApproved: offer.vendorApproved,
      shippingMinor: offer.shippingMinor, taxMinor: offer.taxMinor, feesMinor: offer.feesMinor,
      subtotal, total: Number(total),
      qualityScore: offer.qualityScore ?? null, reliabilityScore: offer.reliabilityScore ?? null,
    },
  };
}

function evaluatePurchaseRequest(request, offers) {
  const validated = validateRequest(request);
  if (Array.isArray(validated)) return invalidRequest(validated);
  if (!Array.isArray(offers)) return invalidRequest([{ field: 'offers', message: 'offers must be an array' }]);
  const req = validated.normalized;
  const rejected = [];
  const validOffers = [];
  const seenIds = new Set();

  offers.forEach((raw, index) => {
    const checked = validateOffer(raw, index, req.quantity);
    if (checked.issues.length) {
      rejected.push({ offerId: checked.ref, vendorId: isObject(raw) && isString(raw.vendorId) ? raw.vendorId : null,
        reasons: [{ code: 'INVALID_OFFER', message: checked.issues.map((x) => x.field + ': ' + x.message).join('; '), details: checked.issues }] });
      return;
    }
    const o = checked.offer;
    if (seenIds.has(o.offerId)) {
      rejected.push({ offerId: o.offerId, vendorId: o.vendorId,
        reasons: [{ code: 'DUPLICATE_OFFER_ID', message: 'Offer identifier is duplicated within this evaluation.' }] });
      return;
    }
    seenIds.add(o.offerId);
    const reasons = [];
    const add = (code, message, details = {}) => reasons.push({ code, message, details });
    if (o.productId !== req.productId && !o.compatibleProductIds.includes(req.productId)) {
      add('PRODUCT_INCOMPATIBLE', 'Offer does not match the requested product or declare compatibility.');
    }
    if (o.availableQuantity < req.quantity) add('INSUFFICIENT_QUANTITY', 'Available quantity is below the requested quantity.', { available: o.availableQuantity, requested: req.quantity });
    if (o.currency !== req.currency) add('CURRENCY_MISMATCH', 'Offer currency differs from request currency; conversion is not supported.', { offerCurrency: o.currency, requestCurrency: req.currency });
    if (req.requireApprovedVendor && !o.vendorApproved) add('VENDOR_NOT_APPROVED', 'The request requires an approved vendor.');
    if (o.deliveryDays > req.maxDeliveryDays) add('DELIVERY_TOO_LATE', 'Delivery exceeds the required deadline.', { deliveryDays: o.deliveryDays, maximum: req.maxDeliveryDays });
    if (o.total > req.maxTotalMinor) add('BUDGET_EXCEEDED', 'Total cost exceeds the inclusive budget ceiling.', { totalMinor: o.total, budgetMinor: req.maxTotalMinor, overByMinor: o.total - req.maxTotalMinor });
    for (const [field, minimum, code] of [
      ['qualityScore', req.minQualityScore, 'QUALITY_BELOW_MINIMUM'],
      ['reliabilityScore', req.minReliabilityScore, 'RELIABILITY_BELOW_MINIMUM'],
    ]) {
      if (minimum !== null && o[field] === null) add(code.replace('BELOW_MINIMUM', 'UNKNOWN'), 'Required ' + field + ' cannot be verified because it is missing.', { minimum });
      else if (minimum !== null && o[field] < minimum) add(code, field + ' is below the required minimum.', { score: o[field], minimum });
    }
    if (reasons.length) rejected.push({ offerId: o.offerId, vendorId: o.vendorId, reasons });
    else validOffers.push(o);
  });

  const weights = req.rankingWeights;
  const active = CRITERIA.filter((c) => weights[c] > 0);
  const totalWeight = active.reduce((sum, c) => sum + BigInt(weights[c]), 0n);
  const totalWeightNumberSafe = totalWeight <= MAX_SAFE_BIGINT;
  if (!totalWeightNumberSafe) return invalidRequest([{ field: 'rankingWeights', message: 'sum of ranking weights exceeds the safe supported range' }]);
  const metric = (o, criterion) => {
    if (criterion === 'cost') return BigInt(o.total);
    if (criterion === 'delivery') return BigInt(o.deliveryDays);
    if (criterion === 'quality') return o.qualityScore === null ? null : BigInt(o.qualityScore);
    return o.reliabilityScore === null ? null : BigInt(o.reliabilityScore);
  };
  const minMax = {};
  for (const c of active) {
    const values = validOffers.map((o) => metric(o, c)).filter((v) => v !== null);
    minMax[c] = values.length ? { min: values.reduce((a,b) => a < b ? a : b), max: values.reduce((a,b) => a > b ? a : b) } : { min: 0n, max: 0n };
  }
  const scored = validOffers.map((o) => {
    const parts = {};
    let weighted = 0;
    for (const c of active) {
      const value = metric(o, c);
      let normalized;
      if (c === 'quality' || c === 'reliability') normalized = value === null ? 0 : Number(value) / 100;
      else if (value === null || minMax[c].max === minMax[c].min) normalized = 1;
      else normalized = Number(minMax[c].max - value) / Number(minMax[c].max - minMax[c].min);
      parts[c] = { weight: weights[c], normalized, missing: value === null };
      weighted += weights[c] * normalized;
    }
    return { offer: o, score: weighted / Number(totalWeight), parts };
  });
  scored.sort((a, b) => b.score - a.score ||
    a.offer.total - b.offer.total ||
    a.offer.deliveryDays - b.offer.deliveryDays ||
    (b.offer.qualityScore ?? -1) - (a.offer.qualityScore ?? -1) ||
    (b.offer.reliabilityScore ?? -1) - (a.offer.reliabilityScore ?? -1) ||
    a.offer.vendorId.localeCompare(b.offer.vendorId) ||
    a.offer.offerId.localeCompare(b.offer.offerId));

  const ranking = scored.map((entry, index) => ({
    rank: index > 0 && entry.score === scored[index - 1].score ? rankingRank(scored, index) : index + 1,
    tied: index > 0 && entry.score === scored[index - 1].score,
    offerId: entry.offer.offerId, vendorId: entry.offer.vendorId,
    score: Number(entry.score.toFixed(8)),
    cost: { currency: entry.offer.currency, unitPriceMinor: entry.offer.unitPriceMinor,
      subtotalMinor: Number(entry.offer.subtotal), shippingMinor: entry.offer.shippingMinor,
      taxMinor: entry.offer.taxMinor, feesMinor: entry.offer.feesMinor, totalMinor: entry.offer.total },
    criteria: { deliveryDays: entry.offer.deliveryDays, qualityScore: entry.offer.qualityScore, reliabilityScore: entry.offer.reliabilityScore },
    scoreBreakdown: entry.parts,
  }));
  const uncertainties = [];
  for (const row of ranking) {
    for (const c of ['quality', 'reliability']) {
      if (weights[c] > 0 && row.scoreBreakdown[c]?.missing) uncertainties.push({
        code: c === 'quality' ? 'MISSING_QUALITY' : 'MISSING_RELIABILITY',
        offerId: row.offerId, message: 'Missing ' + c + ' data was scored as zero for this ranking criterion.',
      });
    }
  }
  if (ranking.length === 1) uncertainties.push({ code: 'SINGLE_ELIGIBLE_OFFER', offerId: ranking[0].offerId, message: 'Only one offer was eligible, so no comparison was possible.' });
  if (ranking.length > 1 && ranking[0].score === ranking[1].score) uncertainties.push({
    code: 'TIE_AT_TOP', offerId: null, message: 'Top offers have equal displayed scores; human review is recommended.',
  });

  const recommendation = ranking.length ? {
    offerId: ranking[0].offerId, vendorId: ranking[0].vendorId, totalMinor: ranking[0].cost.totalMinor,
    currency: req.currency, score: ranking[0].score,
    rationale: ['Highest weighted score among eligible offers.', 'Total includes explicitly supplied unit price, shipping, tax, and fees.'],
  } : null;
  const money = (amount) => formatMoney(amount, req.currency);
  const explanation = 'Evaluated ' + offers.length + ' offer(s); ' + validOffers.length + ' eligible and ' + rejected.length +
    ' rejected. ' + (recommendation ? 'Recommended ' + recommendation.offerId + ' from ' + recommendation.vendorId +
      ' at ' + money(recommendation.totalMinor) + '. This is a recommendation only; policy validation and human approval are required before payment.' :
      'No eligible offer was found.');
  return {
    status: recommendation ? 'RECOMMENDED' : 'NO_ELIGIBLE_OFFER',
    engineVersion: ENGINE_VERSION,
    authorization: { paymentAuthorized: false },
    request: req,
    criteria: { hardConstraints: ['product compatibility', 'quantity', 'currency match', 'vendor approval when required', 'delivery deadline', 'budget', 'configured minimum quality and reliability'], rankingWeights: weights },
    recommendation, ranking, rejected, uncertainties, explanation, errors: [],
    contract: { money: 'integer minor units', supportedCurrencies: Object.keys(CURRENCY_EXPONENT),
      missingPricing: 'shippingMinor, taxMinor, and feesMinor must be explicitly supplied; unknown values are invalid, not zero',
      payment: 'recommendation only; no payment authorization or execution' },
  };
}

function rankingRank(scored, index) {
  let first = index;
  while (first > 0 && scored[first - 1].score === scored[index].score) first--;
  return first + 1;
}

function invalidRequest(errors) {
  return { status: 'INVALID_REQUEST', engineVersion: ENGINE_VERSION,
    authorization: { paymentAuthorized: false }, request: null, criteria: null,
    recommendation: null, ranking: [], rejected: [], uncertainties: [],
    explanation: 'The request could not be evaluated because input validation failed.',
    errors, };
}

module.exports = { evaluatePurchaseRequest, formatMoney, ENGINE_VERSION, SUPPORTED_CURRENCIES: Object.keys(CURRENCY_EXPONENT) };
