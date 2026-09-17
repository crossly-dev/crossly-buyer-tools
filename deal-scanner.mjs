#!/usr/bin/env node
/**
 * Find listings priced below what comparable ones are going for.
 *
 *   node deal-scanner.mjs scan --brand Nike --min-discount 25
 *   node deal-scanner.mjs scan --category shoes --under 200 --json
 *   node deal-scanner.mjs watch --brand Nike --min-discount 30 --url https://you/hook
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
import { CrosslyBuyer } from './lib/client.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'scan';

if (cmd === 'help') {
  usage();
  process.exit(0);
}

/** Below this, a peer comparison is not evidence. */
const MIN_PEERS = 5;

/** How much of the catalogue to consider per scan. */
const SCAN_CAP = Number(args.cap ?? 2000);

const client = new CrosslyBuyer({ token: requireToken() });

if (cmd === 'scan') await scan(client, args);
else if (cmd === 'watch') await watch(client, args);
else {
  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(2);
}

// ── Commands ─────────────────────────────────────────────────────────

async function scan(c, a) {
  const filters = {};
  if (a.query) filters.q = a.query;
  if (a.brand) filters.brand = a.brand;
  if (a.category) filters.category = a.category;
  if (a.condition) filters.condition = a.condition;
  if (a.under) filters.maxPriceCents = Math.round(Number(a.under) * 100);
  if (a.over) filters.minPriceCents = Math.round(Number(a.over) * 100);

  const items = [];
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

  const deals = [];
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
async function watch(c, a) {
  const query = {};
  if (a.query) query.q = a.query;
  if (a.brand) query.brand = a.brand;
  if (a.category) query.category = a.category;
  if (a.under) query.maxPriceCents = Math.round(Number(a.under) * 100);

  const monitor = await c.createMonitor({
    name: `deals: ${a.brand ?? a.category ?? a.query ?? 'everything'}`,
    kind: 'new_listing',
    query,
    delivery: a.url ? 'webhook' : 'poll',
    ...(a.url ? { webhookUrl: a.url } : {}),
  });

  console.log(`Created monitor ${monitor.id}.`);
  if (monitor.webhookSecret) {
    console.log(`  Signing secret (shown once): ${monitor.webhookSecret}`);
    console.log(`  Receive + verify: node monitor.mjs serve --secret ${monitor.webhookSecret}`);
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
function peerKey(item) {
  return [
    (item.brand ?? '').toLowerCase(),
    (item.categoryMain ?? '').toLowerCase(),
    (item.condition ?? '').toLowerCase(),
  ].join('|');
}

function groupPeers(items) {
  const groups = new Map();
  for (const item of items) {
    const k = peerKey(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item.priceCents);
  }
  return groups;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function pct(part, whole) {
  if (!whole) return null;
  return (part / whole) * 100;
}

function bestOf(d) {
  return Math.max(d.markdownPct ?? 0, d.vsPeersPct ?? 0);
}

// ── plumbing ─────────────────────────────────────────────────────────

function requireToken() {
  const token = process.env.CROSSLY_TOKEN;
  if (!token) {
    console.error('Set CROSSLY_TOKEN to a buyer token (crossly_oat_…).');
    process.exit(2);
  }
  return token;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}

function usage() {
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
