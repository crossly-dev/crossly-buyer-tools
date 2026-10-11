#!/usr/bin/env -S npx tsx
/**
 * Find listings priced below what comparable ones are going for.
 *
 *   npx tsx deal-scanner.ts scan --brand Nike --min-discount 25
 *   npx tsx deal-scanner.ts scan --category shoes --under 200 --json
 *   npx tsx deal-scanner.ts watch --brand Nike --min-discount 30 --url https://you/hook
 *
 * ── WHAT "A DEAL" MEANS HERE, AND WHAT IT DOES NOT ───────────────────
 * Two independent signals, reported separately rather than blended into one
 * score, because they fail in different ways and a single number hides which
 * one fired:
 *
 *   MARKDOWN   the seller's own compare-at price is above the ask. Reliable
 *              when present, and the API never fabricates it — a compare-at
 *              equal to or below the ask is dropped server-side rather than
 *              shown as a 0% discount.
 *
 *   PEER       the ask is below the median of comparable listings — same
 *              brand, same category, same condition. This is an estimate and
 *              is labelled as one.
 *
 * MEDIAN, not mean: marketplace prices are long-tailed, and one mispriced
 * $9,000 listing drags a mean far enough that everything below it looks like a
 * bargain. The median ignores it.
 *
 * Peer comparison needs a real peer group. Below MIN_PEERS the comparison is
 * reported as `insufficient_data` instead of a number — "23% below the average
 * of two listings" is noise wearing a percentage sign, and a scanner that
 * emits it will find "deals" all day.
 */
import { CrosslyBuyer } from './lib/client.js';
import { dollarsToCents, parseArgs, requireToken, text, type ParsedArgs } from './lib/cli.js';
import type { CatalogItem, MonitorQuery, SearchFilters } from './lib/types.js';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'scan';

/** Below this, a peer comparison is not evidence. */
const MIN_PEERS = 5;

if (cmd === 'help') {
  usage();
  process.exit(0);
}

/** How much of the catalogue to consider per scan. */
const SCAN_CAP = Number(args.flags.cap ?? 2000);

const client = new CrosslyBuyer({
  token: requireToken(['Set CROSSLY_TOKEN to a buyer token (crossly_oat_…).']),
});

if (cmd === 'scan') await scan(client, args);
else if (cmd === 'watch') await watch(client, args);
else {
  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(2);
}

// ── Commands ─────────────────────────────────────────────────────────

interface Deal {
  slug: string;
  title: string;
  priceCents: number;
  /** Percent below the seller's own compare-at price, or null when there is none. */
  markdownPct: number | null;
  /** Percent below the peer median, or null when the peer group is too small. */
  vsPeersPct: number | null;
  peerMedianCents: number | null;
  peerCount: number;
  peerConfidence: 'ok' | 'insufficient_data';
  url: string;
  seller: string | null;
  quantityAvailable: number;
}

async function scan(c: CrosslyBuyer, { flags: a }: ParsedArgs): Promise<void> {
  const filters: SearchFilters = {};
  if (a.query) filters.q = text(a.query);
  if (a.brand) filters.brand = text(a.brand);
  if (a.category) filters.category = text(a.category);
  if (a.condition) filters.condition = text(a.condition);
  if (a.under) filters.maxPriceCents = dollarsToCents(a.under);
  if (a.over) filters.minPriceCents = dollarsToCents(a.over);

  const items: CatalogItem[] = [];
  for await (const item of c.walk(filters)) {
    items.push(item);
    if (items.length >= SCAN_CAP) break;
  }

  if (!items.length) {
    console.error('Nothing matched those filters.');
    return;
  }

  const peers = groupPeers(items);
  const minDiscount = Number(a['min-discount'] ?? 20);

  const deals: Deal[] = [];
  for (const item of items) {
    const markdown = item.compareAtCents
      ? pct(item.compareAtCents - item.priceCents, item.compareAtCents)
      : null;

    const group = peers.get(peerKey(item));
    const peerMedian = group && group.length >= MIN_PEERS ? median(group) : null;
    const vsPeers = peerMedian ? pct(peerMedian - item.priceCents, peerMedian) : null;

    const best = Math.max(markdown ?? 0, vsPeers ?? 0);
    if (best < minDiscount) continue;

    deals.push({
      slug: item.slug,
      title: item.title,
      priceCents: item.priceCents,
      markdownPct: markdown,
      vsPeersPct: vsPeers,
      peerMedianCents: peerMedian,
      peerCount: group ? group.length : 0,
      peerConfidence: peerMedian ? 'ok' : 'insufficient_data',
      url: item.url,
      seller: item.sellerUsername,
      quantityAvailable: item.quantityAvailable,
    });
  }

  deals.sort((x, y) => bestOf(y) - bestOf(x));

  if (a.json) {
    for (const d of deals) console.log(JSON.stringify(d));
    return;
  }

  console.error(`Scanned ${items.length} listings. ${deals.length} at or above ${minDiscount}%.\n`);
  for (const d of deals.slice(0, Number(a.top ?? 40))) {
    const price = `$${(d.priceCents / 100).toFixed(2)}`;
    const md = d.markdownPct != null ? `${d.markdownPct.toFixed(0)}% off` : '';
    const vp =
      d.vsPeersPct != null
        ? `${d.vsPeersPct.toFixed(0)}% under median of ${d.peerCount}`
        : d.peerCount
          ? `only ${d.peerCount} peers — no estimate`
          : '';
    console.log(`${price.padStart(10)}  ${[md, vp].filter(Boolean).join('  ·  ')}`);
    console.log(`            ${d.title}`);
    console.log(`            ${d.url}`);
  }
}

