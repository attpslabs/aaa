/**
 * DROP-IN REPLACEMENT for linkname:
 *   src/app/api/auth/check-handle/route.ts
 *
 * Adds cross-namespace reservation checks to the existing self.surf availability
 * check: a bare name is available only when it is free across ALL THREE
 * namespaces — self.surf, bsky.social (AT Protocol), and mastodon.social
 * (ActivityPub).
 *
 * To install:
 *   1. `npm install @attps/aaa` in linkname (or copy src/reservation.ts in
 *      manually) and point the import below at it.
 *   2. Replace linkname's check-handle/route.ts with this file.
 *
 * Behaviour vs. the original route:
 *   - same format validation + same fail-closed-on-error contract
 *   - NEW: rejects `<name>` when `<name>.bsky.social` resolves to a DID, or when
 *     `<name>@mastodon.social` is a registered account
 *   - the upstream lookups run in parallel (no extra latency stacking)
 */

import { checkHandleAvailability } from '@attps/aaa';
// ^ or '@/lib/handle-reservation' if you copied reservation.ts in manually

export const runtime = 'edge';

const PDS_URL = 'https://self.surf';
const PDS_INTERNAL_URL = process.env.PDS_INTERNAL_URL || PDS_URL;
const EPDS_INTERNAL_SECRET = process.env.EPDS_INTERNAL_SECRET || '';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const handle = searchParams.get('handle');

  if (!handle) {
    return Response.json({ available: false, reason: 'Handle is required' }, { status: 400 });
  }

  const result = await checkHandleAvailability(handle, {
    pdsInternalUrl: PDS_INTERNAL_URL,
    internalSecret: EPDS_INTERNAL_SECRET,
  });

  // Service-error path mirrors the original: fail closed with 503 so a resolver
  // or PDS outage never reports a reserved/taken name as available.
  if (result.status === 'error') {
    return Response.json({ available: result.available, reason: result.reason }, { status: 503 });
  }

  return Response.json({ available: result.available, reason: result.reason });
}
