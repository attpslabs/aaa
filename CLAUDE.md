# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The authoritative guidance lives in [AGENTS.md](AGENTS.md) — read it first. It covers what this
repo is, the commands, the architecture, and the conventions, and is kept in sync with the code.
This file only flags the points most likely to trip up an edit.

## Critical invariants (do not break)

- **Fail closed.** In [src/reservation.ts](src/reservation.ts), any inconclusive lookup (5xx,
  timeout, malformed/empty body) must yield `status: 'error'` / `available: false`. Only an
  _explicit_ not-found is `'free'` — `400` for AT Proto `resolveHandle`, `404` for Mastodon. A new
  or unhandled branch must default to `'error'`, never `'free'`.
- **Pure `fetch`, no SDKs.** `reservation.ts` targets the Next.js edge runtime. Do not add
  `@atproto`, a Mastodon client, or any Node-only API to it. (`scripts/` and `drop-in/` run under
  tsx/Node and are not edge-constrained, but keep the rule itself in `reservation.ts` SDK-free.)
- **Single source of truth.** The reservation rule lives only in `reservation.ts`; the audit and
  the drop-in route both consume it. Don't fork the logic.

## Commands

```bash
pnpm install
pnpm typecheck   # tsc --noEmit — the ONLY correctness gate (no test runner, no build for dev)
pnpm audit       # enumerate self.surf, report bsky.social conflicts; --csv <file>, --limit N
pnpm check dave  # spot-check one name
pnpm build       # tsc -p tsconfig.build.json → dist/ (only needed before publish)
```

`tsx` runs the TypeScript directly — there is no dev build step.

## Editing gotchas

- ESM + `module: Node16`: relative imports use the `.js` extension even for `.ts` files
  (`from '../src/reservation.js'`). Omitting it fails resolution.
- `HANDLE_REGEX` / length bounds in `validateBareHandle` mirror linkname's server-side check —
  keep them in sync if that validation changes.
- This repo is a standalone helper, **not** the deployed app. Nothing here runs in production;
  `drop-in/check-handle-route.ts` is copied into linkname when ready, and its
  `@/lib/handle-reservation` import is a placeholder for where `reservation.ts` lands there.
- Behaviors that look like bugs but are intentional design (don't "fix" them): the hard block on
  the real account owner, and reserving against mastodon.social as a policy choice. See AGENTS.md.
