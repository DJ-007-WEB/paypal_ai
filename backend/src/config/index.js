'use strict';

/**
 * Central configuration module — §6 of the security implementation plan.
 *
 * - Parses and validates environment variables once at startup.
 * - Fails closed on unsafe production configuration.
 * - Never logs secrets; exposes only a sanitized object to app code.
 * - Never derives OAuth callback URLs from Host headers (exact allowlisted URIs only).
 */

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(v)) return true;
  if (['false', '0', 'no', 'n'].includes(v)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function parseIntBounded(raw, { fallback, min, max, name }) {
  if (raw === undefined || raw === null || raw === '') {
    if (fallback === undefined) throw new Error(`${name} is required.`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}. Got: ${raw}`);
  }
  return n;
}

function parseUrl(raw, { name, required = false, allowHttpLocalhost = true, requireHttpsInProd = true, isProd = false }) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (required) throw new Error(`${name} is required.`);
    return '';
  }
  const value = String(raw).trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL. Got: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use http or https. Got: ${value}`);
  }
  if (url.hash || url.username || url.password) {
    throw new Error(`${name} must not contain credentials or fragments. Got: ${value}`);
  }
  // Normalize: strip trailing slash (except root)
  const normalized = value.replace(/\/$/, '');
  if (isProd && requireHttpsInProd && url.protocol !== 'https:') {
    throw new Error(`${name} must use HTTPS in production. Got: ${value}`);
  }
  if (!allowHttpLocalhost && url.protocol === 'http:') {
    throw new Error(`${name} must use HTTPS. Got: ${value}`);
  }
  return normalized;
}

function parseOriginList(raw, { name, isProd }) {
  const fallbackDev = 'http://localhost:5173,http://127.0.0.1:5173';
  const value = raw === undefined || raw === null || String(raw).trim() === '' ? fallbackDev : String(raw).trim();
  const origins = value.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (origins.length === 0) throw new Error(`${name} must list at least one origin.`);
  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`${name} contains an invalid origin: ${origin}`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`${name} origins must be http(s). Got: ${origin}`);
    }
    if (url.pathname !== '/' && url.pathname !== '') {
      throw new Error(`${name} must contain origins only (no paths). Got: ${origin}`);
    }
    if (origin.includes('*')) throw new Error(`${name} must not contain wildcards. Got: ${origin}`);
    if (isProd && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')) {
      throw new Error(`${name} must not use localhost defaults in production.`);
    }
    if (isProd && url.protocol !== 'https:') {
      throw new Error(`${name} must use HTTPS origins in production. Got: ${origin}`);
    }
  }
  // Deduplicate preserving order
  return [...new Set(origins)];
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const SAME_SITES = ['lax', 'strict', 'none'];
const GMAIL_SENSITIVE_SCOPE_FRAGMENTS = ['gmail', 'mail.google', 'googleapis.com/auth/gmail', 'googleapis.com/auth/drive', 'send', 'compose', 'modify'];

