'use strict';

const crypto = require('node:crypto');

/**
 * Workspace / tenant + membership + permission model (§7).
 */

const PERMISSIONS = Object.freeze([
  'workspace:read', 'workspace:manage',
  'members:read', 'members:invite', 'members:manage',
  'vendors:read', 'vendors:import', 'vendors:manage',
  'purchases:create', 'purchases:read', 'purchases:approve',
  'audit:read',
  'gmail:connect', 'gmail:use', 'gmail:disconnect',
  'business_email:verify',
]);

const ROLES = Object.freeze({
  owner: [...PERMISSIONS],
  admin: [
    'workspace:read', 'workspace:manage',
    'members:read', 'members:invite', 'members:manage',
    'vendors:read', 'vendors:import', 'vendors:manage',
    'purchases:create', 'purchases:read', 'purchases:approve',
    'audit:read',
    'gmail:connect', 'gmail:use', 'gmail:disconnect',
    'business_email:verify',
  ],
  purchaser: ['workspace:read', 'vendors:read', 'purchases:create', 'purchases:read'],
  approver: ['workspace:read', 'vendors:read', 'purchases:read', 'purchases:approve', 'audit:read'],
  auditor: ['workspace:read', 'vendors:read', 'purchases:read', 'audit:read'],
});

function permissionsForRole(role) {
  return ROLES[role] ? [...ROLES[role]] : [];
}

