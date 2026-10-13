'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePurchaseRequest } = require('../src/services/purchaseDecisionEngine');

const request = (x = {}) => ({ productId: 'BRG-6204', quantity: 100, maxTotalMinor: 5000000,
  currency: 'INR', maxDeliveryDays: 5, requireApprovedVendor: true, ...x });
const offer = (x = {}) => ({ offerId: 'o1', vendorId: 'v1', productId: 'BRG-6204',
  unitPriceMinor: 40000, availableQuantity: 500, currency: 'INR', deliveryDays: 3,
  vendorApproved: true, shippingMinor: 0, taxMinor: 0, feesMinor: 0, ...x });
const codes = (r, id) => r.rejected.find((x) => x.offerId === id).reasons.map((x) => x.code);

test('lowest total cost wins by default; explicit charges are included', () => {
  const r = evaluatePurchaseRequest(request(), [offer({offerId:'a',unitPriceMinor:45000}),
    offer({offerId:'b',unitPriceMinor:38000}), offer({offerId:'c',unitPriceMinor:42000,shippingMinor:5000})]);
  assert.equal(r.status, 'RECOMMENDED'); assert.equal(r.recommendation.offerId, 'b');
  assert.equal(r.recommendation.totalMinor, 3800000); assert.deepEqual(r.ranking.map(x=>x.offerId), ['b','c','a']);
  assert.equal(r.ranking[1].cost.totalMinor, 4205000);
});
test('unknown mandatory pricing is rejected, not treated as zero', () => {
  const r = evaluatePurchaseRequest(request(), [offer({offerId:'unknown',shippingMinor:undefined}), offer({offerId:'valid',vendorId:'v2',unitPriceMinor:41000})]);
  assert.equal(r.recommendation.offerId, 'valid'); assert.deepEqual(codes(r,'unknown'), ['INVALID_OFFER']);
});
test('hard constraints always beat ranking preferences', () => {
  const r = evaluatePurchaseRequest(request({rankingWeights:{cost:1,quality:100}}), [
    offer({offerId:'cheap',unitPriceMinor:10000,vendorApproved:false,qualityScore:100}),
    offer({offerId:'valid',vendorId:'v2',unitPriceMinor:45000,qualityScore:80})]);
  assert.equal(r.recommendation.offerId,'valid'); assert.deepEqual(codes(r,'cheap'),['VENDOR_NOT_APPROVED']);
});
test('inclusive budget boundary and over-budget rejection', () => {
  assert.equal(evaluatePurchaseRequest(request({maxTotalMinor:4000000}),[offer()]).status,'RECOMMENDED');
  const r=evaluatePurchaseRequest(request({maxTotalMinor:3999999}),[offer()]);
  assert.equal(r.status,'NO_ELIGIBLE_OFFER'); assert.deepEqual(codes(r,'o1'),['BUDGET_EXCEEDED']);
});
test('currency mismatch is rejected without conversion', () => {
  assert.deepEqual(codes(evaluatePurchaseRequest(request(),[offer({currency:'USD'})]),'o1'),['CURRENCY_MISMATCH']);
});
test('unsupported currency and malformed request are rejected safely', () => {
  assert.equal(evaluatePurchaseRequest(request({currency:'XYZ'}),[offer()]).status,'INVALID_REQUEST');
  assert.equal(evaluatePurchaseRequest(null,[offer()]).status,'INVALID_REQUEST');
  assert.equal(evaluatePurchaseRequest(request(),null).status,'INVALID_REQUEST');
});
test('invalid offer does not block valid offers', () => {
  const r=evaluatePurchaseRequest(request(),[offer({offerId:'bad',unitPriceMinor:-1}),offer({offerId:'good',vendorId:'v2'})]);
  assert.equal(r.recommendation.offerId,'good'); assert.deepEqual(codes(r,'bad'),['INVALID_OFFER']);
});
test('all relevant hard failures are reported', () => {
  const r=evaluatePurchaseRequest(request({minQualityScore:80}),[offer({offerId:'bad',productId:'OTHER',availableQuantity:2,deliveryDays:10,qualityScore:50})]);
  assert.deepEqual(codes(r,'bad'),['PRODUCT_INCOMPATIBLE','INSUFFICIENT_QUANTITY','DELIVERY_TOO_LATE','QUALITY_BELOW_MINIMUM']);
});
test('missing quality cannot satisfy a configured minimum', () => {
  assert.deepEqual(codes(evaluatePurchaseRequest(request({minQualityScore:60}),[offer()]),'o1'),['QUALITY_UNKNOWN']);
});
test('delivery weighting can change the recommendation', () => {
  const r=evaluatePurchaseRequest(request({rankingWeights:{cost:1,delivery:5}}),[
    offer({offerId:'cheap',unitPriceMinor:30000,deliveryDays:5}),
    offer({offerId:'fast',vendorId:'v2',unitPriceMinor:45000,deliveryDays:1})]);
  assert.equal(r.recommendation.offerId,'fast');
});
test('ties are deterministically ordered and surfaced', () => {
  const r=evaluatePurchaseRequest(request({rankingWeights:{quality:1}}),[
    offer({offerId:'b',vendorId:'b',qualityScore:80}),offer({offerId:'a',vendorId:'a',qualityScore:80})]);
  assert.deepEqual(r.ranking.map(x=>x.offerId),['a','b']); assert.ok(r.uncertainties.some(x=>x.code==='TIE_AT_TOP'));
});
test('duplicate IDs cannot enter ranking twice', () => {
  const r=evaluatePurchaseRequest(request(),[offer({offerId:'dup'}),offer({offerId:'dup',vendorId:'v2'})]);
  assert.equal(r.ranking.length,1); assert.deepEqual(codes(r,'dup'),['DUPLICATE_OFFER_ID']);
});
test('currency exponents are explicit', () => {
  assert.match(evaluatePurchaseRequest(request({currency:'JPY',maxTotalMinor:50000}),[offer({currency:'JPY',unitPriceMinor:400})]).explanation,/JPY 40000/);
  assert.match(
  evaluatePurchaseRequest(
    request({ currency: 'KWD' }),
    [offer({ currency: 'KWD', unitPriceMinor: 40000 })]
  ).explanation,
  /KWD 4000\.000/
);
});
test('invalid weights are rejected', () => {
  assert.equal(evaluatePurchaseRequest(request({rankingWeights:{cost:0,delivery:0}}),[offer()]).status,'INVALID_REQUEST');
  assert.equal(evaluatePurchaseRequest(request({rankingWeights:{cost:-1}}),[offer()]).status,'INVALID_REQUEST');
});
test('results are deterministic, JSON serializable, and never authorize payment', () => {
  const r=evaluatePurchaseRequest(request(),[offer(),offer({offerId:'o2',vendorId:'v2',unitPriceMinor:42000})]);
  assert.deepEqual(r,evaluatePurchaseRequest(request(),[offer(),offer({offerId:'o2',vendorId:'v2',unitPriceMinor:42000})]));
  assert.doesNotThrow(()=>JSON.stringify(r)); assert.equal(r.authorization.paymentAuthorized,false);
});
test('no eligible offer means no recommendation', () => {
  const r=evaluatePurchaseRequest(request(),[offer({vendorApproved:false})]);
  assert.equal(r.status,'NO_ELIGIBLE_OFFER'); assert.equal(r.recommendation,null);
});
