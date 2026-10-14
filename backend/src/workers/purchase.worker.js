'use strict';

/**
 * Tenant-bound background job worker (§12.3).
 * Every job must carry jobId, tenantId, initiating actor/service identity,
 * bounded payload/reference IDs, an idempotency key, and creation/attempt metadata.
 * Workers revalidate tenant status and use tenant-aware repositories.
 * Never keep the current tenant in process-global mutable state.
 */

function createPurchaseWorker({ tenantService, vendorService, purchaseStore, auditService } = {}) {
  const processedIdempotencyKeys = new Set();

  function requireJobContext(job) {
    if (!job || typeof job !== 'object') throw new Error('Job must be an object.');
    if (!job.jobId || typeof job.jobId !== 'string') throw new Error('job.jobId is required.');
    if (!job.tenantId || typeof job.tenantId !== 'string' || !job.tenantId.trim()) {
      const err = new Error('job.tenantId is required. Missing tenant ID stops the job.');
      err.code = 'TENANT_CONTEXT_REQUIRED';
      throw err;
    }
    if (!job.idempotencyKey || typeof job.idempotencyKey !== 'string') {
      throw new Error('job.idempotencyKey is required for safe retries.');
    }
    return { jobId: job.jobId, tenantId: job.tenantId.trim(), idempotencyKey: job.idempotencyKey };
  }

  async function processJob(job) {
    const { jobId, tenantId, idempotencyKey } = requireJobContext(job);
    const idemKey = `${tenantId}:${idempotencyKey}`;
    if (processedIdempotencyKeys.has(idemKey)) {
      return { jobId, tenantId, status: 'duplicate-suppressed', idempotencyKey };
    }

    // Revalidate tenant status on every execution
    if (tenantService) {
      const tenant = await tenantService.getTenant(tenantId);
      if (!tenant || tenant.status !== 'active') {
        throw new Error(`Tenant ${tenantId} is unavailable; job ${jobId} refused.`);
      }
    }

    const attempt = Number(job.attempt || 1);
    const startedAt = new Date().toISOString();
    try {
      // Placeholder for future purchase-related background work (e.g., re-evaluation,
      // notifications). Currently records a tenant-scoped audit event only.
      if (auditService) {
        await auditService.recordEvent({
          tenantId,
          eventType: 'BACKGROUND_JOB_COMPLETED',
          actorId: job.actorId || job.serviceIdentity || 'worker',
          metadata: { jobId, attempt },
        });
      }
      processedIdempotencyKeys.add(idemKey);
      return { jobId, tenantId, status: 'completed', attempt, startedAt, completedAt: new Date().toISOString() };
    } catch (err) {
      if (auditService) {
        try {
          await auditService.recordEvent({
            tenantId,
            eventType: 'BACKGROUND_JOB_FAILED',
            actorId: job.actorId || 'worker',
            metadata: { jobId, attempt },
          });
        } catch { /* ignore */ }
      }
      throw err;
    }
  }

  return { processJob };
}

module.exports = { createPurchaseWorker };
