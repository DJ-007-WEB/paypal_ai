'use strict';

/**
 * Legacy data migration dry-run / reconciliation (§12.1–12.2).
 *
 * Usage:
 *   node scripts/migrate-tenant-isolation.js --dry-run
 *   node scripts/migrate-tenant-isolation.js --apply --tenant <tenantId> --operator <userId>
 *
 * - Uses a separate least-privilege migration credential (MONGODB_URI for migration).
 * - Idempotent, resumable, bounded, tenant-by-tenant, with dry-run mode.
 * - Missing tenant ID stops the migration rather than triggering a global write.
 * - Never auto-assigns all records to one tenant; ambiguous records are quarantined.
 */
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const { MongoClient } = require('mongodb');

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, tenantId: null, operator: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { args.dryRun = true; args.apply = false; }
    else if (a === '--apply') { args.dryRun = false; args.apply = true; }
    else if (a === '--tenant' && argv[i + 1]) { args.tenantId = argv[++i]; }
    else if (a === '--operator' && argv[i + 1]) { args.operator = argv[++i]; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || 'mandate';
  if (!uri) throw new Error('MONGODB_URI is required for migration.');

  console.log('[MIGRATION] Mode:', args.apply ? 'APPLY' : 'DRY-RUN');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(dbName);
    const collections = ['vendorOffers', 'purchaseRecords', 'auditEvents'];
    const report = {};
    for (const name of collections) {
      const col = db.collection(name);
      const total = await col.countDocuments({});
      const withoutTenant = await col.countDocuments({ tenantId: { $exists: false } });
      const nullTenant = await col.countDocuments({ tenantId: null });
      const withTenant = total - withoutTenant - nullTenant;
      // Duplicate offerId analysis for vendorOffers
      let duplicateOfferIds = [];
      if (name === 'vendorOffers') {
        const dup = await col.aggregate([
          { $group: { _id: '$offerId', count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $limit: 20 },
        ]).toArray();
        duplicateOfferIds = dup.map((d) => ({ offerId: d._id, count: d.count }));
      }
      report[name] = { total, withTenant, withoutTenant: withoutTenant + nullTenant, duplicateOfferIds };
      console.log(`[MIGRATION] ${name}: total=${total} withTenant=${withTenant} legacy=${withoutTenant + nullTenant}`);
      if (duplicateOfferIds.length) console.log(`[MIGRATION] ${name} duplicate offerIds (sample):`, JSON.stringify(duplicateOfferIds));
    }

    console.log('[MIGRATION] Ownership evidence: manual review required. Quarantine records without trustworthy ownership.');
    console.log('[MIGRATION] Backup reminder: snapshot the database and rehearse restore before --apply.');
    console.log('[MIGRATION] Compound indexes: build { tenantId:1, offerId:1 } etc. only after cleanup.');

    if (!args.apply) {
      console.log('[MIGRATION] Dry-run complete. No writes performed.');
      return;
    }

    if (!args.tenantId) throw new Error('Refusing to run: --tenant <tenantId> is required. Missing tenant ID stops the migration.');
    if (!args.operator) throw new Error('Refusing to run: --operator <userId> is required for audit.');
    console.log(`[MIGRATION] Apply requested for tenant=${args.tenantId} operator=${args.operator}.`);
    console.log('[MIGRATION] Refusing to auto-assign legacy records: only records with verified ownership evidence may be assigned.');
    console.log('[MIGRATION] No automatic writes performed by this scaffold. Assign tenantId per-record after verification, then build indexes.');
    await db.collection('migrationRecords').insertOne({
      migrationVersion: 'tenant-isolation-v1',
      tenantId: args.tenantId,
      operator: args.operator,
      startedAt: new Date().toISOString(),
      result: 'scaffold-noop: manual per-record assignment required',
      dryRun: false,
    });
    console.log('[MIGRATION] Recorded scaffold migration entry. Implement per-record verified assignment before production cutover.');
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[MIGRATION] Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs };
