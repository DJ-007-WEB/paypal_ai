const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api').replace(/\/$/, '');

const TENANT_KEY = 'mandate.selected.tenant.v1';
let cachedCsrfToken = null;

function getSelectedTenantId() {
  try { return localStorage.getItem(TENANT_KEY) || ''; } catch { return ''; }
}

export function setSelectedTenantId(tenantId) {
  try {
    if (tenantId) localStorage.setItem(TENANT_KEY, tenantId);
    else localStorage.removeItem(TENANT_KEY);
  } catch { /* ignore */ }
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  const tenantId = getSelectedTenantId();
  // Workspace selection is a request hint only; the server validates membership
  // before granting tenant context. Never treated as proof of ownership.
  if (tenantId) headers['X-Tenant-Id'] = tenantId;
  if (cachedCsrfToken) headers['X-CSRF-Token'] = cachedCsrfToken;
  return headers;
}

async function parseBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function requestError(body, fallback, status) {
  if (status === 401) {
    return new Error('Your session has expired. Please sign in again.');
  }
  if (status === 403) {
    return new Error(body?.error?.message || 'You do not have permission to perform this action.');
  }
  if (status === 429) {
    return new Error('Too many requests. Please wait a moment and retry.');
  }
  const details = Array.isArray(body?.error?.details)
    ? body.error.details.map((item) => item?.message || item?.field).filter(Boolean).join(' ')
    : Array.isArray(body?.details)
      ? body.details.map((item) => item?.message || item?.field).filter(Boolean).join(' ')
      : '';
  const base = body?.error?.message || body?.message || `${fallback} (HTTP ${status}).`;
  return new Error([base, details].filter(Boolean).join(' '));
}

async function apiFetch(path, { method = 'GET', body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: authHeaders({ ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
  }
  const parsed = await parseBody(response);
  if (!response.ok || parsed.success === false) throw requestError(parsed, 'Request failed', response.status);
  return parsed.data;
}

/* ---------- session / auth (API-validated, replaces local-storage authority) ---------- */

export function loginWithGoogle() {
  window.location.href = `${API_BASE_URL}/auth/google`;
}

export async function getSession() {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/auth/session`, { credentials: 'include' });
  } catch {
    throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
  }
  const body = await parseBody(response);
  if (!response.ok) throw requestError(body, 'Session check failed', response.status);
  if (body?.data?.authenticated && body.data.csrfToken) cachedCsrfToken = body.data.csrfToken;
  return body.data;
}

export async function getCsrfToken() {
  const data = await apiFetch('/auth/csrf');
  cachedCsrfToken = data.csrfToken;
  return data.csrfToken;
}

export async function logout() {
  if (!cachedCsrfToken) {
    try { await getCsrfToken(); } catch { /* session may already be invalid */ }
  }
  const data = await apiFetch('/auth/logout', { method: 'POST', body: {} });
  cachedCsrfToken = null;
  return data;
}

/* ---------- workspaces / verification status (read-only display) ---------- */

export async function getMyWorkspaces() {
  return apiFetch('/workspaces/me');
}

export async function getCurrentWorkspace() {
  return apiFetch('/workspaces/current');
}

export async function getBusinessEmailStatus(tenantId) {
  const id = encodeURIComponent(String(tenantId || getSelectedTenantId() || '').trim());
  if (!id) throw new Error('Select a workspace first.');
  return apiFetch(`/workspaces/${id}/business-email`);
}

export async function getGmailStatus() {
  return apiFetch('/integrations/google-gmail/status');
}

export function gmailConnectUrl() {
  return `${API_BASE_URL}/integrations/google-gmail/connect`;
}

/* ---------- existing business APIs (now authenticated + tenant-scoped) ---------- */

export async function evaluatePurchase(payload) {
  try {
    return await apiFetch('/purchases/evaluate', { method: 'POST', body: payload });
  } catch (err) {
    // Preserve the friendlier unreachable message for network failures
    if (String(err.message || '').includes('Could not reach')) throw err;
    throw err;
  }
}

export async function getPurchaseById(purchaseId) {
  const id = String(purchaseId || '').trim();
  if (!id) throw new Error('Enter a purchase ID to look up.');
  try {
    return await apiFetch(`/purchases/${encodeURIComponent(id)}`);
  } catch (err) {
    if (String(err.message || '').includes('expired')) throw err;
    if (err.message && err.message.toLowerCase().includes('not found')) {
      throw new Error('No purchase record was found for that ID in your workspace.');
    }
    throw err;
  }
}

export async function listPurchases(status) {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch(`/purchases${q}`);
}

export async function getHealth() {
  const response = await fetch(`${API_BASE_URL}/health`);
  if (!response.ok) throw new Error('API health check failed');
  return response.json();
}

export async function getVendors() {
  try {
    const data = await apiFetch('/vendors');
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (String(err.message || '').includes('Could not reach')) {
      throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
    }
    throw new Error(err.message || 'Supplier catalog request failed');
  }
}

export async function importVendors(offers, { importId } = {}) {
  try {
    return await apiFetch('/vendors/import', {
      method: 'POST',
      body: { offers, ...(importId ? { importId } : {}) },
      headers: importId ? { 'Idempotency-Key': importId } : {},
    });
  } catch (err) {
    if (String(err.message || '').includes('Could not reach')) {
      throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
    }
    throw err;
  }
}

export { API_BASE_URL };
