# Task: integrate `@attps/aaa` handle reservation into linkname

You are working **inside the linkname repository** (the Next.js app behind
linkna.me, which runs the self.surf PDS). Your job is to wire in a published npm
package, `@attps/aaa`, that reserves bare-name handles, and to produce a
conflict report for the accounts that already exist.

Read this whole brief before changing anything. Do not guess at the package API —
it is specified in full below.

---

## Background: what `@attps/aaa` does

A bare name like `dave` should be claimable on self.surf **only if it is free
across all three namespaces**: self.surf, `dave.bsky.social` (AT Protocol), and
`dave@mastodon.social` (ActivityPub). If a real account exists on any of them,
the bare name is reserved and the signup must be rejected.

The package is **fail-closed**: any inconclusive lookup (timeout, 5xx, malformed
response) is treated as *reserved / unavailable*, never as free. A resolver or
PDS outage must never leak a reserved name. Preserve this property — do not add
fallbacks that default to "available".

It is **zero-dependency, pure `fetch`, edge-runtime safe.** Do not introduce the
`@atproto` SDK, a Mastodon client, or any Node-only API into the request path.

---

## The package API (authoritative — do not deviate)

```ts
import { checkHandleAvailability } from '@attps/aaa';
import type { ReservationResult, ReservationStatus } from '@attps/aaa';

const result: ReservationResult = await checkHandleAvailability(handle, {
  pdsInternalUrl?: string,    // ePDS internal core URL (authoritative self.surf check)
  internalSecret?: string,    // shared secret for the /_internal/* endpoints
  timeoutMs?: number,         // default 5000
  fetchImpl?: typeof fetch,   // injectable; defaults to global fetch
  bskyOnly?: boolean,         // skip the self.surf check (audit uses this)
  skipMastodon?: boolean,     // skip the mastodon.social check
});
```

`ReservationResult`:

```ts
interface ReservationResult {
  available: boolean;       // true ONLY when the name may be claimed
  status: ReservationStatus;
  reason?: string;          // human-facing, safe to show in the signup UI
}

type ReservationStatus =
  | 'available'         // free across all three namespaces
  | 'taken-self-surf'   // already an account on self.surf
  | 'reserved-bsky'     // a live <name>.bsky.social exists
  | 'reserved-mastodon' // a live <name>@mastodon.social exists
  | 'invalid'           // failed format validation (length / charset)
  | 'error';            // could not determine -> treated as unavailable (fail closed)
```

`checkHandleAvailability` does its own format validation (3–20 chars, lowercase
`[a-z0-9-]`, no leading/trailing hyphen) and returns `status: 'invalid'` for bad
input. You do **not** need to pre-validate, but keep any existing linkname
format check in place as a first line — it must stay consistent with the
package's rule (mirror it; don't loosen it).

There is also a ready-made route file in the package repo at
`drop-in/check-handle-route.ts` — read it as the reference implementation, but
adapt to linkname's actual file rather than copying blindly.

---

## Part 1 — wire the signup gate (the live rule)

**Goal:** every *new* signup must pass `checkHandleAvailability`. Existing
accounts are untouched — this is a forward-looking gate only.

