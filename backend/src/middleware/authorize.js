'use strict';

/**
 * Authorization middleware (§7, §8).
 * - resolveWorkspaceMembership: server-resolves tenantId from validated session +
 *   active workspace membership. A client may request a workspace selection via
 *   X-Tenant-Id / X-Workspace-Id header, but the server validates membership
 *   before granting context. Missing/invalid context fails closed.
 * - requirePermission(permission): checks explicit permission set.
 * - requireTenantContext: ensures frozen req.auth with tenantId exists.
 */

function createAuthorizeMiddleware({ tenantService } = {}) {
  if (!tenantService) throw new Error('authorize middleware requires tenantService.');

  function getRequestedTenantId(req) {
    const fromHeader = req.get('X-Tenant-Id') || req.get('X-Workspace-Id');
    if (fromHeader && typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();
    // Test harness may supply tenant request header; still verified server-side.
    const fromTestHeader = req.get('X-Test-Tenant-Id');
    if (fromTestHeader && typeof fromTestHeader === 'string' && fromTestHeader.trim()) return fromTestHeader.trim();
    if (req.query && typeof req.query.tenantId === 'string' && req.query.tenantId.trim()) return req.query.tenantId.trim();
    if (req.query && typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()) return req.query.workspaceId.trim();
    return null;
  }

  async function resolveWorkspaceMembership(req, res, next) {
    try {
      if (!req.user) {
        const err = new Error('Authentication required.');
        err.statusCode = 401;
        err.code = 'UNAUTHENTICATED';
        throw err;
      }
      const requestedTenantId = getRequestedTenantId(req);
      let membership = null;

      if (requestedTenantId) {
        membership = await tenantService.getMembership({ tenantId: requestedTenantId, userId: req.user.userId });
        if (!membership || membership.status !== 'active') {
          const err = new Error('Access to the requested workspace is denied.');
          err.statusCode = 403;
          err.code = 'WORKSPACE_FORBIDDEN';
          throw err;
        }
        const tenant = await tenantService.getTenant(requestedTenantId);
        if (!tenant || tenant.status !== 'active') {
          const err = new Error('Access to the requested workspace is denied.');
          err.statusCode = 403;
          err.code = 'WORKSPACE_FORBIDDEN';
          throw err;
        }
      } else {
        // No explicit selection: if the user has exactly one active membership, use it;
        // otherwise fail closed and require explicit workspace selection.
        const memberships = await tenantService.listMembershipsForUser(req.user.userId);
        const active = (memberships || []).filter((m) => m.status === 'active');
        if (active.length === 1) {
          membership = active[0];
          const tenant = await tenantService.getTenant(membership.tenantId);
          if (!tenant || tenant.status !== 'active') {
            const err = new Error('Workspace is unavailable.');
            err.statusCode = 403;
            err.code = 'WORKSPACE_FORBIDDEN';
            throw err;
          }
        } else if (active.length === 0) {
          const err = new Error('No active workspace membership. Contact your workspace owner.');
          err.statusCode = 403;
          err.code = 'NO_WORKSPACE_MEMBERSHIP';
          throw err;
        } else {
          const err = new Error('Multiple workspaces available. Select a workspace to continue.');
          err.statusCode = 400;
          err.code = 'WORKSPACE_SELECTION_REQUIRED';
          err.details = (active || []).map((m) => ({ tenantId: m.tenantId, role: m.role }));
          throw err;
        }
      }

      req.membership = membership;
      req.tenantId = membership.tenantId;
      req.auth = Object.freeze({
        userId: req.user.userId,
        tenantId: membership.tenantId,
        membershipId: membership.membershipId,
        role: membership.role,
        permissions: [...(membership.permissions || [])],
        sessionId: req.sessionId || null,
      });
      next();
    } catch (err) {
      next(err);
    }
  }

  function requirePermission(permission) {
    return (req, res, next) => {
      try {
        if (!req.auth || !req.auth.tenantId) {
          const err = new Error('Tenant context is required.');
          err.statusCode = 400;
          err.code = 'TENANT_CONTEXT_REQUIRED';
          throw err;
        }
        if (!Array.isArray(req.auth.permissions) || !req.auth.permissions.includes(permission)) {
          const err = new Error('You do not have permission to perform this action.');
          err.statusCode = 403;
          err.code = 'FORBIDDEN';
          throw err;
        }
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  function requireTenantContext(req, res, next) {
    try {
      if (!req.auth || !req.auth.tenantId || !req.auth.userId) {
        const err = new Error('Tenant context is required.');
        err.statusCode = 400;
        err.code = 'TENANT_CONTEXT_REQUIRED';
        throw err;
      }
      next();
    } catch (err) {
      next(err);
    }
  }

  function validateRequest(validator) {
    return (req, res, next) => {
      try {
        const result = validator(req.body);
        if (result && result.valid === false) {
          const err = new Error('The request is invalid.');
          err.statusCode = 400;
          err.code = 'VALIDATION_ERROR';
          err.details = result.errors || [];
          throw err;
        }
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  return { resolveWorkspaceMembership, requirePermission, requireTenantContext, validateRequest, getRequestedTenantId };
}

module.exports = { createAuthorizeMiddleware };
