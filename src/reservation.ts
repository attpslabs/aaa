/**
 * aaa — handle reservation logic for self.surf signups.
 *
 * Goal: treat existing identities elsewhere on the social web as first-class
 * citizens — `<name>.bsky.social` on AT Protocol and `<name>@mastodon.social`
 * on ActivityPub. A bare name (e.g. `dave`) is reservable on self.surf only if
 * it is taken on NONE of self.surf, bsky.social, or mastodon.social.
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

/** Public AppView used to resolve bsky.social handles -> DID (primary). */
export const APPVIEW_URL = 'https://public.api.bsky.app';

/** The bsky.social PDS itself — fallback host for resolveHandle. */
export const BSKY_PDS_URL = 'https://bsky.social';

/** The PDS whose namespace we are reserving into. */
export const PDS_URL = 'https://self.surf';

/** Domain that, when a `<name>.<this>` resolves, reserves the bare `<name>`. */
export const RESERVED_DOMAIN = 'bsky.social';

/** Domain handles get under on the self.surf PDS. */
export const PDS_DOMAIN = 'self.surf';

/**
 * ActivityPub (Mastodon) server whose local namespace we also reserve against.
 * A bare name taken as `<name>@MASTODON_DOMAIN` reserves it on self.surf too,
 * treating that fediverse identity as a first-class prior claim.
 *
 * Scoped to a SINGLE server on purpose: ActivityPub has thousands of
 * independent servers and no global namespace, so "taken anywhere" is
 * meaningless (it would block every common name). We pick the dominant server.
 */
export const MASTODON_HOST = 'https://mastodon.social';
export const MASTODON_DOMAIN = 'mastodon.social';

const DEFAULT_TIMEOUT_MS = 5000;

export type ReservationStatus =
  | 'available' // free across self.surf, bsky.social, AND mastodon.social
  | 'taken-self-surf' // already an account on self.surf
  | 'reserved-bsky' // a live <name>.bsky.social exists -> reserved
  | 'reserved-mastodon' // a live <name>@mastodon.social exists -> reserved
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
 * Shared AT Protocol resolver: `com.atproto.identity.resolveHandle` on any host.
 *
 * This is a standard PDS/AppView XRPC endpoint — identical shape everywhere — so
 * it backs the fallback for BOTH PDSs (bsky.social and self.surf). Hitting the
 * PDS host directly (not an AppView) means it answers from the PDS's own account
 * store, which is exactly the independent source we want when a primary is down.
 *
 *   200 {did} -> 'exists'   (taken/reserved)
 *   400       -> 'free'     (handle genuinely not found — InvalidRequest)
 *   else / network / timeout -> 'error'  (inconclusive; fail closed)
 */
async function resolveHandleViaXrpc(
  fqHandle: string,
  host: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResolveOutcome> {
  const url = `${host}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(
    fqHandle,
  )}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      // Defensive: confirm a did actually came back, not an empty 200.
      const data = (await res.json().catch(() => null)) as { did?: string } | null;
      return data?.did ? 'exists' : 'error';
    }
    if (res.status === 400) return 'free';
    return 'error';
  } catch {
    return 'error';
  }
}

/**
 * `.well-known/atproto-did` resolver for `<name>.bsky.social` — bsky's THIRD
 * tier. Every `*.bsky.social` account is served this endpoint automatically by
 * Bluesky's own infra (the subdomain points at their servers — verified across a
 * broad sample: served for every live account, 404 for every free name). No
 * per-user setup. It is a different service PATH than both the AppView and the
 * PDS xrpc route, so it survives an outage specific to either of those.
 *
 * (Still Bluesky infra, so it does NOT survive a total Bluesky outage — nothing
 * can, because `*.bsky.social` publishes no DNS `_atproto` record for an
 * external resolver to read. This is the deepest resilience the protocol allows.)
 *
 *   200 with a `did:` body -> 'exists'
 *   404                    -> 'free'
 *   else / network / timeout -> 'error'  (e.g. connection refused must read as
 *                                          error, never as free)
 */
async function resolveBskyViaWellKnown(
  fqHandle: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResolveOutcome> {
  const url = `https://${fqHandle}/.well-known/atproto-did`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const body = (await res.text().catch(() => '')).trim();
      return body.startsWith('did:') ? 'exists' : 'error';
    }
    if (res.status === 404) return 'free';
    return 'error';
  } catch {
    return 'error';
  }
}