function createTenantService({ tenantCollection = null, membershipCollection = null } = {}) {
  const tenants = new Map(); // tenantId -> tenant
  const memberships = new Map(); // `${tenantId}:${userId}` -> membership

  function clone(v) { return v ? JSON.parse(JSON.stringify(v)) : null; }
  function membershipKey(tenantId, userId) { return `${tenantId}:${userId}`; }

  async function createTenant({ businessName, createdByUserId = null, businessEmail = '' }) {
    if (!businessName || typeof businessName !== 'string' || !businessName.trim()) {
      throw new Error('businessName is required.');
    }
    const now = new Date().toISOString();
    const tenant = {
      tenantId: `tenant_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      businessName: businessName.trim(),
      businessEmail: businessEmail || '',
      businessEmailVerifiedAt: null,
      businessEmailVerifiedByUserId: null,
      businessEmailVerificationMethod: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      createdByUserId,
    };
    if (tenantCollection) {
      await tenantCollection.insertOne({ ...tenant });
    } else {
      tenants.set(tenant.tenantId, { ...tenant });
    }
    return clone(tenant);
  }

  async function getTenant(tenantId) {
    if (!tenantId) return null;
    if (tenantCollection) {
      const doc = await tenantCollection.findOne({ tenantId });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return clone(rest);
    }
    return clone(tenants.get(tenantId) || null);
  }

  async function updateTenant(tenantId, patch) {
    const current = await getTenant(tenantId);
    if (!current) return null;
    const allowed = {};
    if (patch.businessName !== undefined) {
      if (typeof patch.businessName !== 'string' || !patch.businessName.trim()) throw new Error('businessName must be a non-empty string.');
      allowed.businessName = patch.businessName.trim();
    }
    if (patch.status !== undefined) {
      if (!['active', 'suspended'].includes(patch.status)) throw new Error('Invalid tenant status.');
      allowed.status = patch.status;
    }
    // businessEmail itself is updated only via verification flow; direct patch rejected
    allowed.updatedAt = new Date().toISOString();
    if (tenantCollection) {
      await tenantCollection.updateOne({ tenantId }, { $set: allowed });
      return getTenant(tenantId);
    }
    const next = { ...current, ...allowed };
    tenants.set(tenantId, { ...next });
    return clone(next);
  }

  async function setBusinessEmailVerified({ tenantId, businessEmail, verifiedByUserId, method }) {
    if (!tenantId || !businessEmail) throw new Error('tenantId and businessEmail are required.');
    const normalized = String(businessEmail).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('Invalid business email address.');
    const now = new Date().toISOString();
    const patch = {
      businessEmail: normalized,
      businessEmailVerifiedAt: now,
      businessEmailVerifiedByUserId: verifiedByUserId,
      businessEmailVerificationMethod: method,
      updatedAt: now,
    };
    if (tenantCollection) {
      await tenantCollection.updateOne({ tenantId }, { $set: patch });
      return getTenant(tenantId);
    }
    const current = tenants.get(tenantId);
    if (!current) return null;
    const next = { ...current, ...patch };
    tenants.set(tenantId, { ...next });
    return clone(next);
  }

  async function addMembership({ tenantId, userId, role = 'purchaser', status = 'active', invitedByUserId = null }) {
    if (!tenantId || !userId) throw new Error('tenantId and userId are required.');
    if (!ROLES[role]) throw new Error(`Unknown role: ${role}`);
    if (!['active', 'invited', 'disabled', 'removed'].includes(status)) throw new Error('Invalid membership status.');
    const tenant = await getTenant(tenantId);
    if (!tenant) throw new Error('Tenant not found.');
    const key = membershipKey(tenantId, userId);
    const now = new Date().toISOString();
    const membership = {
      membershipId: `membership_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      tenantId, userId, role,
      permissions: permissionsForRole(role),
      status,
      invitedByUserId,
      createdAt: now,
      updatedAt: now,
    };
    if (membershipCollection) {
      try {
        await membershipCollection.insertOne({ ...membership });
      } catch (err) {
        if (err && err.code === 11000) {
          const e = new Error('Membership already exists.');
          e.statusCode = 409;
          e.code = 'MEMBERSHIP_EXISTS';
          throw e;
        }
        throw err;
      }
      return clone(membership);
    }
    if (memberships.has(key)) {
      const e = new Error('Membership already exists.');
      e.statusCode = 409;
      e.code = 'MEMBERSHIP_EXISTS';
      throw e;
    }
    memberships.set(key, { ...membership });
    return clone(membership);
  }

  async function getMembership({ tenantId, userId }) {
    if (!tenantId || !userId) return null;
    if (membershipCollection) {
      const doc = await membershipCollection.findOne({ tenantId, userId });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return clone(rest);
    }
    return clone(memberships.get(membershipKey(tenantId, userId)) || null);
  }

  async function listMembershipsForUser(userId) {
    if (membershipCollection) {
      const docs = await membershipCollection.find({ userId, status: 'active' }).toArray();
      return docs.map((d) => { const { _id, ...rest } = d; return clone(rest); });
    }
    const out = [];
    for (const m of memberships.values()) {
      if (m.userId === userId && m.status === 'active') out.push(clone(m));
    }
    return out;
  }

  async function listMembershipsForTenant(tenantId) {
    if (membershipCollection) {
      const docs = await membershipCollection.find({ tenantId }).toArray();
      return docs.map((d) => { const { _id, ...rest } = d; return clone(rest); });
    }
    const out = [];
    for (const m of memberships.values()) {
      if (m.tenantId === tenantId) out.push(clone(m));
    }
    return out;
  }

  async function updateMembershipRole({ tenantId, userId, role }) {
    if (!ROLES[role]) throw new Error(`Unknown role: ${role}`);
    const current = await getMembership({ tenantId, userId });
    if (!current) return null;
    const patch = { role, permissions: permissionsForRole(role), updatedAt: new Date().toISOString() };
    if (membershipCollection) {
      await membershipCollection.updateOne({ tenantId, userId }, { $set: patch });
      return getMembership({ tenantId, userId });
    }
    const next = { ...current, ...patch };
    memberships.set(membershipKey(tenantId, userId), { ...next });
    return clone(next);
  }

  async function setMembershipStatus({ tenantId, userId, status }) {
    if (!['active', 'invited', 'disabled', 'removed'].includes(status)) throw new Error('Invalid membership status.');
    const current = await getMembership({ tenantId, userId });
    if (!current) return null;
    const patch = { status, updatedAt: new Date().toISOString() };
    if (membershipCollection) {
      await membershipCollection.updateOne({ tenantId, userId }, { $set: patch });
      return getMembership({ tenantId, userId });
    }
    const next = { ...current, ...patch };
    memberships.set(membershipKey(tenantId, userId), { ...next });
    return clone(next);
  }

  function hasPermission(membership, permission) {
    if (!membership || membership.status !== 'active') return false;
    return Array.isArray(membership.permissions) && membership.permissions.includes(permission);
  }

  async function ensureIndexes() {
    if (!tenantCollection || !membershipCollection) return;
    try {
      await tenantCollection.createIndex({ tenantId: 1 }, { unique: true });
      await membershipCollection.createIndex({ tenantId: 1, userId: 1 }, { unique: true });
      await membershipCollection.createIndex({ userId: 1, status: 1 });
    } catch { /* best-effort */ }
  }

  // Test seeding
  async function __seedTenant(t) {
    const entry = { ...(t || {}) };
    if (!entry.tenantId) entry.tenantId = `tenant_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    if (tenantCollection) await tenantCollection.insertOne({ ...entry });
    else tenants.set(entry.tenantId, { ...entry });
    return clone(entry);
  }
  async function __seedMembership(m) {
    const entry = { ...(m || {}) };
    if (!entry.membershipId) entry.membershipId = `membership_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    if (!entry.permissions && entry.role) entry.permissions = permissionsForRole(entry.role);
    if (membershipCollection) await membershipCollection.insertOne({ ...entry });
    else memberships.set(membershipKey(entry.tenantId, entry.userId), { ...entry });
    return clone(entry);
  }

  return {
    PERMISSIONS, ROLES, permissionsForRole,
    createTenant, getTenant, updateTenant, setBusinessEmailVerified,
    addMembership, getMembership, listMembershipsForUser, listMembershipsForTenant,
    updateMembershipRole, setMembershipStatus, hasPermission, ensureIndexes,
    __seedTenant, __seedMembership,
  };
}

module.exports = { createTenantService, PERMISSIONS, ROLES, permissionsForRole };