function validateOidcScopes(scopesRaw) {
  const scopes = String(scopesRaw || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
  for (const scope of scopes) {
    const lower = scope.toLowerCase();
    for (const frag of GMAIL_SENSITIVE_SCOPE_FRAGMENTS) {
      if (lower.includes(frag) && !['openid', 'email', 'profile'].includes(lower)) {
        throw new Error(`GOOGLE_OIDC_SCOPES must contain identity scopes only; mailbox scope detected: ${scope}`);
      }
    }
  }
  if (!scopes.includes('openid')) {
    throw new Error('GOOGLE_OIDC_SCOPES must include "openid".');
  }
  return scopes.join(' ');
}

function loadConfig(env = process.env) {
  const NODE_ENV = String(env.NODE_ENV || 'development').trim();
  if (!['development', 'test', 'production'].includes(NODE_ENV)) {
    throw new Error(`NODE_ENV must be development, test, or production. Got: ${NODE_ENV}`);
  }
  const isProd = NODE_ENV === 'production';
  const isTest = NODE_ENV === 'test';

  const PORT = parseIntBounded(env.PORT, { fallback: 3000, min: 1, max: 65535, name: 'PORT' });
  const MONGODB_URI = env.MONGODB_URI ? String(env.MONGODB_URI).trim() : '';
  const MONGODB_DB_NAME = env.MONGODB_DB_NAME ? String(env.MONGODB_DB_NAME).trim() : 'mandate';
  if (isProd && !MONGODB_URI) throw new Error('MONGODB_URI is required in production.');
  if (!MONGODB_DB_NAME) throw new Error('MONGODB_DB_NAME must be a non-empty database name.');
  if (isProd && !env.MONGODB_DB_NAME) throw new Error('MONGODB_DB_NAME must be set explicitly in production.');

  const FRONTEND_ORIGIN = parseOriginList(env.FRONTEND_ORIGIN, { name: 'FRONTEND_ORIGIN', isProd });
  const APP_BASE_URL = parseUrl(env.APP_BASE_URL || (isProd ? '' : 'http://localhost:3000'), {
    name: 'APP_BASE_URL', required: isProd, isProd,
  });
  const FRONTEND_BASE_URL = parseUrl(env.FRONTEND_BASE_URL || (isProd ? '' : FRONTEND_ORIGIN[0]), {
    name: 'FRONTEND_BASE_URL', required: isProd, isProd,
  });

  const TRUST_PROXY_RAW = env.TRUST_PROXY === undefined || env.TRUST_PROXY === '' ? 'false' : String(env.TRUST_PROXY).trim();
  let TRUST_PROXY = false;
  if (['false', '0'].includes(TRUST_PROXY_RAW.toLowerCase())) TRUST_PROXY = false;
  else if (['true', '1'].includes(TRUST_PROXY_RAW.toLowerCase())) {
    if (isProd) throw new Error('TRUST_PROXY must never blindly trust all proxies in production. Set an explicit hop count or CIDR.');
    TRUST_PROXY = true;
  } else if (/^\d+$/.test(TRUST_PROXY_RAW)) {
    TRUST_PROXY = Number(TRUST_PROXY_RAW);
  } else {
    // Allow loopback / explicit CIDR / IP list string passthrough
    TRUST_PROXY = TRUST_PROXY_RAW;
  }

  // --- Session ---
  const SESSION_SECRET = env.SESSION_SECRET ? String(env.SESSION_SECRET) : '';
  if (isProd && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
    throw new Error('SESSION_SECRET must be a cryptographically random value of at least 32 characters in production.');
  }
  if (!isProd && SESSION_SECRET && SESSION_SECRET.length < 16) {
    throw new Error('SESSION_SECRET must be at least 16 characters when set (use 32+ in production).');
  }
  const SESSION_COOKIE_NAME = env.SESSION_COOKIE_NAME ? String(env.SESSION_COOKIE_NAME).trim() : 'mandate.sid';
  if (!SESSION_COOKIE_NAME || /\s|;|,/.test(SESSION_COOKIE_NAME)) {
    throw new Error('SESSION_COOKIE_NAME must be a valid cookie name without spaces, semicolons, or commas.');
  }
  const SESSION_IDLE_TIMEOUT_SECONDS = parseIntBounded(env.SESSION_IDLE_TIMEOUT_SECONDS, { fallback: 1800, min: 60, max: 86400, name: 'SESSION_IDLE_TIMEOUT_SECONDS' });
  const SESSION_ABSOLUTE_TIMEOUT_SECONDS = parseIntBounded(env.SESSION_ABSOLUTE_TIMEOUT_SECONDS, { fallback: 28800, min: 300, max: 2592000, name: 'SESSION_ABSOLUTE_TIMEOUT_SECONDS' });
  if (SESSION_IDLE_TIMEOUT_SECONDS > SESSION_ABSOLUTE_TIMEOUT_SECONDS) {
    throw new Error('SESSION_IDLE_TIMEOUT_SECONDS must not exceed SESSION_ABSOLUTE_TIMEOUT_SECONDS.');
  }
  const SESSION_COOKIE_SECURE = parseBool(env.SESSION_COOKIE_SECURE, isProd ? true : false);
  if (isProd && !SESSION_COOKIE_SECURE) {
    throw new Error('SESSION_COOKIE_SECURE must be true in production HTTPS deployments.');
  }
  const SESSION_COOKIE_SAME_SITE = String(env.SESSION_COOKIE_SAME_SITE || 'lax').trim().toLowerCase();
  if (!SAME_SITES.includes(SESSION_COOKIE_SAME_SITE)) {
    throw new Error(`SESSION_COOKIE_SAME_SITE must be one of ${SAME_SITES.join(', ')}.`);
  }
  if (SESSION_COOKIE_SAME_SITE === 'none' && !SESSION_COOKIE_SECURE) {
    throw new Error('SESSION_COOKIE_SAME_SITE=none requires SESSION_COOKIE_SECURE=true.');
  }
  const SESSION_COOKIE_DOMAIN = env.SESSION_COOKIE_DOMAIN ? String(env.SESSION_COOKIE_DOMAIN).trim() : '';
  if (SESSION_COOKIE_NAME.startsWith('__Host-')) {
    if (!SESSION_COOKIE_SECURE) throw new Error('__Host- cookies require SESSION_COOKIE_SECURE=true.');
    if (SESSION_COOKIE_DOMAIN) throw new Error('__Host- cookies must not set SESSION_COOKIE_DOMAIN (host-only required).');
  }

  // --- Google OIDC (sign-in) ---
  const GOOGLE_OIDC_ENABLED = parseBool(env.GOOGLE_OIDC_ENABLED, false);
  const GOOGLE_OIDC_CLIENT_ID = env.GOOGLE_OIDC_CLIENT_ID ? String(env.GOOGLE_OIDC_CLIENT_ID).trim() : '';
  const GOOGLE_OIDC_CLIENT_SECRET = env.GOOGLE_OIDC_CLIENT_SECRET ? String(env.GOOGLE_OIDC_CLIENT_SECRET) : '';
  const GOOGLE_OIDC_REDIRECT_URI = env.GOOGLE_OIDC_REDIRECT_URI
    ? String(env.GOOGLE_OIDC_REDIRECT_URI).trim()
    : (isProd ? '' : 'http://localhost:3000/api/auth/google/callback');
  const GOOGLE_OIDC_ISSUER = env.GOOGLE_OIDC_ISSUER ? String(env.GOOGLE_OIDC_ISSUER).trim() : 'https://accounts.google.com';
  const GOOGLE_OIDC_SCOPES = validateOidcScopes(env.GOOGLE_OIDC_SCOPES || 'openid email profile');
  if (GOOGLE_OIDC_ENABLED) {
    if (!GOOGLE_OIDC_CLIENT_ID) throw new Error('GOOGLE_OIDC_CLIENT_ID is required when GOOGLE_OIDC_ENABLED=true.');
    if (!GOOGLE_OIDC_CLIENT_SECRET) throw new Error('GOOGLE_OIDC_CLIENT_SECRET is required when GOOGLE_OIDC_ENABLED=true.');
    if (!GOOGLE_OIDC_REDIRECT_URI) throw new Error('GOOGLE_OIDC_REDIRECT_URI is required when GOOGLE_OIDC_ENABLED=true.');
    parseUrl(GOOGLE_OIDC_REDIRECT_URI, { name: 'GOOGLE_OIDC_REDIRECT_URI', required: true, isProd });
    if (!GOOGLE_OIDC_ISSUER.startsWith('https://')) throw new Error('GOOGLE_OIDC_ISSUER must be an https URL.');
  } else if (GOOGLE_OIDC_REDIRECT_URI) {
    // Validate shape even when disabled so misconfiguration is caught early
    try {
      parseUrl(GOOGLE_OIDC_REDIRECT_URI, { name: 'GOOGLE_OIDC_REDIRECT_URI', required: false, isProd });
    } catch (err) {
      throw err;
    }
  }

  // --- Gmail mailbox connection (separate from login) ---
  const GOOGLE_GMAIL_ENABLED = parseBool(env.GOOGLE_GMAIL_ENABLED, false);
  const GOOGLE_GMAIL_CLIENT_ID = env.GOOGLE_GMAIL_CLIENT_ID ? String(env.GOOGLE_GMAIL_CLIENT_ID).trim() : '';
  const GOOGLE_GMAIL_CLIENT_SECRET = env.GOOGLE_GMAIL_CLIENT_SECRET ? String(env.GOOGLE_GMAIL_CLIENT_SECRET) : '';
  const GOOGLE_GMAIL_REDIRECT_URI = env.GOOGLE_GMAIL_REDIRECT_URI
    ? String(env.GOOGLE_GMAIL_REDIRECT_URI).trim()
    : (isProd ? '' : 'http://localhost:3000/api/integrations/google-gmail/callback');
  const GOOGLE_GMAIL_SCOPES = env.GOOGLE_GMAIL_SCOPES ? String(env.GOOGLE_GMAIL_SCOPES).trim() : '';
  if (GOOGLE_GMAIL_ENABLED) {
    if (!GOOGLE_GMAIL_CLIENT_ID) throw new Error('GOOGLE_GMAIL_CLIENT_ID is required when GOOGLE_GMAIL_ENABLED=true.');
    if (!GOOGLE_GMAIL_CLIENT_SECRET) throw new Error('GOOGLE_GMAIL_CLIENT_SECRET is required when GOOGLE_GMAIL_ENABLED=true.');
    if (!GOOGLE_GMAIL_REDIRECT_URI) throw new Error('GOOGLE_GMAIL_REDIRECT_URI is required when GOOGLE_GMAIL_ENABLED=true.');
    parseUrl(GOOGLE_GMAIL_REDIRECT_URI, { name: 'GOOGLE_GMAIL_REDIRECT_URI', required: true, isProd });
    if (!GOOGLE_GMAIL_SCOPES) {
      throw new Error('GOOGLE_GMAIL_SCOPES must list the narrowest approved scopes when GOOGLE_GMAIL_ENABLED=true (never leave empty when enabled).');
    }
  }

  // --- Encryption ---
  const TOKEN_ENCRYPTION_KEY = env.TOKEN_ENCRYPTION_KEY ? String(env.TOKEN_ENCRYPTION_KEY).trim() : '';
  const KMS_KEY_ID = env.KMS_KEY_ID ? String(env.KMS_KEY_ID).trim() : '';
  if (TOKEN_ENCRYPTION_KEY) {
    // Require base64-encoded 32 bytes (44 chars) or 64-char hex
    const isBase64_32 = (() => {
      try {
        const buf = Buffer.from(TOKEN_ENCRYPTION_KEY, 'base64');
        return buf.length === 32 && Buffer.from(buf.toString('base64'), 'base64').length === 32;
      } catch { return false; }
    })();
    const isHex64 = /^[0-9a-fA-F]{64}$/.test(TOKEN_ENCRYPTION_KEY);
    if (!isBase64_32 && !isHex64) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key or 64-char hex when set. Prefer managed KMS in production.');
    }
  }
  if (isProd && GOOGLE_GMAIL_ENABLED && !TOKEN_ENCRYPTION_KEY && !KMS_KEY_ID) {
    throw new Error('Token encryption (TOKEN_ENCRYPTION_KEY or KMS_KEY_ID) is required in production when GOOGLE_GMAIL_ENABLED=true.');
  }

  // --- Abuse protection / limits ---
  const RATE_LIMIT_WINDOW_MS = parseIntBounded(env.RATE_LIMIT_WINDOW_MS, { fallback: 60000, min: 1000, max: 3600000, name: 'RATE_LIMIT_WINDOW_MS' });
  const RATE_LIMIT_MAX_REQUESTS = parseIntBounded(env.RATE_LIMIT_MAX_REQUESTS, { fallback: 120, min: 1, max: 10000, name: 'RATE_LIMIT_MAX_REQUESTS' });
  const AUTH_RATE_LIMIT_MAX_REQUESTS = parseIntBounded(env.AUTH_RATE_LIMIT_MAX_REQUESTS, { fallback: 10, min: 1, max: 1000, name: 'AUTH_RATE_LIMIT_MAX_REQUESTS' });
  const IMPORT_RATE_LIMIT_MAX_REQUESTS = parseIntBounded(env.IMPORT_RATE_LIMIT_MAX_REQUESTS, { fallback: 5, min: 1, max: 100, name: 'IMPORT_RATE_LIMIT_MAX_REQUESTS' });
  const MAX_JSON_BODY_BYTES = parseIntBounded(env.MAX_JSON_BODY_BYTES, { fallback: 1048576, min: 1024, max: 5242880, name: 'MAX_JSON_BODY_BYTES' });
  const MAX_IMPORT_ROWS = parseIntBounded(env.MAX_IMPORT_ROWS, { fallback: 2000, min: 1, max: 10000, name: 'MAX_IMPORT_ROWS' });

  const LOG_LEVEL = String(env.LOG_LEVEL || 'info').trim().toLowerCase();
  if (!LOG_LEVELS.includes(LOG_LEVEL)) throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`);
  const AUDIT_RETENTION_DAYS = parseIntBounded(env.AUDIT_RETENTION_DAYS, { fallback: 365, min: 1, max: 3650, name: 'AUDIT_RETENTION_DAYS' });
  const APP_ENV_LABEL = env.APP_ENV_LABEL ? String(env.APP_ENV_LABEL).trim() : 'local';

  const config = {
    NODE_ENV, isProd, isTest,
    PORT, MONGODB_URI, MONGODB_DB_NAME,
    FRONTEND_ORIGIN, APP_BASE_URL, FRONTEND_BASE_URL, TRUST_PROXY,
    SESSION_SECRET, SESSION_COOKIE_NAME,
    SESSION_IDLE_TIMEOUT_SECONDS, SESSION_ABSOLUTE_TIMEOUT_SECONDS,
    SESSION_COOKIE_SECURE, SESSION_COOKIE_SAME_SITE, SESSION_COOKIE_DOMAIN,
    GOOGLE_OIDC_ENABLED, GOOGLE_OIDC_CLIENT_ID, GOOGLE_OIDC_REDIRECT_URI,
    GOOGLE_OIDC_ISSUER, GOOGLE_OIDC_SCOPES,
    GOOGLE_GMAIL_ENABLED, GOOGLE_GMAIL_CLIENT_ID, GOOGLE_GMAIL_REDIRECT_URI, GOOGLE_GMAIL_SCOPES,
    TOKEN_ENCRYPTION_KEY, KMS_KEY_ID,
    RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS,
    AUTH_RATE_LIMIT_MAX_REQUESTS, IMPORT_RATE_LIMIT_MAX_REQUESTS,
    MAX_JSON_BODY_BYTES, MAX_IMPORT_ROWS,
    LOG_LEVEL, AUDIT_RETENTION_DAYS, APP_ENV_LABEL,
  };

  // Server-only secrets — never expose these outside config internals.
  const SECRETS = {
    SESSION_SECRET: config.SESSION_SECRET,
    GOOGLE_OIDC_CLIENT_SECRET,
    GOOGLE_GMAIL_CLIENT_SECRET,
    TOKEN_ENCRYPTION_KEY: config.TOKEN_ENCRYPTION_KEY,
    MONGODB_URI: config.MONGODB_URI,
  };

  function getSecrets() {
    return { ...SECRETS };
  }

  function getSanitizedConfig() {
    return {
      NODE_ENV: config.NODE_ENV,
      PORT: config.PORT,
      MONGODB_DB_NAME: config.MONGODB_DB_NAME,
      MONGODB_CONFIGURED: Boolean(config.MONGODB_URI),
      FRONTEND_ORIGIN: [...config.FRONTEND_ORIGIN],
      APP_BASE_URL: config.APP_BASE_URL,
      FRONTEND_BASE_URL: config.FRONTEND_BASE_URL,
      SESSION_COOKIE_NAME: config.SESSION_COOKIE_NAME,
      SESSION_IDLE_TIMEOUT_SECONDS: config.SESSION_IDLE_TIMEOUT_SECONDS,
      SESSION_ABSOLUTE_TIMEOUT_SECONDS: config.SESSION_ABSOLUTE_TIMEOUT_SECONDS,
      SESSION_COOKIE_SECURE: config.SESSION_COOKIE_SECURE,
      SESSION_COOKIE_SAME_SITE: config.SESSION_COOKIE_SAME_SITE,
      SESSION_COOKIE_DOMAIN_SET: Boolean(config.SESSION_COOKIE_DOMAIN),
      GOOGLE_OIDC_ENABLED: config.GOOGLE_OIDC_ENABLED,
      GOOGLE_OIDC_REDIRECT_URI: config.GOOGLE_OIDC_REDIRECT_URI,
      GOOGLE_OIDC_ISSUER: config.GOOGLE_OIDC_ISSUER,
      GOOGLE_OIDC_SCOPES: config.GOOGLE_OIDC_SCOPES,
      GOOGLE_GMAIL_ENABLED: config.GOOGLE_GMAIL_ENABLED,
      GOOGLE_GMAIL_REDIRECT_URI: config.GOOGLE_GMAIL_REDIRECT_URI,
      GOOGLE_GMAIL_SCOPES_SET: Boolean(config.GOOGLE_GMAIL_SCOPES),
      KMS_CONFIGURED: Boolean(config.KMS_KEY_ID),
      TOKEN_ENCRYPTION_CONFIGURED: Boolean(config.TOKEN_ENCRYPTION_KEY || config.KMS_KEY_ID),
      RATE_LIMIT_WINDOW_MS: config.RATE_LIMIT_WINDOW_MS,
      RATE_LIMIT_MAX_REQUESTS: config.RATE_LIMIT_MAX_REQUESTS,
      AUTH_RATE_LIMIT_MAX_REQUESTS: config.AUTH_RATE_LIMIT_MAX_REQUESTS,
      IMPORT_RATE_LIMIT_MAX_REQUESTS: config.IMPORT_RATE_LIMIT_MAX_REQUESTS,
      MAX_JSON_BODY_BYTES: config.MAX_JSON_BODY_BYTES,
      MAX_IMPORT_ROWS: config.MAX_IMPORT_ROWS,
      LOG_LEVEL: config.LOG_LEVEL,
      AUDIT_RETENTION_DAYS: config.AUDIT_RETENTION_DAYS,
      APP_ENV_LABEL: config.APP_ENV_LABEL,
    };
  }

  function getIntegrationStatus() {
    return {
      oidc: config.GOOGLE_OIDC_ENABLED ? 'enabled' : 'disabled',
      gmail: config.GOOGLE_GMAIL_ENABLED ? 'enabled' : 'disabled',
      sessionStore: 'server-side',
      tokenEncryption: config.KMS_KEY_ID ? 'kms' : (config.TOKEN_ENCRYPTION_KEY ? 'local-key' : 'not-configured'),
    };
  }

  return { ...config, getSecrets, getSanitizedConfig, getIntegrationStatus };
}

let cached = null;
function getConfig(env) {
  if (env) return loadConfig(env);
  if (!cached) cached = loadConfig(process.env);
  return cached;
}

function resetConfigCache() {
  cached = null;
}

module.exports = { loadConfig, getConfig, resetConfigCache };
