// Auth uses host-only session cookies and CSRF tokens, so browser requests must
// stay on the same origin. Vercel and the Vite dev server both proxy `/api`.
const API_BASE_URL = '/api';

const TENANT_KEY = 'mandate.selected.tenant.v1';
let cachedCsrfToken = null;
let csrfRequest = null;

// Bound every browser-to-API request. A sleeping Render instance or stalled
// upstream must produce a visible retryable error instead of an endless spinner.
const API_TIMEOUT_MS = 10000;
async function withApiTimeout(operation, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Keep the timer active until the response body has also been consumed.
    return await operation(controller.signal);
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error(`The API did not respond within ${Math.round(timeoutMs / 1000)} seconds. The service may be waking up; please retry.`);
      timeout.code = 'API_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
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
  const requestId = body?.error?.requestId || body?.meta?.requestId || '';
  const error = new Error([base, details, requestId ? `Reference: ${requestId}` : ''].filter(Boolean).join(' '));
  error.code = body?.error?.code || null;
  error.requestId = requestId || null;
  error.status = status;
  return error;
}

async function refreshCsrfToken() {
  if (csrfRequest) return csrfRequest;
  csrfRequest = (async () => {
    const { response, body } = await withApiTimeout(async (signal) => {
      const response = await fetch(`${API_BASE_URL}/auth/csrf`, { credentials: 'include', signal });
      return { response, body: await parseBody(response) };
    });
    if (!response.ok || !body?.data?.csrfToken) {
      throw requestError(body, 'Could not obtain a CSRF token', response.status);
    }
    cachedCsrfToken = body.data.csrfToken;
    return cachedCsrfToken;
  })();
  try {
    return await csrfRequest;
  } finally {
    csrfRequest = null;
  }
}

async function rawRequest(path, { method = 'GET', body, headers = {} } = {}) {
  const methodUpper = String(method).toUpperCase();
  const hasBody = body !== undefined && body !== null;
  const payload = hasBody
    ? (typeof body === 'string' ? body : JSON.stringify(body))
    : undefined;
  const requestHeaders = authHeaders({
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  });

  let response;
  // AI provider calls have a documented 20-second backend timeout; allow a
  // small transport margin while keeping ordinary API calls tightly bounded.
  const timeoutMs = path === '/purchases/interpret' || /\/purchases\/[^/]+\/explain$/.test(path)
    ? 55000
    : API_TIMEOUT_MS;
  try {
    const result = await withApiTimeout(async (signal) => {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: methodUpper,
        credentials: 'include',
        headers: requestHeaders,
        body: payload,
        signal,
      });
      return { response, parsed: await parseBody(response) };
    }, timeoutMs);
    return result;
  } catch (error) {
    if (error?.code === 'API_TIMEOUT') throw error;
    throw new Error(`Could not reach the Mandate API at ${API_BASE_URL}. Check that the backend is running.`);
  }
}

async function apiFetch(path, { method = 'GET', body, headers = {} } = {}) {
  const methodUpper = String(method).toUpperCase();
  const stateChanging = !['GET', 'HEAD', 'OPTIONS'].includes(methodUpper);
  if (stateChanging && !cachedCsrfToken) {
    try { await refreshCsrfToken(); } catch { /* the request will fail closed if CSRF is required */ }
  }

  let { response, parsed } = await rawRequest(path, { method, body, headers });

  // A session can rotate the CSRF token; refresh once and retry a rejected write.
  if (stateChanging && response.status === 403 && parsed?.error?.code === 'CSRF_INVALID') {
    try {
      await refreshCsrfToken();
      ({ response, parsed } = await rawRequest(path, { method, body, headers }));
    } catch { /* fall through to original error */ }
  }

  if (!response.ok || parsed.success === false) throw requestError(parsed, 'Request failed', response.status);
  return parsed.data;
}

/* ---------- session / auth ---------- */