/**
 * Resolve `<name>.bsky.social` through three tiers, each tried ONLY when the
 * previous is inconclusive ('error'). A decisive answer at any tier wins
 * immediately, so the common path is one request with no added latency.
 *
 *   ① AppView  xrpc/resolveHandle  (public.api.bsky.app) — purpose-built public
 *      lookup; primary because bsky.social hosts tens of millions of accounts.
 *   ② bsky.social PDS  xrpc/resolveHandle — same data, different host; survives
 *      an AppView-specific outage.
 *   ③ <name>.bsky.social/.well-known/atproto-did — different service path again;
 *      survives an xrpc-specific outage.
 *
 * All three are Bluesky infra (we do not operate bsky.social, so there is no
 * `/_internal` advantage and no Bluesky-independent source exists). Fails closed:
 * only if ALL THREE are inconclusive is the result 'error'.
 */
async function resolveBskyHandle(
  bareName: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResolveOutcome> {
  const fqHandle = `${bareName}.${RESERVED_DOMAIN}`;
  const appView = await resolveHandleViaXrpc(fqHandle, APPVIEW_URL, fetchImpl, timeoutMs);
  if (appView !== 'error') return appView;
  const pds = await resolveHandleViaXrpc(fqHandle, BSKY_PDS_URL, fetchImpl, timeoutMs);
  if (pds !== 'error') return pds;
  return resolveBskyViaWellKnown(fqHandle, fetchImpl, timeoutMs);
}

/**
 * PRIMARY Mastodon resolver: WebFinger, the protocol-standard existence check.
 *   200 -> 'exists'   (account is registered on the server)
 *   410 -> 'exists'   (account suspended/deleted — the name was claimed, so it
 *                      stays reserved; a known identity must not be reclaimable
 *                      by someone else)
 *   404 -> 'free'     (no such local account, never existed)
 *   else / network / timeout -> 'error'  (down, 429, 5xx -> inconclusive)
 *
 * WebFinger has no crisp "not found" code the way resolveHandle's 400 does, so
 * we treat ONLY 404 as free; every other non-2xx is inconclusive (fail closed),
 * except 410 which is a definitive "this name was taken".
 */
async function resolveMastodonViaWebFinger(
  bareName: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResolveOutcome> {
  const resource = `acct:${bareName}@${MASTODON_DOMAIN}`;
  const url = `${MASTODON_HOST}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/jrd+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return 'exists';
    if (res.status === 410) return 'exists'; // suspended/deleted -> still reserved
    if (res.status === 404) return 'free';
    return 'error';
  } catch {
    return 'error';
  }
}

/**
 * FALLBACK Mastodon resolver: the public REST account lookup. Different code
 * path than WebFinger on the same host, so it covers a WebFinger-specific issue.
 *   200 -> 'exists' · 404 -> 'free' · else -> 'error'
 */
async function resolveMastodonViaApi(
  bareName: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResolveOutcome> {
  const url = `${MASTODON_HOST}/api/v1/accounts/lookup?acct=${encodeURIComponent(bareName)}`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return 'exists';
    if (res.status === 410) return 'exists'; // suspended/deleted -> still reserved
    if (res.status === 404) return 'free';
    return 'error';
  } catch {
    return 'error';
  }
}

/**
 * Resolve `<name>@mastodon.social`: WebFinger first, REST account lookup as
 * fallback. Fallback runs ONLY when the primary is inconclusive ('error').
 * Fails closed: if BOTH are inconclusive the result is 'error'.
 *
 * Mastodon usernames are `[A-Za-z0-9_]` and case-insensitive. A self.surf name
 * that cannot exist as a Mastodon username (e.g. it contains a hyphen) can never
 * collide, so the caller skips this check for those — see checkHandleAvailability.
 */
async function resolveMastodonHandle(
  bareName: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ResolveOutcome> {
  const webfinger = await resolveMastodonViaWebFinger(bareName, fetchImpl, timeoutMs);
  if (webfinger !== 'error') return webfinger;
  return resolveMastodonViaApi(bareName, fetchImpl, timeoutMs);
}

/**
 * Could `bareName` even exist as a Mastodon username? Mastodon allows only
 * `[A-Za-z0-9_]`; our handles are lowercased `[a-z0-9-]`. The only disallowed
 * char that can appear in our handles is the hyphen — a hyphenated name can
 * never be a Mastodon account, so there is nothing to reserve against.
 */
function couldBeMastodonUsername(bareName: string): boolean {
  return !bareName.includes('-');
}

type ExistsOutcome = 'exists' | 'free' | 'error';

/**
 * PRIMARY self.surf check: the ePDS internal endpoint.
 * Returns 'error' on any non-OK / network failure so the caller fails closed.
 * Authoritative — it sees a name the instant it is reserved mid-signup, before
 * the repo/identity is live and publicly resolvable.
 */
async function checkSelfSurfViaInternal(
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

/**
 * Check `<name>.self.surf`, internal endpoint first, the PDS's own public
 * `resolveHandle` as fallback (via the shared `resolveHandleViaXrpc` — the SAME
 * mechanism the bsky.social side falls back to, only the host differs).
 *
 * The fallback runs ONLY when the primary is inconclusive ('error'), so the
 * authoritative `/_internal` answer is never second-guessed. Still fails closed:
 * if BOTH are inconclusive the result is 'error'.
 *
 * Why this fallback needs no secret: self.surf is a real AT Protocol PDS and
 * answers `resolveHandle` unauthenticated. (The documented `x-api-key` API only
 * exposes OTP send/verify, never handle existence — so the API key can't help
 * here.) Because it's secret-less, a `bskyOnly`-free caller without the internal
 * secret (audit, `pnpm check`) can still exercise the self.surf side.
 *
 * Caveat: `resolveHandle` only sees accounts once they are live, so it can miss
 * a name reserved in the split second mid-signup. Acceptable for a fallback used
 * only when the authoritative internal endpoint is unreachable.
 */
async function checkSelfSurfHandle(
  bareName: string,
  opts: {
    fetchImpl: typeof fetch;
    timeoutMs: number;
    pdsInternalUrl: string;
    internalSecret: string;
    pdsUrl: string;
  },
): Promise<ExistsOutcome> {
  const primary = await checkSelfSurfViaInternal(bareName, opts);
  if (primary !== 'error') return primary;
  const fqHandle = `${bareName}.${PDS_DOMAIN}`;
  return resolveHandleViaXrpc(fqHandle, opts.pdsUrl, opts.fetchImpl, opts.timeoutMs);
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
   * Skip the self.surf existence check and only test the cross-namespace
   * reservations. Used by the audit, which enumerates self.surf accounts itself.
   */
  bskyOnly?: boolean;
  /**
   * Skip the mastodon.social reservation. The audit only reports bsky.social
   * conflicts, so it opts out to avoid the extra per-name WebFinger lookups.
   */
  skipMastodon?: boolean;
}

/**
 * The full signup gate: a bare name is available only when it is free across ALL
 * THREE namespaces — self.surf, bsky.social (AT Protocol), and mastodon.social
 * (ActivityPub) — treating an existing identity on any of them as a first-class
 * prior claim. All checks run in parallel. Fails closed.
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
        // Public resolveHandle fallback always lives on the real PDS, even when
        // pdsInternalUrl points at an internal core host.
        pdsUrl: PDS_URL,
      });
  // Skip the Mastodon lookup when opted out, or when the name could never be a
  // Mastodon username anyway (hyphenated) — nothing to collide with.
  const mastodonPromise =
    options.skipMastodon || !couldBeMastodonUsername(bareName)
      ? Promise.resolve<ResolveOutcome>('free')
      : resolveMastodonHandle(bareName, fetchImpl, timeoutMs);

  const [bsky, self, mastodon] = await Promise.all([bskyPromise, selfPromise, mastodonPromise]);

  // Fail closed: if any lookup was inconclusive, do not hand out the name.
  if (bsky === 'error' || self === 'error' || mastodon === 'error') {
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

  if (mastodon === 'exists') {
    return {
      available: false,
      status: 'reserved-mastodon',
      reason: `Reserved by the existing @${bareName}@${MASTODON_DOMAIN} account`,
    };
  }

  return { available: true, status: 'available' };
}
