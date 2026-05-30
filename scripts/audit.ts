#!/usr/bin/env node
/**
 * Audit existing self.surf accounts for bsky.social conflicts.
 *
 * Reports every account `<name>.self.surf` whose bare name is ALSO a live
 * `<name>.bsky.social` handle. Under the new reservation rule these accounts
 * could not have been created today. Report only — no notices, no renames.
 *
 * Strategy (public APIs only, no secret required):
 *   1. com.atproto.sync.listRepos on self.surf  -> every hosted DID (paginated)
 *   2. for each DID, read its current handle from the PLC directory DID doc
 *   3. if the handle ends in `.self.surf`, resolve `<name>.bsky.social`
 *   4. emit a report of the conflicts (table + CSV)
 *
 * Usage:
 *   pnpm tsx scripts/audit.ts                 # table to stdout
 *   pnpm tsx scripts/audit.ts --csv out.csv   # also write CSV
 *   pnpm tsx scripts/audit.ts --limit 500     # cap repos scanned (debug)
 */

import { writeFileSync } from 'node:fs';
import {
  PDS_URL,
  PDS_DOMAIN,
  RESERVED_DOMAIN,
  checkHandleAvailability,
} from '../src/reservation.js';

const PLC_DIRECTORY = 'https://plc.directory';
/** PDS host that actually stores these repos — used to confirm a DID's handle. */
const AUDIT_PDS_URL = PDS_URL;
const RESOLVE_CONCURRENCY = 8;

interface RepoEntry {
  did: string;
}

interface Conflict {
  did: string;
  selfSurfHandle: string;
  bareName: string;
  bskyHandle: string;
}

function parseArgs(argv: string[]): { csvPath?: string; limit?: number } {
  const out: { csvPath?: string; limit?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--csv') out.csvPath = argv[++i];
    else if (argv[i] === '--limit') out.limit = Number(argv[++i]);
  }
  return out;
}

/** Page through com.atproto.sync.listRepos to collect every hosted DID. */
async function listAllRepos(limit?: number): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(`${PDS_URL}/xrpc/com.atproto.sync.listRepos`);
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      throw new Error(`listRepos failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    const data = (await res.json()) as { repos?: RepoEntry[]; cursor?: string };
    for (const r of data.repos ?? []) {
      repos.push(r);
      if (limit && repos.length >= limit) return repos;
    }
    cursor = data.cursor;
    process.stderr.write(`\r  fetched ${repos.length} repos...`);
  } while (cursor);
  process.stderr.write('\n');
  return repos;
}

/**
 * PRIMARY DID->handle: the PLC directory document's `alsoKnownAs`.
 * plc.directory is the canonical DID registry, run independently of the PDS.
 */
async function handleForDidViaPlc(did: string): Promise<string | null> {
  try {
    const res = await fetch(`${PLC_DIRECTORY}/${encodeURIComponent(did)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as { alsoKnownAs?: string[] };
    const aka = doc.alsoKnownAs?.find((a) => a.startsWith('at://'));
    return aka ? aka.slice('at://'.length) : null;
  } catch {
    return null;
  }
}

/**
 * FALLBACK DID->handle: ask the PDS itself via `com.atproto.repo.describeRepo`.
 * Independent of plc.directory (reads the PDS's own store), so it covers a PLC
 * outage. Returns the handle only when the PDS reports it as correct, to avoid
 * trusting a stale/unverified handle field.
 */
async function handleForDidViaDescribeRepo(did: string): Promise<string | null> {
  try {
    const url = `${AUDIT_PDS_URL}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(
      did,
    )}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const doc = (await res.json()) as { handle?: string; handleIsCorrect?: boolean };
    if (!doc.handle || doc.handleIsCorrect === false) return null;
    return doc.handle;
  } catch {
    return null;
  }
}

/**
 * Resolve a DID's currently-declared handle. PLC directory first (canonical),
 * the PDS's own describeRepo as an independent fallback when PLC is unreachable.
 */
async function handleForDid(did: string): Promise<string | null> {
  if (!did.startsWith('did:plc:')) return null; // self.surf uses did:plc
  return (await handleForDidViaPlc(did)) ?? (await handleForDidViaDescribeRepo(did));
}

/** Simple bounded-concurrency map. */
async function mapPool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

async function main() {
  const { csvPath, limit } = parseArgs(process.argv.slice(2));

  console.error(`Enumerating accounts on ${PDS_URL} ...`);
  const repos = await listAllRepos(limit);
  console.error(`Resolving handles for ${repos.length} DIDs ...`);

  const handles = await mapPool(repos, RESOLVE_CONCURRENCY, async (repo) => ({
    did: repo.did,
    handle: await handleForDid(repo.did),
  }));

  // Keep only accounts that are actually on the self.surf namespace.
  const selfSurf = handles.filter(
    (h): h is { did: string; handle: string } =>
      !!h.handle && h.handle.endsWith(`.${PDS_DOMAIN}`),
  );
  console.error(`${selfSurf.length} accounts on .${PDS_DOMAIN}; checking bsky.social ...`);

  const conflicts: Conflict[] = [];
  await mapPool(selfSurf, RESOLVE_CONCURRENCY, async (acct) => {
    const bareName = acct.handle.slice(0, -1 * (`.${PDS_DOMAIN}`).length);
    // bskyOnly: we already know the self.surf side; just test the reservation.
    // skipMastodon: this audit reports bsky.social conflicts only.
    const result = await checkHandleAvailability(bareName, { bskyOnly: true, skipMastodon: true });
    if (result.status === 'reserved-bsky') {
      conflicts.push({
        did: acct.did,
        selfSurfHandle: acct.handle,
        bareName,
        bskyHandle: `${bareName}.${RESERVED_DOMAIN}`,
      });
    }
  });

  conflicts.sort((a, b) => a.bareName.localeCompare(b.bareName));

  // ---- Report ----
  console.log('');
  console.log(`Conflicts: ${conflicts.length} of ${selfSurf.length} .${PDS_DOMAIN} accounts`);
  console.log('(self.surf accounts whose bare name is a live bsky.social handle)');
  console.log('');
  if (conflicts.length) {
    const w = Math.max(...conflicts.map((c) => c.selfSurfHandle.length), 16);
    console.log(`${'self.surf handle'.padEnd(w)}  ${'bsky.social handle'.padEnd(w)}  did`);
    console.log(`${'-'.repeat(w)}  ${'-'.repeat(w)}  ${'-'.repeat(30)}`);
    for (const c of conflicts) {
      console.log(`${c.selfSurfHandle.padEnd(w)}  ${c.bskyHandle.padEnd(w)}  ${c.did}`);
    }
  }

  if (csvPath) {
    const rows = [
      'self_surf_handle,bsky_social_handle,bare_name,did',
      ...conflicts.map((c) => `${c.selfSurfHandle},${c.bskyHandle},${c.bareName},${c.did}`),
    ];
    writeFileSync(csvPath, rows.join('\n') + '\n');
    console.error(`\nWrote ${conflicts.length} rows to ${csvPath}`);
  }
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
