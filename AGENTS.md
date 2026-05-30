# AGENTS.md

This file provides guidance to coding agents (Claude Code, and others) when working with code in this repository.

## What this is

`aaa` (npm: `@attps/aaa`) reserves bare-name handles on the **self.surf** PDS (the AT Protocol
PDS behind [linkna.me](https://www.linkna.me)) against existing identities on other networks.
A bare name like `dave` is claimable on self.surf only if it is free across **all three**
namespaces: self.surf, `<name>.bsky.social` (AT Protocol), and `<name>@mastodon.social`
(ActivityPub). An existing account on any of them reserves the bare name.

This repo is a **standalone helper, not the deployed app.** linkname is not modified here —
`drop-in/check-handle-route.ts` is meant to be copied into linkname when ready. Nothing in
this repo runs in production; it produces a drop-in module, an audit report, and a CLI check.

## Commands

```bash
pnpm install            # or npm install
pnpm audit:handles      # enumerate self.surf, report bsky + mastodon conflicts (table)
pnpm audit:handles --csv conflicts.csv   # also write CSV (with reserved_by column)
pnpm audit:handles --bsky-only  # skip the mastodon.social pass (faster)
pnpm audit:handles --limit 500  # cap repos scanned, for a quick dry run
# (named audit:handles, not audit — `pnpm audit` is pnpm's built-in vulnerability scanner)
pnpm check dave         # spot-check one name (bsky + mastodon; self.surf only if secret set)
EPDS_INTERNAL_SECRET=… PDS_INTERNAL_URL=https://self.surf pnpm check dave  # full 3-namespace gate
pnpm typecheck          # tsc --noEmit
```

There is no test runner and no build step — `tsx` runs the TypeScript directly. `pnpm typecheck`
is the only correctness gate.

## Architecture

[src/reservation.ts](src/reservation.ts) is the **single source of truth** for the reservation
rule and is consumed by both the live route and the audit. Two non-negotiable design constraints:

1. **Fail closed.** Any inconclusive lookup (5xx, timeout, malformed body, empty 200) returns
   `status: 'error'` / `available: false`. A resolver or PDS outage must never let a reserved
   name through. When editing the resolution helpers, an unhandled case must default to `'error'`,
   not `'free'`. Only an _explicit_ not-found is `'free'` — `400` for AT Proto `resolveHandle`,
   `404` for Mastodon WebFinger/REST.
2. **Pure `fetch`, no SDKs.** The module targets the Next.js **edge runtime**. It must distinguish
   "definitely free" from "couldn't tell". Don't introduce the `@atproto` SDK, a Mastodon client,
   or any Node-only APIs into `src/reservation.ts`.

Resolution is three parallel checks, **taken-if-any** (`checkHandleAvailability`). Each namespace
has tiered fallbacks tried only on `'error'` (decisive answer wins immediately, no added latency);
a name is free only if some tier on **each** namespace decisively says so. See the README's "How
resolution works" for the full tier list. In brief:
- **bsky.social** (AT Proto, 3 tiers): AppView `resolveHandle` → bsky.social PDS `resolveHandle`
  → `<name>.bsky.social/.well-known/atproto-did`. `200 {did}` = reserved, `400`/`404` = free.
- **self.surf** (AT Proto, 2 tiers): ePDS `/_internal/check-handle` (authoritative, needs
  `x-internal-secret`) → self.surf PDS `resolveHandle` (public fallback). Skipped when `bskyOnly`.
- **mastodon.social** (ActivityPub, 2 tiers): WebFinger → REST `accounts/lookup`. `200`/`410`
  (suspended) = reserved, `404` = free. **Skipped for hyphenated names** — Mastodon usernames are
  `[A-Za-z0-9_]`, so a hyphenated name can never collide. Skipped when `skipMastodon`.

Two opt-outs exist so the audit can reuse the rule cheaply: `bskyOnly` (skip the self.surf check —
the audit enumerates self.surf itself via `listRepos` + PLC) and `skipMastodon` (test bsky.social
only, skipping the per-name WebFinger lookups for a faster pass). Adding a new namespace = a new
tiered resolver + a parallel branch in `checkHandleAvailability` + a `ReservationStatus` variant;
mirror the bsky/mastodon shape.

[scripts/audit.ts](scripts/audit.ts) uses **public APIs only** (no secret): `com.atproto.sync.listRepos`
on self.surf → resolve each DID's handle from `plc.directory` → keep `.self.surf` handles →
check each bare name against bsky.social **and** mastodon.social (pass `--bsky-only` to skip the
latter). Report-only; existing conflicts are grandfathered. Records one row per account, with which
namespace reserves the name (when both do, it reports `reserved-bsky`, mirroring the live gate's
precedence).

[drop-in/check-handle-route.ts](drop-in/check-handle-route.ts) imports from `@/lib/handle-reservation` —
that path is a placeholder for where `reservation.ts` lands **inside linkname**, not a path in this
repo. It preserves linkname's existing route contract: same format validation, and 503 + `available: false`
on the error path.

## Conventions

- ESM throughout (`"type": "module"`, `module: Node16`). Relative imports use the `.js` extension
  even for `.ts` files (e.g. `import { ... } from '../src/reservation.js'`) — required by Node16
  module resolution.
- The `HANDLE_REGEX` and length bounds in `validateBareHandle` mirror linkname's server-side check;
  keep them in sync with linkname if that validation changes.
- Intentional, not a bug: `aaa` reports a reserved name (`reserved-bsky` /
  `reserved-mastodon`) and **does not unblock it or verify ownership** — that is out of scope for
  this package by design. Reserved is not a permanent dead-end, though: the **app** can invite the
  real owner of `dave.bsky.social` / `dave@mastodon.social` to claim `dave.self.surf` by signing in
  with that account (OAuth — Bluesky reuses their existing PDS; Mastodon issues a new `dave.self.surf`
  PDS they control). Don't add an ownership check to `aaa`; that responsibility belongs to the app.
- The mastodon.social reservation is a deliberate **policy** choice, not a protocol collision:
  unlike bsky↔self.surf (same protocol), `@dave@mastodon.social` is ActivityPub and gives its
  users first claim on the self.surf name. It is one server among thousands — chosen as the
  dominant one. Don't "fix" this asymmetry; it's the design.
