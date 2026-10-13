'use strict';

const DEFAULT_VENDOR_OFFERS = [
  {
    offerId: 'low-cost',
    vendorId: 'vendor-low',
    productId: 'BRG-6204',
    compatibleProductIds: ['BRG-6204'],
    unitPriceMinor: 42000,
    availableQuantity: 500,
    currency: 'INR',
    deliveryDays: 4,
    vendorApproved: true,
    shippingMinor: 500,
    taxMinor: 250,
    feesMinor: 350,
    qualityScore: 82,
    reliabilityScore: 88,
  },
  {
    offerId: 'fast',
    vendorId: 'vendor-fast',
    productId: 'BRG-6204',
    compatibleProductIds: ['BRG-6204'],
    unitPriceMinor: 46000,
    availableQuantity: 150,
    currency: 'INR',
    deliveryDays: 2,
    vendorApproved: true,
    shippingMinor: 800,
    taxMinor: 300,
    feesMinor: 400,
    qualityScore: 88,
    reliabilityScore: 90,
  },
  {
    offerId: 'insufficient-stock',
    vendorId: 'vendor-stock',
    productId: 'BRG-6204',
    compatibleProductIds: ['BRG-6204'],
    unitPriceMinor: 39000,
    availableQuantity: 25,
    currency: 'INR',
    deliveryDays: 3,
    vendorApproved: true,
    shippingMinor: 600,
    taxMinor: 200,
    feesMinor: 250,
    qualityScore: 70,
    reliabilityScore: 68,
  },
  {
    offerId: 'unapproved',
    vendorId: 'vendor-unapproved',
    productId: 'BRG-6204',
    compatibleProductIds: ['BRG-6204'],
    unitPriceMinor: 37500,
    availableQuantity: 200,
    currency: 'INR',
    deliveryDays: 3,
    vendorApproved: false,
    shippingMinor: 450,
    taxMinor: 180,
    feesMinor: 220,
    qualityScore: 75,
    reliabilityScore: 74,
  },
  {
    offerId: 'budget-breach',
    vendorId: 'vendor-budget',
    productId: 'BRG-6204',
    compatibleProductIds: ['BRG-6204'],
    unitPriceMinor: 99999,
    availableQuantity: 200,
    currency: 'INR',
    deliveryDays: 1,
    vendorApproved: true,
    shippingMinor: 1000,
    taxMinor: 500,
    feesMinor: 600,
    qualityScore: 97,
    reliabilityScore: 96,
  },
  {
    offerId: 'other-product',
    vendorId: 'vendor-other',
    productId: 'OTHER-ITEM',
    compatibleProductIds: ['OTHER-ITEM'],
    unitPriceMinor: 20000,
    availableQuantity: 300,
    currency: 'INR',
    deliveryDays: 2,
    vendorApproved: true,
    shippingMinor: 0,
    taxMinor: 0,
    feesMinor: 0,
    qualityScore: 80,
    reliabilityScore: 81,
  },
];

function cloneOffer(offer) {
  return {
    ...offer,
    compatibleProductIds: Array.isArray(offer.compatibleProductIds) ? [...offer.compatibleProductIds] : [],
  };
}

function createVendorService(customOffers = DEFAULT_VENDOR_OFFERS) {
  const catalog = (Array.isArray(customOffers) ? customOffers : DEFAULT_VENDOR_OFFERS).map((offer) => cloneOffer(offer));

  return {
    getCatalog() {
      return catalog.map(cloneOffer);
    },
    getOffersForRequest(request) {
      if (!request || typeof request.productId !== 'string') {
        return [];
      }

      return catalog
        .filter((offer) => {
          const requestedProduct = request.productId;
          const compatible = Array.isArray(offer.compatibleProductIds) && offer.compatibleProductIds.includes(requestedProduct);
          return offer.productId === requestedProduct || compatible;
        })
        .map(cloneOffer);
    },
  };
}

module.exports = {
  DEFAULT_VENDOR_OFFERS,
  createVendorService,
};
