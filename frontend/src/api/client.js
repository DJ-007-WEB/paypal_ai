const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api').replace(/\/$/, '');

async function parseBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function requestError(body, fallback, status) {
  const details = Array.isArray(body?.details)
    ? body.details.map((item) => item?.message || item?.field).filter(Boolean).join(' ')
    : '';
  const base = body?.error?.message || body?.message || `${fallback} (HTTP ${status}).`;
  return new Error([base, details].filter(Boolean).join(' '));
}

export async function evaluatePurchase(payload) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/purchases/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
  }
  const body = await parseBody(response);
  if (!response.ok || body.success === false) throw requestError(body, 'Purchase evaluation failed', response.status);
  return body.data;
}

export async function getPurchaseById(purchaseId) {
  const id = String(purchaseId || '').trim();
  if (!id) throw new Error('Enter a purchase ID to look up.');
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/purchases/${encodeURIComponent(id)}`);
  } catch {
    throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
  }
  const body = await parseBody(response);
  if (!response.ok || body.success === false) {
    if (response.status === 404) throw new Error('No purchase record was found for that ID. Records are held in memory and reset when the server restarts.');
    throw requestError(body, 'Purchase lookup failed', response.status);
  }
  return body.data;
}

export async function getHealth() {
  const response = await fetch(`${API_BASE_URL}/health`);
  if (!response.ok) throw new Error('API health check failed');
  return response.json();
}

export async function getVendors() {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/vendors`);
  } catch {
    throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
  }
  const body = await parseBody(response);
  if (!response.ok || body.success === false) throw requestError(body, 'Supplier catalog request failed', response.status);
  return Array.isArray(body.data) ? body.data : [];
}

export async function importVendors(offers) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/vendors/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offers }),
    });
  } catch {
    throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
  }
  const body = await parseBody(response);
  if (!response.ok || body.success === false) {
    throw requestError(body, 'Vendor import failed', response.status);
  }
  return body.data;
}

export { API_BASE_URL };
