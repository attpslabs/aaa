/**
 * handle-guard — handle reservation logic for self.surf signups.
 *
 * Goal: treat existing `<name>.bsky.social` accounts as first-class AT Protocol
 * citizens. A bare name (e.g. `dave`) is reservable on self.surf only if it is
 * taken on NEITHER self.surf NOR bsky.social.
 *
 * This module is the single source of truth for that rule. It is consumed by:
 *   - the linkname `check-handle` route (live signup gate)  — see ../drop-in
 *   - the audit script (report existing conflicts)          — see ../scripts
 *
 * Design notes:
 *   - Pure `fetch`, no @atproto SDK — runs on the edge runtime, distinguishes
 *     "definitely free" (HTTP 400 not-found) from "couldn't tell" (5xx/timeout).
 *   - FAIL CLOSED: any inconclusive result counts as reserved. A resolver
 *     outage must never let a reserved name slip through.
 */

/** Public AppView used to resolve bsky.social handles -> DID. */
export const APPVIEW_URL = 'https://public.api.bsky.app';

/** The PDS whose namespace we are reserving into. */
export const PDS_URL = 'https://self.surf';

/** Domain that, when a `<name>.<this>` resolves, reserves the bare `<name>`. */
export const RESERVED_DOMAIN = 'bsky.social';

/** Domain handles get under on the self.surf PDS. */
export const PDS_DOMAIN = 'self.surf';

const DEFAULT_TIMEOUT_MS = 5000;

export type ReservationStatus =
  | 'available' // free on both self.surf and bsky.social
  | 'taken-self-surf' // already an account on self.surf
  | 'reserved-bsky' // a live <name>.bsky.social exists -> reserved
  | 'invalid' // failed format validation
  | 'error'; // could not determine -> treated as unavailable (fail closed)

export interface ReservationResult {
  /** True only when the bare name may be claimed on self.surf. */
  available: boolean;
  status: ReservationStatus;
  /** Human-facing explanation, safe to surface to the signup UI. */
  reason?: string;
}

/**
 * Handle format: 3–20 chars, lowercase alphanumeric + hyphens, no leading or
 * trailing hyphen. Mirrors the server-side check in linkname's route.
 */
const HANDLE_REGEX = /^[a-z0-9]([a-z0-9-]{1,18}[a-z0-9])?$/;

export function validateBareHandle(raw: string): ReservationResult | null {
  const handle = raw.trim().toLowerCase();
  if (handle.length < 3) {
    return { available: false, status: 'invalid', reason: 'Handle must be at least 3 characters' };
  }
  if (handle.length > 20) {
    return { available: false, status: 'invalid', reason: 'Handle must be 20 characters or less' };
  }
  if (!HANDLE_REGEX.test(handle)) {
    return {
      available: false,
      status: 'invalid',
      reason: 'Handle can only contain letters, numbers, and hyphens (no leading/trailing hyphens)',
    };
  }
  return null; // valid
}

type ResolveOutcome = 'exists' | 'free' | 'error';

/**
 * Resolve `<name>.bsky.social` against the public AppView.
 *   200 -> 'exists'   (reserved)
 *   400 -> 'free'     (handle genuinely not found)
 *   else / network / timeout -> 'error'  (inconclusive)
 */
async function resolveBskyHandle(
  bareName: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResolveOutcome> {
  const fqHandle = `${bareName}.${RESERVED_DOMAIN}`;
  const url = `${APPVIEW_URL}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(
    fqHandle,
  )}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      // Defensive: confirm a did actually came back, not an empty 200.
      const data = (await res.json().catch(() => null)) as { did?: string } | null;
      return data?.did ? 'exists' : 'error';
    }
    // resolveHandle returns 400 with InvalidRequest when the handle is unknown.
    if (res.status === 400) return 'free';
    return 'error';
  } catch {
    return 'error';
  }
}

type ExistsOutcome = 'exists' | 'free' | 'error';

/**
 * Ask the ePDS internal endpoint whether `<name>.self.surf` already exists.
 * Returns 'error' on any non-OK / network failure so the caller fails closed.
 */
async function checkSelfSurfHandle(
  bareName: string,
  opts: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
    pdsInternalUrl: string;
    internalSecret: string;
  },
): Promise<ExistsOutcome> {
  const fqHandle = `${bareName}.${PDS_DOMAIN}`;
  const url = `${opts.pdsInternalUrl}/_internal/check-handle?handle=${encodeURIComponent(fqHandle)}`;
  try {
    const res = await opts.fetchImpl(url, {
      headers: { 'x-internal-secret': opts.internalSecret },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { exists?: boolean } | null;
      if (data == null || typeof data.exists !== 'boolean') return 'error';
      return data.exists ? 'exists' : 'free';
    }
    return 'error';
  } catch {
    return 'error';
  }
}

export interface CheckAvailabilityOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Internal URL of the ePDS PDS core (e.g. http://core:3000). */
  pdsInternalUrl?: string;
  /** Shared secret for the `/_internal/*` endpoints. */
  internalSecret?: string;
  /**
   * Skip the self.surf existence check and only test the bsky.social
   * reservation. Used by the audit, which enumerates self.surf accounts itself.
   */
  bskyOnly?: boolean;
}

/**
 * The full signup gate: a bare name is available only when it is free on BOTH
 * self.surf and bsky.social. Runs both checks in parallel. Fails closed.
 */
export async function checkHandleAvailability(
  rawHandle: string,
  options: CheckAvailabilityOptions = {},
): Promise<ReservationResult> {
  const invalid = validateBareHandle(rawHandle);
  if (invalid) return invalid;

  const bareName = rawHandle.trim().toLowerCase();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const bskyPromise = resolveBskyHandle(bareName, fetchImpl, timeoutMs);
  const selfPromise = options.bskyOnly
    ? Promise.resolve<ExistsOutcome>('free')
    : checkSelfSurfHandle(bareName, {
        fetchImpl,
        timeoutMs,
        pdsInternalUrl: options.pdsInternalUrl ?? PDS_URL,
        internalSecret: options.internalSecret ?? '',
      });

  const [bsky, self] = await Promise.all([bskyPromise, selfPromise]);

  // Fail closed: if either lookup was inconclusive, do not hand out the name.
  if (bsky === 'error' || self === 'error') {
    return {
      available: false,
      status: 'error',
      reason: 'Could not verify handle availability. Please try again.',
    };
  }

  if (self === 'exists') {
    return { available: false, status: 'taken-self-surf', reason: 'This handle is already taken' };
  }

  if (bsky === 'exists') {
    return {
      available: false,
      status: 'reserved-bsky',
      reason: `Reserved by the existing @${bareName}.${RESERVED_DOMAIN} account`,
    };
  }

  return { available: true, status: 'available' };
}