export function loginWithGoogle() {
  // Always start OAuth on the browser-facing origin. The mandate.oauth_tx
  // cookie is host-only, so starting at the Render API host would make the
  // Vercel callback unable to read it.
  window.location.href = '/api/auth/google';
}

async function submitPasswordAuth(path, body) {
  const { response, parsed } = await rawRequest(path, { method: 'POST', body });
  if (!response.ok || parsed.success === false) {
    if (response.status === 401) {
      throw new Error(parsed?.error?.message || 'Email or password is incorrect.');
    }
    if (response.status === 409) {
      throw new Error(parsed?.error?.message || 'An account with this email already exists.');
    }
    throw requestError(parsed, 'Authentication failed', response.status);
  }
  if (parsed?.data?.csrfToken) cachedCsrfToken = parsed.data.csrfToken;
  // Never carry a previous account's workspace selection into a new session.
  setSelectedTenantId('');
  return parsed.data;
}

export async function loginWithPassword(email, password) {
  return submitPasswordAuth('/auth/login', { email, password });
}

export async function registerWithPassword({ email, password, displayName, businessName }) {
  return submitPasswordAuth('/auth/register', { email, password, displayName, businessName });
}

export async function getSession() {
  const { response, parsed } = await rawRequest('/auth/session');
  if (!response.ok) throw requestError(parsed, 'Session check failed', response.status);
  if (parsed?.data?.authenticated && parsed.data.csrfToken) cachedCsrfToken = parsed.data.csrfToken;
  return parsed.data;
}

export async function getCsrfToken() {
  return refreshCsrfToken();
}

export async function logout() {
  if (!cachedCsrfToken) {
    try { await refreshCsrfToken(); } catch { /* session may already be invalid */ }
  }
  const data = await apiFetch('/auth/logout', { method: 'POST', body: {} });
  cachedCsrfToken = null;
  return data;
}

/* ---------- workspaces / verification status ---------- */

export async function getMyWorkspaces() {
  return apiFetch('/workspaces/me');
}

export async function ensureMyWorkspace() {
  return apiFetch('/workspaces/ensure', { method: 'POST', body: {} });
}

export async function getCurrentWorkspace() {
  return apiFetch('/workspaces/current');
}

export async function getBusinessEmailStatus(tenantId) {
  const id = encodeURIComponent(String(tenantId || getSelectedTenantId() || '').trim());
  if (!id) throw new Error('Select a workspace first.');
  return apiFetch(`/workspaces/${id}/business-email`);
}

export async function verifyBusinessEmail(tenantId, businessEmail) {
  const id = encodeURIComponent(String(tenantId || getSelectedTenantId() || '').trim());
  if (!id) throw new Error('Select a workspace first.');
  return apiFetch(`/workspaces/${id}/business-email/verify`, { method: 'POST', body: { businessEmail } });
}

export async function listWorkspaceMembers(tenantId) {
  const id = encodeURIComponent(String(tenantId || getSelectedTenantId() || '').trim());
  if (!id) throw new Error('Select a workspace first.');
  const data = await apiFetch(`/workspaces/${id}/members`);
  return Array.isArray(data?.members) ? data.members : [];
}

export async function inviteWorkspaceMember(tenantId, { email, userId, role }) {
  const id = encodeURIComponent(String(tenantId || getSelectedTenantId() || '').trim());
  if (!id) throw new Error('Select a workspace first.');
  return apiFetch(`/workspaces/${id}/members`, { method: 'POST', body: { email, userId, role } });
}

export async function getInvitations() {
  const data = await apiFetch('/workspaces/invitations');
  return Array.isArray(data?.invitations) ? data.invitations : [];
}

export async function acceptInvitation(tenantId) {
  const id = encodeURIComponent(String(tenantId || '').trim());
  if (!id) throw new Error('An invitation is required.');
  return apiFetch(`/workspaces/${id}/members/accept`, { method: 'POST', body: {} });
}

