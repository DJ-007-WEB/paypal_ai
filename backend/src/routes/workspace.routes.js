'use strict';

/**
 * Workspace / membership routes (§7, §8).
 * All routes require authentication; tenant-specific routes verify active
 * membership for the requested tenantId path param (404 generic to avoid
 * confirming existence of foreign tenants).
 */
function createWorkspaceRoutes({ tenantService, userService, auditService } = {}) {
  const express = require('express');
  const router = express.Router();

  function notFoundTenant() {
    const err = new Error('Workspace not found.');
    err.statusCode = 404;
    err.code = 'WORKSPACE_NOT_FOUND';
    return err;
  }

  async function requireMembership(req, tenantId) {
    const membership = await tenantService.getMembership({ tenantId, userId: req.user.userId });
    if (!membership || membership.status !== 'active') throw notFoundTenant();
    const tenant = await tenantService.getTenant(tenantId);
    if (!tenant || tenant.status !== 'active') throw notFoundTenant();
    return { membership, tenant };
  }

  function need(permission, membership) {
    if (!membership || membership.status !== 'active' || !(membership.permissions || []).includes(permission)) {
      const err = new Error('You do not have permission to perform this action.');
      err.statusCode = 403;
      err.code = 'FORBIDDEN';
      throw err;
    }
  }

  // List my memberships (for workspace selection UI)
  router.get('/workspaces/me', async (req, res, next) => {
    try {
      const memberships = await tenantService.listMembershipsForUser(req.user.userId);
      const tenants = [];
      for (const m of memberships) {
        const t = await tenantService.getTenant(m.tenantId);
        if (t) tenants.push({ tenantId: t.tenantId, businessName: t.businessName, businessEmail: t.businessEmail, businessEmailVerifiedAt: t.businessEmailVerifiedAt, role: m.role, permissions: m.permissions });
      }
      return res.json({ success: true, data: { memberships: tenants } });
    } catch (err) { next(err); }
  });

  // Current workspace (requires resolved tenant context)
  router.get('/workspaces/current', async (req, res, next) => {
    try {
      if (!req.auth || !req.auth.tenantId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      const tenant = await tenantService.getTenant(req.auth.tenantId);
      if (!tenant) throw notFoundTenant();
      return res.json({ success: true, data: { tenant, membership: req.membership, permissions: req.auth.permissions } });
    } catch (err) { next(err); }
  });

  // Create a new workspace — creator becomes owner (safe: new tenant, not existing).
  router.post('/workspaces', async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const businessName = typeof body.businessName === 'string' ? body.businessName.trim() : '';
      if (!businessName) {
        const err = new Error('businessName is required.');
        err.statusCode = 400;
        err.code = 'VALIDATION_ERROR';
        err.details = [{ field: 'businessName', message: 'A non-empty business name is required.' }];
        throw err;
      }
      if (businessName.length > 200) {
        const err = new Error('businessName is too long.');
        err.statusCode = 400;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      const tenant = await tenantService.createTenant({ businessName, createdByUserId: req.user.userId });
      const membership = await tenantService.addMembership({ tenantId: tenant.tenantId, userId: req.user.userId, role: 'owner', status: 'active', invitedByUserId: req.user.userId });
      try {
        await auditService.recordEvent({ tenantId: tenant.tenantId, eventType: 'WORKSPACE_CREATED', actorId: req.user.userId, metadata: { businessName: tenant.businessName } });
      } catch { /* ignore */ }
      return res.status(201).json({ success: true, data: { tenant, membership } });
    } catch (err) { next(err); }
  });

  // Get workspace settings
  router.get('/workspaces/:tenantId', async (req, res, next) => {
    try {
      const { membership, tenant } = await requireMembership(req, req.params.tenantId);
      need('workspace:read', membership);
      return res.json({ success: true, data: { tenant } });
    } catch (err) { next(err); }
  });

  // Update workspace settings
  router.patch('/workspaces/:tenantId', async (req, res, next) => {
    try {
      const { membership } = await requireMembership(req, req.params.tenantId);
      need('workspace:manage', membership);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const patch = {};
      if (body.businessName !== undefined) patch.businessName = body.businessName;
      const updated = await tenantService.updateTenant(req.params.tenantId, patch);
      try {
        await auditService.recordEvent({ tenantId: req.params.tenantId, eventType: 'WORKSPACE_UPDATED', actorId: req.user.userId, metadata: {} });
      } catch { /* ignore */ }
      return res.json({ success: true, data: { tenant: updated } });
    } catch (err) { next(err); }
  });

  // Business email verification status
  router.get('/workspaces/:tenantId/business-email', async (req, res, next) => {
    try {
      const { membership, tenant } = await requireMembership(req, req.params.tenantId);
      need('workspace:read', membership);
      return res.json({
        success: true,
        data: {
          businessEmail: tenant.businessEmail || '',
          verifiedAt: tenant.businessEmailVerifiedAt || null,
          verifiedByUserId: tenant.businessEmailVerifiedByUserId || null,
          verificationMethod: tenant.businessEmailVerificationMethod || null,
        },
      });
    } catch (err) { next(err); }
  });

  // Business email verification (§5.1)
  router.post('/workspaces/:tenantId/business-email/verify', async (req, res, next) => {
    try {
      const { membership } = await requireMembership(req, req.params.tenantId);
      // Require explicit permission
      try { need('business_email:verify', membership); }
      catch { need('workspace:manage', membership); }
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const rawEmail = typeof body.businessEmail === 'string' ? body.businessEmail.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
        const err = new Error('A valid business email address is required.');
        err.statusCode = 400;
        err.code = 'VALIDATION_ERROR';
        err.details = [{ field: 'businessEmail', message: 'Enter a valid email address.' }];
        throw err;
      }
      // A typed address never creates user/owner/membership automatically — verify only.
      let method = null;
      const userEmail = String(req.user.email || '').trim().toLowerCase();
      if (req.user.emailVerified && userEmail && userEmail === rawEmail) {
        method = 'google-identity';
      } else {
        // Explicit verification placeholder (future: DNS TXT challenge for company domains).
        // For Gmail addresses, require the signed-in Google identity to match; otherwise
        // record an explicit owner-attested verification.
        const isGmail = rawEmail.endsWith('@gmail.com') || rawEmail.endsWith('@googlemail.com');
        if (isGmail) {
          const err = new Error('This Gmail address does not match your verified Google identity. Sign in with that address or use an explicit account-switch flow.');
          err.statusCode = 403;
          err.code = 'BUSINESS_EMAIL_MISMATCH';
          throw err;
        }
        method = 'explicit-verification';
      }
      const updated = await tenantService.setBusinessEmailVerified({
        tenantId: req.params.tenantId,
        businessEmail: rawEmail,
        verifiedByUserId: req.user.userId,
        method,
      });
      try {
        await auditService.recordEvent({
          tenantId: req.params.tenantId,
          eventType: 'BUSINESS_EMAIL_VERIFIED',
          actorId: req.user.userId,
          metadata: { verificationMethod: method },
        });
      } catch { /* ignore */ }
      return res.json({
        success: true,
        data: {
          businessEmail: updated.businessEmail,
          verifiedAt: updated.businessEmailVerifiedAt,
          verificationMethod: updated.businessEmailVerificationMethod,
        },
      });
    } catch (err) { next(err); }
  });

  // List members
  router.get('/workspaces/:tenantId/members', async (req, res, next) => {
    try {
      const { membership } = await requireMembership(req, req.params.tenantId);
      need('members:read', membership);
      const members = await tenantService.listMembershipsForTenant(req.params.tenantId);
      // Strip sensitive internals; return role/status/userId only
      const safe = members.map((m) => ({ userId: m.userId, role: m.role, status: m.status, createdAt: m.createdAt }));
      return res.json({ success: true, data: { members: safe } });
    } catch (err) { next(err); }
  });

  // Invite member (explicit invitation — never auto-create owner from typed email)
  router.post('/workspaces/:tenantId/members', async (req, res, next) => {
    try {
      const { membership } = await requireMembership(req, req.params.tenantId);
      need('members:invite', membership);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
      const role = typeof body.role === 'string' ? body.role.trim() : 'purchaser';
      if (!userId) {
        const err = new Error('userId is required to invite a member.');
        err.statusCode = 400;
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      const target = await userService.findById(userId);
      if (!target) {
        const err = new Error('User not found.');
        err.statusCode = 404;
        err.code = 'USER_NOT_FOUND';
        throw err;
      }
      const created = await tenantService.addMembership({ tenantId: req.params.tenantId, userId, role, status: 'active', invitedByUserId: req.user.userId });
      try {
        await auditService.recordEvent({ tenantId: req.params.tenantId, eventType: 'MEMBERSHIP_CREATED', actorId: req.user.userId, metadata: { role } });
      } catch { /* ignore */ }
      return res.status(201).json({ success: true, data: { membership: { userId: created.userId, role: created.role, status: created.status } } });
    } catch (err) { next(err); }
  });

  // Update member role/status
  router.patch('/workspaces/:tenantId/members/:userId', async (req, res, next) => {
    try {
      const { membership } = await requireMembership(req, req.params.tenantId);
      need('members:manage', membership);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (req.params.userId === req.user.userId && body.role && body.role !== membership.role) {
        // Prevent self-demotion lockout without transfer — require another owner exists (simplified: deny)
        const members = await tenantService.listMembershipsForTenant(req.params.tenantId);
        const otherOwners = members.filter((m) => m.userId !== req.user.userId && m.role === 'owner' && m.status === 'active');
        if (membership.role === 'owner' && otherOwners.length === 0) {
          const err = new Error('Transfer ownership to another member before changing your own owner role.');
          err.statusCode = 400;
          err.code = 'OWNER_TRANSFER_REQUIRED';
          throw err;
        }
      }
      let updated = null;
      if (body.role) updated = await tenantService.updateMembershipRole({ tenantId: req.params.tenantId, userId: req.params.userId, role: body.role });
      if (body.status) updated = await tenantService.setMembershipStatus({ tenantId: req.params.tenantId, userId: req.params.userId, status: body.status });
      if (!updated) {
        const err = new Error('Membership not found.');
        err.statusCode = 404;
        err.code = 'MEMBERSHIP_NOT_FOUND';
        throw err;
      }
      try {
        await auditService.recordEvent({ tenantId: req.params.tenantId, eventType: 'MEMBERSHIP_UPDATED', actorId: req.user.userId, metadata: { role: updated.role, status: updated.status } });
      } catch { /* ignore */ }
      return res.json({ success: true, data: { membership: { userId: updated.userId, role: updated.role, status: updated.status } } });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createWorkspaceRoutes };
