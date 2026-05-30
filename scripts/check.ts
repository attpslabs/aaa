#!/usr/bin/env node
/**
 * Spot-check a single bare name against the reservation rule.
 *
 * Usage:
 *   pnpm tsx scripts/check.ts dave
 *
 * Note: without EPDS_INTERNAL_SECRET set, the self.surf side cannot be queried,
 * so this runs bsky-only. Set PDS_INTERNAL_URL + EPDS_INTERNAL_SECRET in the
 * environment to exercise the full gate.
 */

import { checkHandleAvailability } from '../src/reservation.js';

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: tsx scripts/check.ts <bare-name>');
    process.exit(1);
  }

  const secret = process.env.EPDS_INTERNAL_SECRET;
  const result = await checkHandleAvailability(name, {
    bskyOnly: !secret,
    internalSecret: secret,
    pdsInternalUrl: process.env.PDS_INTERNAL_URL,
  });

  if (!secret) console.error('(bsky-only: EPDS_INTERNAL_SECRET not set)');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
