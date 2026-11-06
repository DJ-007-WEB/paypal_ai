// Currency minor-unit metadata must match the backend purchase decision engine.
// Amounts cross the API boundary as integer minor units; UI values are major units.
export const CURRENCY_EXPONENTS = Object.freeze({
  INR: 2, USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, CHF: 2, CNY: 2,
  SGD: 2, NZD: 2, HKD: 2, AED: 2, SAR: 2, BRL: 2, MXN: 2, ZAR: 2,
  JPY: 0, KRW: 0, VND: 0, CLP: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
});

export const SUPPORTED_CURRENCIES = Object.freeze(Object.keys(CURRENCY_EXPONENTS));

export function currencyExponent(currency) {
  return CURRENCY_EXPONENTS[String(currency || '').toUpperCase()] ?? 2;
}

export function majorToMinor(value, currency) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return NaN;
  return Math.round(amount * (10 ** currencyExponent(currency)));
}

export function minorToMajor(value, currency) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return NaN;
  return amount / (10 ** currencyExponent(currency));
}
