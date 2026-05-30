/**
 * @attps/aaa — public API.
 *
 * Reserve bare-name handles on a PDS against existing identities elsewhere on
 * the social web (bsky.social on AT Protocol, mastodon.social on ActivityPub).
 * Zero runtime dependencies, pure `fetch`, edge-runtime safe, fail-closed.
 *
 * Typical use in a signup gate:
 *
 *   import { checkHandleAvailability } from '@attps/aaa';
 *
 *   const result = await checkHandleAvailability(handle, {
 *     pdsInternalUrl: process.env.PDS_INTERNAL_URL,
 *     internalSecret: process.env.EPDS_INTERNAL_SECRET,
 *   });
 *   if (!result.available) return reject(result.reason);
 */

export {
  checkHandleAvailability,
  validateBareHandle,
  APPVIEW_URL,
  BSKY_PDS_URL,
  PDS_URL,
  RESERVED_DOMAIN,
  PDS_DOMAIN,
  MASTODON_HOST,
  MASTODON_DOMAIN,
} from './reservation.js';

export type {
  ReservationStatus,
  ReservationResult,
  CheckAvailabilityOptions,
} from './reservation.js';