export async function updateWorkspace(tenantId, patch) {
  const id = encodeURIComponent(String(tenantId || '').trim());
  if (!id) throw new Error('Select a workspace first.');
  return apiFetch(`/workspaces/${id}`, { method: 'PATCH', body: patch });
}

export async function getGmailStatus() {
  return apiFetch('/integrations/google-gmail/status');
}

export function gmailConnectUrl() {
  return `${API_BASE_URL}/integrations/google-gmail/connect`;
}

export async function disconnectGmail() {
  return apiFetch('/integrations/google-gmail/disconnect', { method: 'POST', body: {} });
}

/* ---------- purchases / approvals / audit ---------- */

export async function evaluatePurchase(payload) {
  return apiFetch('/purchases/evaluate', { method: 'POST', body: payload });
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

export async function listPendingApprovals() {
  return apiFetch('/approvals/pending');
}

export async function decidePurchase(purchaseId, action, rationale = '') {
  const id = encodeURIComponent(String(purchaseId || '').trim());
  if (!id) throw new Error('A purchase ID is required.');
  if (action !== 'approve' && action !== 'reject') throw new Error('Invalid approval action.');
  return apiFetch(`/approvals/purchase/${id}/${action}`, { method: 'POST', body: { rationale } });
}

export async function getAiStatus() {
  return apiFetch('/integrations/ai/status');
}

export async function interpretPurchaseRequest({ text, defaults }) {
  return apiFetch('/purchases/interpret', { method: 'POST', body: { text, defaults } });
}

export async function explainPurchase(purchaseId) {
  const id = String(purchaseId || '').trim();
  if (!id) throw new Error('A stored purchase ID is required for an AI explanation.');
  return apiFetch(`/purchases/${encodeURIComponent(id)}/explain`, { method: 'POST', body: {} });
}

export async function listAuditEvents() {
  const data = await apiFetch('/audit/events');
  return Array.isArray(data) ? data : [];
}

export async function getHealth() {
  const result = await withApiTimeout(async (signal) => {
    const response = await fetch(`${API_BASE_URL}/health`, { signal });
    const body = await parseBody(response);
    return { response, body };
  }, 8000);
  if (!result.response.ok) throw new Error('API health check failed');
  return result.body;
}

/* ---------- Vendors ---------- */

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
  return apiFetch('/vendors/import', {
    method: 'POST',
    body: { offers, ...(importId ? { importId } : {}) },
    headers: importId ? { 'Idempotency-Key': importId } : {},
  });
}

/* ---------- PayPal Sandbox checkout ---------- */

export async function createPaypalOrder(purchaseId) {
  const id = encodeURIComponent(String(purchaseId || '').trim());
  if (!id) throw new Error('A purchase ID is required.');
  const data = await apiFetch(`/payments/create/${id}`, { method: 'POST', body: {} });
  if (!data?.approvalUrl) {
    throw new Error('PayPal did not return an approval URL. No payment was started.');
  }
  return data;
}

export async function capturePaypalOrder(purchaseId, orderId) {
  const id = encodeURIComponent(String(purchaseId || '').trim());
  if (!id) throw new Error('A purchase ID is required.');
  if (!orderId) throw new Error('The PayPal order ID is required to capture payment.');
  return apiFetch(`/payments/capture/${id}`, { method: 'POST', body: { orderId } });
}

export async function cancelPaypalOrder(purchaseId) {
  const id = encodeURIComponent(String(purchaseId || '').trim());
  if (!id) throw new Error('A purchase ID is required.');
  return apiFetch(`/payments/cancel/${id}`, { method: 'POST', body: {} });
}

export async function getPaypalStatus(purchaseId) {
  const id = encodeURIComponent(String(purchaseId || '').trim());
  if (!id) throw new Error('A purchase ID is required.');
  return apiFetch(`/payments/status/${id}`);
}

export { API_BASE_URL };
