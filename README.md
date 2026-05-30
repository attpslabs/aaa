<p align="center">
  <img src="https://raw.githubusercontent.com/attpslabs/aaa/main/aaa.png" alt="aaa" width="200">
</p>

# aaa

[![npm](https://img.shields.io/npm/v/@attps/aaa.svg)](https://www.npmjs.com/package/@attps/aaa)

Treat the Bluesky & Mastodon application userbase as first-class citizens of the open social web.

**The rule:** a bare name like `alice` is claimable on self.surf only if it is
free across **all three** namespaces: bsky.social, 
mastodon.social, and self.surf. If `alice.bsky.social` resolves to a DID, **and/or**
`alice@mastodon.social` is a registered account, 
`alice.self.surf` remains unclaimable, the name remains **reserved**. The controller of alice.bsky.social / alice@mastodon.social can claim alice.self.surf via OAuth login; attps/aaa is for apps that display a username for onboarding new people to their social, that want to federate with the wider open social web.

**Supported namespaces:** 
- .bsky.social,
- @mastodon.social.

**OAuth login:** The support of OAuth login is dependent per app, apps may decide to use Email OTP for anonymous accounts and/or private permissioned spaces. Apps may decide to OAuth non-open social web accounts for a method of onboarding onto a DID.

**Bare names**
The motivation is to achieve clean usernames while respecting people, creators and businesses that have already claimed a username. It is impossible to achieve clean usernames that would respect all servers (PDS & APS), this is an opinionated path that will update over time. See: [Scope / caveats](#scope--caveats).

## What's here

| Path | Purpose |
| --- | --- |
| `src/reservation.ts` | The reservation rule across all three namespaces. Single source of truth, fail-closed. Used by both the route and the audit. |
| `drop-in/check-handle-route.ts` | Ready-to-install replacement for linkname's `src/app/api/auth/check-handle/route.ts`. |
| `scripts/audit.ts` | Reports existing self.surf accounts whose bare name is a live bsky.social handle. Report only. |
| `scripts/check.ts` | Spot-check a single name from the CLI. |

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

## Issue1 TODO: Run the audit (existing conflicts)

Public APIs only — no secret required. It enumerates self.surf via
`com.atproto.sync.listRepos`, resolves each DID's handle from the PLC directory
(falling back to the PDS's own `com.atproto.repo.describeRepo` if PLC is
unreachable), then checks each bare name against **both reserved namespaces** —
bsky.social and mastodon.social — using the same tiered resolver as the live
gate. The CSV records which namespace reserves each name (`reserved_by`).

```bash
pnpm audit:handles                  # table to stdout (bsky.social + mastodon.social)
pnpm audit:handles --csv conflicts.csv
pnpm audit:handles --bsky-only      # skip mastodon.social for a faster pass
pnpm audit:handles --limit 500      # cap repos scanned, for a quick dry run
```

> The script is named `audit:handles`, not `audit`, because `pnpm audit` is
> pnpm's built-in vulnerability scanner and would shadow it.

Your `/alice` account will appear here if `alice.bsky.social` or
`alice@mastodon.social` exists.

## Spot-check one name

```bash
pnpm check alice               # bsky + mastodon; self.surf only if the secret is set
EPDS_INTERNAL_SECRET=… PDS_INTERNAL_URL=https://self.surf pnpm check alice   # full 3-namespace gate
```

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
- **Mastodon is a policy choice, not a collision.** `alice.bsky.social` and
  `alice.self.surf` are the _same_ protocol — reserving one for the other avoids
  an identity collision. `alice@mastodon.social` is a _different_ protocol;
  reserving against it is a deliberate stance that the mastodon.social `alice`
  deserves first claim. mastodon.social is one ActivityPub server among
  thousands — this privileges its users specifically, by design.
- **Reserved is not a dead-end — the app offers an OAuth claim path.** `aaa`'s
  job ends at detecting the conflict: it reports `reserved-bsky` /
  `reserved-mastodon`. What happens next is the **app's** responsibility, not
  this package's. When the gate reports a name reserved by an existing
  `alice.bsky.social` / `alice@mastodon.social`, the app can invite that person to
  claim `alice.self.surf` by signing in with the reserving account:
  - **Sign in with Bluesky** (OAuth) — the user keeps their existing
    `alice.bsky.social` PDS.
  - **Sign in with Mastodon** (OAuth) — a new `alice.self.surf` PDS is issued
    that the user controls via their Mastodon account.

  `aaa` does not perform or verify this claim — it neither knows who is logged in
  nor unblocks anything itself. It just surfaces the conflict (with a `reason`)
  so the app can route to the right OAuth flow.
- **Audit is report-only.** No notices, no renames. Existing conflicting
  accounts are grandfathered. The audit scans **both** bsky.social and
  mastodon.social by default (`--bsky-only` skips the Mastodon pass).

## Related work — and why `aaa`

Plenty of projects work across AT Protocol and ActivityPub, but they answer a
different question than `aaa` does. They _connect_ a single identity to both
networks — bridge it, dual-attach it, or translate between the two. `aaa` asks
who is _allowed to claim a bare name_ in the first place, given that someone may
already hold it elsewhere. That arbitration is an empty seat none of them fill.

- **Bridges & dual-attach servers** ([Bridgy Fed](https://github.com/snarfed/bridgy-fed),
  [Wafrn](https://github.com/gabboman/wafrn)) move identities across the
  boundary. Bridgy Fed avoids name clashes _by construction_ — it bakes the
  source protocol into the bridged subdomain (`alice.social.example.ap.brid.gy`),
  so there is no shared bare-name space to fight over. Wafrn does the opposite of
  `aaa`: it lets the collision happen and **renames the existing user**
  afterward. `aaa` instead refuses the new signup up front — **fail closed.**
- **Robin Berjon, _[ActivityPub Over ATProto](https://www.berjon.com/ap-at/)_**
  is the closest peer. He proposes that `com.atproto.identity.resolveHandle`
  could resolve `@robin@mastodon.social` the way it resolves `@robin.berjon.com`
  — and then explicitly leaves the collision / first-claim question open, calling
  it a "design provocation." **`aaa` is a concrete, deployed, fail-closed answer
  to exactly that open question.**
- **[FEP-EF61 "Portable Objects"](https://codeberg.org/fediverse/fep/src/branch/main/fep/ef61/fep-ef61.md)**
  unifies identity one layer _below_ this: a portable `did:key` resolvable on
  both networks. Even if it lands, someone still has to decide who gets the
  human-readable bare name — which is `aaa`'s job. Complementary, not competing.

A fuller, code-level survey of these projects (read from the source, not their
READMEs) is in [docs/prior-art.md](docs/prior-art.md).

## License

This project is dual-licensed under MIT and/or Apache 2.0, choose at your discretion:

- MIT license ([LICENSE-MIT.txt](LICENSE-MIT.txt) or http://opensource.org/licenses/MIT)
- Apache License, Version 2.0, ([LICENSE-APACHE.txt](LICENSE-APACHE.txt) or http://www.apache.org/licenses/LICENSE-2.0)
