'use strict';

const { SUPPORTED_CURRENCIES } = require('./purchaseDecisionEngine');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string' && value.trim().length > 0;
const isInteger = (value) => Number.isInteger(value);

function validatePurchaseRequest(request) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });

  if (!isObject(request)) {
    return { valid: false, errors: [{ field: 'request', message: 'Request body must be an object.' }] };
  }

  if (request.requestId !== undefined && !isString(request.requestId)) {
    add('requestId', 'requestId must be a non-empty string.');
  }

  if (!isString(request.productId)) {
    add('productId', 'productId must be a non-empty string.');
  }

  if (!isInteger(request.quantity) || request.quantity <= 0) {
    add('quantity', 'Quantity must be a positive integer.');
  }

  if (!isInteger(request.maxTotalMinor) || request.maxTotalMinor <= 0) {
    add('maxTotalMinor', 'maxTotalMinor must be a positive integer in minor units.');
  }

  if (!isString(request.currency) || !SUPPORTED_CURRENCIES.includes(request.currency)) {
    add('currency', 'currency is unsupported; use an explicitly supported currency.');
  }

  if (!isInteger(request.maxDeliveryDays) || request.maxDeliveryDays < 0) {
    add('maxDeliveryDays', 'maxDeliveryDays must be a non-negative integer.');
  }

  if (typeof request.requireApprovedVendor !== 'boolean') {
    add('requireApprovedVendor', 'requireApprovedVendor must be an explicit boolean.');
  }

  for (const field of ['minQualityScore', 'minReliabilityScore']) {
    if (request[field] !== undefined && (!isInteger(request[field]) || request[field] < 0 || request[field] > 100)) {
      add(field, `${field} must be an integer from 0 to 100.`);
    }
  }

  if (request.rankingWeights !== undefined) {
    if (!isObject(request.rankingWeights)) {
      add('rankingWeights', 'rankingWeights must be an object.');
    } else {
      const validCriteria = ['cost', 'delivery', 'quality', 'reliability'];
      let total = 0;
      for (const [key, value] of Object.entries(request.rankingWeights)) {
        if (!validCriteria.includes(key)) {
          add('rankingWeights', `Unknown ranking criterion: ${key}.`);
        } else if (!isInteger(value) || value < 0) {
          add(`rankingWeights.${key}`, 'Weight must be a non-negative integer.');
        } else {
          total += value;
        }
      }
      if (Object.keys(request.rankingWeights).length > 0 && total === 0) {
        add('rankingWeights', 'At least one ranking weight must be greater than zero.');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validatePurchaseRequest };
