<p align="center">
  <img src="https://raw.githubusercontent.com/attpslabs/aaa/main/nameplease.png" alt="Name, please?" width="600">
</p>

# Prior art: bridging and reconciling identity across AT Protocol and ActivityPub

`aaa` answers a narrow question: **may a new, unrelated user claim the bare name
`dave` on self.surf, given that `dave` may already belong to someone on
bsky.social or mastodon.social?** It resolves that question fail-closed and
reserves the name if anyone holds it elsewhere.

That is a _policy / namespace-arbitration_ question. Almost everything else built
in this space answers a different one — _how do I connect a single identity to
both protocols?_ (bridge, dual-attach, or translate). The distinction matters,
because it means the existing projects don't compete with `aaa` so much as sit
next to it: they move identities across the boundary; `aaa` decides who is
allowed to hold a name in the first place.

This document summarizes what each surveyed project actually does at the code
level — not what its README claims — and how it relates to bare-name
reservation. Findings are from reading the repositories directly (May 2026).

## TL;DR

| Project | What it is | Collision / namespace strategy | Relation to `aaa` |
| --- | --- | --- | --- |
| **Wafrn** | Dual-attach server: one DB row carries both an AP actor and an ATProto DID | **Fail-open** — lets the collision happen, then renames the _existing_ user to `@handle.invalid…` | Inverse of `aaa`; the canonical anti-pattern |
| **Bridgy Fed** | Bridge with a pluggable `Protocol` class per network | Avoid by construction — the source protocol is baked into the bridged subdomain (`…​.ap.brid.gy`), so there is no shared bare-name space | Best architecture reference; but has no bare-name namespace to arbitrate |
| **granary / lexrpc** | Translation/transport libraries under Bridgy Fed | None (out of scope) | Reusable handle⇄DID primitives; not adopted (would break zero-dep, edge-safe) |
| **Bonfire `activity_pub`** | An ActivityPub federation library (Elixir) | Naive `name + host` concatenation in the adapter | Multi-protocol identity is **roadmap, not code** |
| **Pandacap** | Single-user polyglot _reader_ | N/A — serves no ATProto identity of its own | No collision surface; not applicable |
| **Berjon, _ActivityPub Over ATProto_** | A design proposal for resolving AP handles through `resolveHandle` | **Explicitly unaddressed** — calls it an open question | Closest intellectual peer; `aaa` is a concrete answer to the gap he leaves open |
| **FEP-EF61 "Portable Objects"** | A spec for portable `did:key` identity + gateways | N/A — purely cryptographic identifiers, no human-readable handles | Operates one layer _below_ `aaa`; complementary, not competing |

**The bottom line:** none of the surveyed _code_ does cross-namespace bare-name
reservation. The only true peers are the two _specs_, and the closest of those
(Berjon) raises exactly the collision/first-claim question `aaa` answers and
then leaves it open.

---

## The bridges and dual-attach servers — _connect_, don't _reserve_

### Wafrn (`gabboman/wafrn`) — dual-attach, fail-open, reactive rename

The most instructive contrast, because it is superficially the closest design
(one database, both protocols) yet architecturally the opposite of `aaa`.

- A single `users` row carries **both** an ATProto DID (`bskyDid`) and an
  ActivityPub actor (`remoteId`); a local account opts into Bluesky and links
  the two.
- Registration checks uniqueness only against **Wafrn's own DB** — never
  bsky.social or mastodon.social. PDS account creation sanitizes the name and
  calls `createAccount` with **no availability pre-check** against any external
  namespace.
- On a collision it **fails open**: when an incoming Bluesky handle clashes with
  an existing local user, it renames the _existing_ user to
  `@handle.invalid<did><url>` and lets the newcomer keep the name.

This is the exact inverse of `aaa`'s fail-closed stance. Wafrn lets the
collision occur and repairs it afterward; `aaa` refuses the signup up front.
Useful precisely as the "what we deliberately do _not_ do" reference.

### Bridgy Fed (`snarfed/bridgy-fed`) — gold-standard adapter design, deterministic 1:1, no reservation

Ryan Barrett's bridge is the best _architecture_ reference in this set: a base
`Protocol` class with `ATProto` / `ActivityPub` / `Web` subclasses and a unified
`User`/`Object` model. The handle-resolution mechanism is real and deployed —
`GET /.well-known/atproto-did?protocol=ap&id=alice@instance.com` looks up the
bridged user and returns its DID as plain text.

But for the reservation question the key fact is: **Bridgy Fed avoids collisions
by construction, not by reservation.** The bridged handle bakes the source
protocol into the domain:

- `@alice@social.example` (AP) → `alice.social.example.ap.brid.gy`
- `alice.com` (Web) → `alice.com.web.brid.gy`

So `alice` from AP and `alice` from Web never collide — they live in different
subdomains. There is no shared bare-name namespace, and therefore no notion of
"first claim on bare `alice`." That is the opposite of what a PDS handing out a
clean bare `alice.self.surf` needs.

The reusable lesson: Bridgy Fed's `atproto-did?protocol=&id=` redirect is exactly
the resolution surface `aaa` _probes_. If self.surf ever bridges, this is the
contract to mirror. As a _reservation_ reference, it confirms there is no prior
art to copy — only a mechanism to check against.

### granary / lexrpc (`snarfed/granary`, `snarfed/lexrpc`) — reusable primitives, not a system

