# aaa

[![npm](https://img.shields.io/npm/v/@attps/aaa.svg)](https://www.npmjs.com/package/@attps/aaa)

Treat existing identities elsewhere on the social web as first-class citizens
when handing out handles on the **self.surf** PDS (the one behind
[linkna.me](https://www.linkna.me)) — both **`<name>.bsky.social`** on AT
Protocol and **`<name>@mastodon.social`** on ActivityPub.

**The rule:** a bare name like `dave` is claimable on self.surf only if it is
free across **all three** namespaces — self.surf, bsky.social, and
mastodon.social. If `dave.bsky.social` resolves to a real DID, **or**
`dave@mastodon.social` is a registered account, nobody can register
`dave.self.surf` — a **hard block for everyone** (including the real owner of
those accounts, for now).

**Why these two and no others:** bsky.social is the mass-signup namespace for AT
Protocol; mastodon.social is the dominant single server on ActivityPub. Both are
single, resolvable namespaces — see [Scope / caveats](#scope--caveats) for why we
reserve against specific servers rather than "any handle anywhere."

## What's here

| Path | Purpose |
| --- | --- |
| `src/reservation.ts` | The reservation rule across all three namespaces. Single source of truth, fail-closed. Used by both the route and the audit. |
| `drop-in/check-handle-route.ts` | Ready-to-install replacement for linkname's `src/app/api/auth/check-handle/route.ts`. |
| `scripts/audit.ts` | Reports existing self.surf accounts whose bare name is a live bsky.social handle. Report only. |
| `scripts/check.ts` | Spot-check a single name from the CLI. |

linkname itself is **not modified** — wire the drop-in in when you're ready.

## Install

Use it as a dependency in your own app:

```bash
npm install @attps/aaa
```

```ts
import { checkHandleAvailability } from '@attps/aaa';

const result = await checkHandleAvailability(handle, {
  pdsInternalUrl: process.env.PDS_INTERNAL_URL,
  internalSecret: process.env.EPDS_INTERNAL_SECRET,
});
if (!result.available) return reject(result.reason);
```

## Local development

```bash
git clone https://github.com/attpslabs/aaa
cd aaa
pnpm install        # or npm install
```

## Run the audit (existing conflicts)

Public APIs only — no secret required. It enumerates self.surf via
`com.atproto.sync.listRepos`, resolves each DID's handle from the PLC directory
(falling back to the PDS's own `com.atproto.repo.describeRepo` if PLC is
unreachable), then checks each bare name against bsky.social using the same
tiered resolver as the live gate.

```bash
pnpm audit                    # table to stdout
pnpm audit --csv conflicts.csv
pnpm audit --limit 500        # cap repos scanned, for a quick dry run
```

Your `/dave` account will appear here if `dave.bsky.social` exists.

## Spot-check one name

```bash
pnpm check dave               # bsky + mastodon; self.surf only if the secret is set
EPDS_INTERNAL_SECRET=… PDS_INTERNAL_URL=https://self.surf pnpm check dave   # full 3-namespace gate
```

## Install the signup gate into linkname

1. Copy `src/reservation.ts` into linkname, e.g. `src/lib/handle-reservation.ts`.
2. Replace `src/app/api/auth/check-handle/route.ts` with
   `drop-in/check-handle-route.ts`, fixing the import path.
3. The existing client hook (`useHandleCheck.ts`) already surfaces `reason`, so
   the new "Reserved by the existing @name.bsky.social account" message shows
   with no client change.

The route keeps linkname's existing contract: same format validation, and it
**fails closed** (503, `available: false`) whenever either upstream lookup is
inconclusive — a resolver or PDS outage can never leak a reserved name.

## How resolution works

The three namespace checks run **in parallel** and the name is **taken-if-any**.
Each side has tiered fallbacks: a tier is tried only when the previous one is
_inconclusive_ (`error`), so a decisive answer wins immediately with no added
latency, and the name is handed out only if some tier on **each** side
decisively reports it free. If a side exhausts its tiers without a decision, the
whole check fails closed.

**bsky.social side — 3 tiers** (we don't operate bsky.social, so there is no
privileged endpoint and no Bluesky-independent source; we maximize depth instead):

1. **AppView** `GET public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=<name>.bsky.social`
   — the purpose-built public lookup. `200 {did}` = reserved, `400` = free.
2. **bsky.social PDS** — the same `resolveHandle` XRPC call against `https://bsky.social`
   directly (different host, same data); survives an AppView-specific outage.
3. **`.well-known`** `GET https://<name>.bsky.social/.well-known/atproto-did`
   — served automatically for every `*.bsky.social` account; `200` w/ `did:` body
   = reserved, `404` = free. Different service path again; survives an xrpc outage.

   All three are Bluesky infrastructure. `*.bsky.social` publishes no `_atproto`
   DNS record, so DNS-over-HTTPS (Google/Cloudflare) **cannot** resolve these
   handles — a total Bluesky outage therefore fails closed by design.

**self.surf side — 2 tiers** (we operate this PDS, so tier 1 is authoritative —
no deeper chain is needed):

1. **ePDS internal** `GET /_internal/check-handle` (`{ exists: boolean }`,
   authenticated with `x-internal-secret`) — reads the PDS database, so it sees a
   name the instant it is reserved mid-signup, before the account is publicly live.
2. **self.surf PDS** — the public `resolveHandle` XRPC call against `https://self.surf`
   (no secret); survives an outage of the `/_internal` auth layer. The documented
   `x-api-key` API only exposes OTP send/verify, not handle existence, so it can't
   help here. Caveat: only sees accounts once live, hence a fallback, not the primary.

**mastodon.social side — 2 tiers** (a _different protocol_, ActivityPub, so it
uses ActivityPub mechanics — not `resolveHandle`):

1. **WebFinger** `GET https://mastodon.social/.well-known/webfinger?resource=acct:<name>@mastodon.social`
   — the protocol-standard existence check. `200` (or `410` suspended) = reserved,
   `404` = free.
2. **REST API** `GET https://mastodon.social/api/v1/accounts/lookup?acct=<name>`
   — different code path on the same host; survives a WebFinger-specific issue.

   Mastodon usernames are case-insensitive `[A-Za-z0-9_]`. A self.surf name that
   contains a hyphen can therefore **never** be a Mastodon account, so the
   Mastodon check is skipped for those (treated as free — nothing to collide with).
   A suspended/deleted account (`410`) stays reserved: a known identity must not
   be reclaimable by someone else.

Outcome mapping — **AT Proto `resolveHandle`** tiers: `200 {did}` → reserved/taken,
`400` → free; **Mastodon** tiers: `200`/`410` → reserved, `404` → free. For every
tier, anything else (5xx / timeout / connection refused) → inconclusive → fail closed.

## Scope / caveats

- **Specific servers, not "anywhere".** Neither AT Protocol nor ActivityPub has
  a global handle index, so this cannot reserve against "any handle anywhere" —
  only specific, resolvable namespaces. We pick the dominant one per protocol:
  **bsky.social** (the AT Proto mass-signup namespace) and **mastodon.social**
  (the largest single ActivityPub server). Other servers are out of scope.
- **Mastodon is a policy choice, not a collision.** `dave.bsky.social` and
  `dave.self.surf` are the _same_ protocol — reserving one for the other avoids
  an identity collision. `dave@mastodon.social` is a _different_ protocol;
  reserving against it is a deliberate stance that the mastodon.social `dave`
  deserves first claim. mastodon.social is one ActivityPub server among
  thousands — this privileges its users specifically, by design.
- **Hard block.** The real owner of `dave.bsky.social` / `dave@mastodon.social`
  also cannot claim `dave.self.surf` yet. An ownership-aware exception (prove the
  logged-in user controls the reserving account) is a future addition.
- **Audit is report-only.** No notices, no renames. Existing conflicting
  accounts are grandfathered. (The audit reports bsky.social conflicts only; it
  does not yet scan for mastodon.social conflicts.)

## License

This project is dual-licensed under MIT and/or Apache 2.0, choose at your discretion:

- MIT license ([LICENSE-MIT.txt](LICENSE-MIT.txt) or http://opensource.org/licenses/MIT)
- Apache License, Version 2.0, ([LICENSE-APACHE.txt](LICENSE-APACHE.txt) or http://www.apache.org/licenses/LICENSE-2.0)