/**
 * Standing version: a monitor for anything new matching the filters.
 *
 * The scanner above answers "what is underpriced right now"; this answers
 * "tell me when something underpriced appears", which is the question people
 * actually want answered and the one that otherwise becomes a polling loop.
 */
async function watch(c: CrosslyBuyer, { flags: a }: ParsedArgs): Promise<void> {
  const query: MonitorQuery = {};
  if (a.query) query.q = text(a.query);
  if (a.brand) query.brand = text(a.brand);
  if (a.category) query.category = text(a.category);
  if (a.under) query.maxPriceCents = dollarsToCents(a.under);

  const url = text(a.url);
  const monitor = await c.createMonitor({
    name: `deals: ${text(a.brand ?? a.category ?? a.query) ?? 'everything'}`,
    kind: 'new_listing',
    query,
    delivery: url ? 'webhook' : 'poll',
    ...(url ? { webhookUrl: url } : {}),
  });

  console.log(`Created monitor ${monitor.id}.`);
  if (monitor.webhookSecret) {
    console.log(`  Signing secret (shown once): ${monitor.webhookSecret}`);
    console.log(`  Receive + verify: npx tsx monitor.ts serve --secret ${monitor.webhookSecret}`);
  }
  console.log('');
  console.log('  Score each delivery with the same logic as `scan` — the event carries the');
  console.log('  full listing, so you do not need a second request to decide.');
}

// ── Scoring ──────────────────────────────────────────────────────────

/**
 * Comparable = same brand, same category, same condition.
 *
 * Condition belongs in the key. A used item priced below the median of a group
 * that is mostly new is not a deal, it is a used item — and a scanner that
 * ignores condition reports exactly that, all day, as its best find.
 */
function peerKey(item: CatalogItem): string {
  return [
    (item.brand ?? '').toLowerCase(),
    (item.categoryMain ?? '').toLowerCase(),
    (item.condition ?? '').toLowerCase(),
  ].join('|');
}

/** Peer key to the asking prices (cents) in that group. */
function groupPeers(items: readonly CatalogItem[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const item of items) {
    const k = peerKey(item);
    let group = groups.get(k);
    if (!group) {
      group = [];
      groups.set(k, group);
    }
    group.push(item.priceCents);
  }
  return groups;
}

/** Callers pass a non-empty group (at least MIN_PEERS values). */
function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function pct(part: number, whole: number): number | null {
  if (!whole) return null;
  return (part / whole) * 100;
}

function bestOf(d: Deal): number {
  return Math.max(d.markdownPct ?? 0, d.vsPeersPct ?? 0);
}

// ── plumbing ─────────────────────────────────────────────────────────

function usage(): void {
  console.log(`
Find underpriced listings. Two signals, reported separately:
  markdown  — the seller's own compare-at price, never fabricated
  vs peers  — below the MEDIAN of same brand + category + condition
              (suppressed below ${MIN_PEERS} peers rather than guessed)

  scan   [--brand X] [--category Y] [--condition Z] [--under 200]
         [--min-discount 20] [--top 40] [--cap 2000] [--json]

  watch  [--brand X] [--url <webhook>]
         Standing monitor for new matches, so you stop polling.

Environment: CROSSLY_TOKEN, optionally CROSSLY_API_BASE.
`);
}
