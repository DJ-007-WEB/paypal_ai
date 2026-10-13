const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api').replace(/\/$/, '');

export async function evaluatePurchase(payload) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/purchases/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch {
    throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.error?.message || body.message || `Request failed (HTTP ${response.status}).`);
  return body.data;
}

export async function getHealth() {
  const response = await fetch(`${API_BASE_URL}/health`);
  if (!response.ok) throw new Error('API health check failed');
  return response.json();
}