The translation/transport libraries beneath Bridgy Fed. No reservation logic, as
expected. Worth knowing:

- **granary** does handle→DID via the same
  `com.atproto.identity.resolveHandle(handle=…)['did']` call `aaa` uses, plus
  `did:web` ⇄ URL helpers and an actor/profile translator between AS1 and
  Bluesky lexicons.
- **lexrpc** has a strict lowercase handle / `DOMAIN_RE` validator and an AT-URI
  parser that accepts either a DID or a domain.

Honest take: **nothing here to adopt.** `aaa` is deliberately zero-dependency,
pure-`fetch`, edge-runtime-safe; pulling in granary (Python, heavyweight) would
defeat that. Their handle regexes are still a useful cross-check that `aaa`'s
`HANDLE_REGEX` and its AT-Proto/Mastodon outcome mappings match the ecosystem.

### Bonfire `activity_pub` (`bonfire-networks/activity_pub`) — clean adapter, multi-protocol is roadmap-only

A clean Elixir adapter `@behaviour` defines the boundary the host app (Bonfire)
implements — `get_actor_by_username`, `maybe_create_remote_actor`, etc. —
with standard WebFinger resolution. Good reference for a pluggable identity
boundary.

But the multi-protocol story is **aspirational, not implemented**: grepping the
whole repository for `atproto` / `matrix` / `xmpp` / `bridge` returns nothing.
The protocol-agnostic framing belongs to _Bonfire_ (the host app); the library
itself is 100% ActivityPub today, and its only collision strategy is naive
`name + host` concatenation in the test adapter. Don't over-weight the
"moving toward protocol-agnostic" framing — as code it's an AP-only adapter.

### Pandacap (`IsaacSchemm/Pandacap`) — minimal polyglot, but serves no ATProto identity

Confirmed at the code level: it serves ActivityPub via WebFinger + an actor
endpoint, but there is **no `/.well-known/atproto-did` and no `did.json`** — its
ATProto support is purely _consuming_ feeds (its DID resolver only reads remote
DIDs). So it has zero collision surface and nothing to say about reservation. A
nice composite-resolver pattern for reading; irrelevant to a signup gate.

---

## The specs — the real intellectual peers

### Robin Berjon, _ActivityPub Over ATProto_ — same problem, resolution proposed, policy left open

The one true match to `aaa`'s domain. Berjon proposes that
`com.atproto.identity.resolveHandle` could resolve `@robin@mastodon.social` just
as it resolves `@robin.berjon.com`: drop the leading `@`, replace the other with
a `.` → `robin.mastodon.social`, then resolve the DID, with the actor document
and DID document cross-linking.

Crucially, he **does not address collisions or first-claim governance** — he
frames the piece as a "design provocation" and notes he is "probably missing
some snags." That gap is precisely where `aaa` lives.

Two things to keep straight:

1. **`aaa` is a concrete, deployed, fail-closed answer to the open governance
   question Berjon raises.** He proposes the _resolution_ mechanism; he punts on
   the _policy_ (who owns bare `robin`?). `aaa` is that policy.
2. **The stances differ in what they preserve.** Berjon maps
   `@robin@mastodon.social` to a _namespaced_ handle (`robin.mastodon.social`).
   `aaa` instead treats the existence of `robin@mastodon.social` as a reason to
   _block bare `robin.self.surf`_ — collapsing to the bare name and reserving it.
   The docs should not conflate the two: one keeps the namespace in the handle,
   the other reserves the bare name.

Article: https://www.berjon.com/ap-at/

### FEP-EF61 "Portable Objects" — identity-layer unification, below the handle question

A spec for portable `did:key`-based identity (a MultiDID base58-encoded as a
`did:key`), resolved via a `/.well-known/apgateway` endpoint and WebFinger
reverse-discovery. It is purely about **cryptographic identifiers and gateways**
— it says **nothing about human-readable handles or namespace mapping**. (The
"wrap an atproto DID as a `did:key`" idea is a separate atproto-side proposal
layered on top, not part of EF61 itself.)

Relevant as the long-term "one DID resolvable on both networks" direction, but
it operates a layer _below_ `aaa`: EF61 unifies the _DID_; `aaa` arbitrates the
human-readable _bare name_. A name-reservation policy still has to exist even if
EF61 lands. Complementary, not competing.

Spec: https://codeberg.org/fediverse/fep/src/branch/main/fep/ef61/fep-ef61.md

---

## What this means for `aaa`

1. **`aaa` occupies an empty seat.** Bridges and dual-attach servers _connect_
   identities; specs _unify_ DIDs. None of them arbitrates who may claim a bare
   human-readable name across protocols. That arbitration is `aaa`'s entire
   contribution.
2. **The two design poles to cite are Wafrn and Berjon.** Wafrn shows the
   fail-open path `aaa` rejects (let the collision happen, rename afterward).
   Berjon names the exact question `aaa` answers and leaves it open. Together
   they bracket the case for a fail-closed reservation gate.
3. **Track FEP-EF61 and the atproto DID-wrapping work** as the future that could
   make the _resolution_ half of this problem obsolete — but the _policy_ half
   (`aaa`'s job) survives regardless of how identities are resolved.

---

_Method note: all repositories were cloned and read directly (handlers, models,
resolution code), not summarized from their READMEs. Where a project's
documentation claims capabilities the code does not yet contain (notably Bonfire's
multi-protocol framing), this document reflects the code._