1. `npm install @attps/aaa` (or the repo's package manager). Confirm it appears
   in `package.json` dependencies.
2. Find linkname's handle-availability route. It is most likely
   `src/app/api/auth/check-handle/route.ts` (search for `check-handle`,
   `resolveHandle`, `/_internal/check-handle`, or the existing availability
   endpoint the signup form calls). **Locate it before editing — do not assume
   the path.**
3. Replace its availability logic with a call to `checkHandleAvailability`,
   passing the env vars linkname already uses for the PDS:
   - `pdsInternalUrl: process.env.PDS_INTERNAL_URL` (fall back to
     `https://self.surf` if unset)
   - `internalSecret: process.env.EPDS_INTERNAL_SECRET ?? ''`
4. **Preserve the existing route contract exactly:**
   - Same request shape (the `handle` query/body param the client already sends).
   - Same success response shape the client hook expects (it already surfaces a
     `reason` string — keep that field so the new "Reserved by the existing
     @name.bsky.social account" message displays with no client change).
   - **Fail closed on the error path:** when `result.status === 'error'`, return
     the existing error status code (the current route uses **503**) with
     `available: false`. Do not turn an inconclusive result into a 200/available.
5. Do **not** change the client. The existing hook (look for `useHandleCheck` or
   similar) already renders `reason`, so the new reserved-name messages appear
   for free. Verify this assumption by reading the hook; if it doesn't surface
   `reason`, note it and make the minimal change so it does.
6. Keep the route on the edge runtime if it already is (`export const runtime =
   'edge'`). The package is edge-safe; don't move it to the Node runtime.

**Acceptance for Part 1:**
- A name with a live `*.bsky.social` or `*@mastodon.social` account is rejected
  at signup with a clear `reason`.
- A genuinely free name still succeeds.
- An induced upstream failure (e.g. point `pdsInternalUrl` at an unreachable
  host in a local test) yields `available: false` + 503 — never available.
- Typecheck / lint / existing tests pass.

---

## Part 2 — find existing collisions so they can be contacted ad-hoc

**Goal:** existing `*.self.surf` accounts are *grandfathered* — the gate never
touches them. But you need a list of which ones hold a bare name that is now
reserved by a bsky.social or mastodon.social account, so a human can contact
each owner. This is **report-only**: no renames, no deletions, no notices sent.

The package repo already has an audit script
(`scripts/audit.ts` in the `@attps/aaa` source) that does most of this using
**public APIs only** (no secret). Its approach:

1. `com.atproto.sync.listRepos` on self.surf → every hosted DID (paginated).
2. For each DID, resolve its current handle from `plc.directory` (fall back to
   the PDS's own `com.atproto.repo.describeRepo`).
3. Keep handles ending in `.self.surf`.
4. For each bare name, call `checkHandleAvailability(bareName, { bskyOnly: true })`
   and record any `reserved-bsky` / `reserved-mastodon` result.

**What to build in linkname:** a one-off script (e.g.
`scripts/audit-handle-conflicts.ts`, runnable via `tsx` or your existing script
runner) that does the above **and joins each conflicting DID back to the
linkname user record** so the output includes contact info.

Requirements:

- Use `@attps/aaa`'s `checkHandleAvailability` for the namespace check — do not
  reimplement the resolver. Pass `{ bskyOnly: true }` because the audit
  enumerates self.surf itself.
  - **Important:** do NOT also pass `skipMastodon: true`. The package's own audit
    script skips Mastodon for speed, but for a complete pre-launch contact list
    you want both `reserved-bsky` *and* `reserved-mastodon` conflicts. Leaving
    `skipMastodon` unset includes the Mastodon check.
- The package check is public-API and PII-free by design. The **email/contact
  join must happen inside linkname**, keyed by DID, against linkname's own user
  table. Find how linkname maps a self.surf DID → user → email (search the user
  model / auth tables).
- Output a CSV with at least:
  `self_surf_handle, bare_name, reserved_by (bsky|mastodon), reserving_handle, did, email`
- Add bounded concurrency (≈8) for the per-DID lookups; the package check and
  PLC lookups are network-bound.
- Print a summary line: `N conflicts of M .self.surf accounts`.

**Acceptance for Part 2:**
- Running the script against production (read-only) produces a CSV the team can
  work through.
- It detects conflicts on **both** bsky.social and mastodon.social.
- It mutates nothing — verify it only reads.

---

## Order of operations (do this, in this order)

1. **Part 2 first.** Run the audit against production and produce the conflict
   CSV *before* the gate goes live. This is your point-in-time snapshot of who is
   already affected.
2. Hand the CSV to the team to contact owners ad-hoc (the grandfathered accounts
   keep working regardless — the contact is courtesy / heads-up, not enforcement).
3. **Then Part 1.** Wire the gate so the rule applies to all new signups.

Doing Part 1 before Part 2 risks a name getting reserved-against in the window
between audit and launch.

---

## Constraints & non-goals (do not do these)

- **Do not** rename, delete, or notify existing accounts programmatically. The
  audit is report-only; contact is a human, ad-hoc step.
- **Do not** add an ownership-aware exception (letting the real owner of
  `dave.bsky.social` claim `dave.self.surf`). That is a deliberate future
  feature, out of scope here — the current rule is a hard block for everyone.
- **Do not** weaken fail-closed behavior anywhere.
- **Do not** vendor or fork the package logic into linkname; depend on the
  published `@attps/aaa` so the rule stays a single source of truth.
- **Do not** add the `@atproto` SDK or any Node-only dependency to the request
  path.

## Deliverables

1. The updated check-handle route (Part 1) + confirmation the client surfaces
   `reason` unchanged.
2. The audit script (Part 2) + the generated `conflicts.csv` (or a sample, if
   you can't run against prod from your environment).
3. A short note in your PR description: which files changed, how you verified
   fail-closed behavior, and any assumption you had to make about linkname's
   internals (route path, env var names, the DID→email join) so a reviewer can
   check them.

If any assumption in this brief doesn't match linkname's actual structure (route
path, env var names, the client hook, how DIDs map to users), **trust the
codebase over this document** and call out the discrepancy in your PR.
