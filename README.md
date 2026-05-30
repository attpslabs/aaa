# handle-guard

Treat existing **`<name>.bsky.social`** accounts as first-class AT Protocol
citizens when handing out handles on the **self.surf** PDS (the one behind
[linkna.me](https://www.linkna.me)).

**The rule:** a bare name like `dave` is claimable on self.surf only if it is
taken on **neither** self.surf **nor** bsky.social. If `dave.bsky.social`
resolves to a real DID, nobody can register `dave.self.surf` — a **hard block
for everyone** (including the real owner of `dave.bsky.social`, for now).

## What's here

| Path | Purpose |
| --- | --- |
| `src/reservation.ts` | The reservation rule. Single source of truth, fail-closed. Used by both the route and the audit. |
| `drop-in/check-handle-route.ts` | Ready-to-install replacement for linkname's `src/app/api/auth/check-handle/route.ts`. |
| `scripts/audit.ts` | Reports existing self.surf accounts whose bare name is a live bsky.social handle. Report only. |
| `scripts/check.ts` | Spot-check a single name from the CLI. |

linkname itself is **not modified** — wire the drop-in in when you're ready.

## Setup

```bash
cd ~/Documents/attps/handle-guard
pnpm install        # or npm install
```

## Run the audit (existing conflicts)

Public APIs only — no secret required. It enumerates self.surf via
`com.atproto.sync.listRepos`, resolves each DID's handle from the PLC
directory, then checks each bare name against bsky.social.

```bash
pnpm audit                    # table to stdout
pnpm audit --csv conflicts.csv
pnpm audit --limit 500        # cap repos scanned, for a quick dry run
```

Your `/dave` account will appear here if `dave.bsky.social` exists.

## Spot-check one name

```bash
pnpm check dave               # bsky-only unless the secret is set
EPDS_INTERNAL_SECRET=… PDS_INTERNAL_URL=https://self.surf pnpm check dave   # full gate
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

- **bsky.social side:** `GET public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=<name>.bsky.social`
  — `200 {did}` = reserved, `400` = free, anything else = inconclusive (→ blocked).
- **self.surf side:** the existing ePDS `GET /_internal/check-handle` endpoint
  (`{ exists: boolean }`), authenticated with `x-internal-secret`.
- Both run in parallel; taken-if-either.

## Scope / caveats

- **bsky.social only.** There is no global handle index in AT Protocol, so this
  cannot reserve against "any handle anywhere" — only specific resolvable FQDNs.
  bsky.social is the mass-signup namespace, which is the case that matters.
- **Hard block.** The real owner of `dave.bsky.social` also cannot claim
  `dave.self.surf` yet. An ownership-aware exception (verify the logged-in
  user's DID == `dave.bsky.social`'s DID) is a future addition.
- **Audit is report-only.** No notices, no renames. Existing conflicting
  accounts are grandfathered.
