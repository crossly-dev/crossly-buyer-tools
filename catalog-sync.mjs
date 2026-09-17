#!/usr/bin/env node
/**
 * Mirror the Crossly catalogue into your own system.
 *
 *   node catalog-sync.mjs dump  --out catalog.ndjson
 *   node catalog-sync.mjs dump  --brand Nike --category shoes --out nike.ndjson
 *   node catalog-sync.mjs sync  --state .crossly-sync.json --out changes.ndjson
 *
 * ── THIS IS THE EXPENSIVE ONE TO SCRAPE ──────────────────────────────
 * A deep crawl is the worst kind of scraping to absorb: it touches everything,
 * it runs for hours, and page N costs more than page 1 because HTML paginators
 * are almost always OFFSET-based. Someone mirroring 50k listings by crawling
 * is simultaneously the most expensive traffic on the box and doing something
 * completely legitimate.
 *
 * So the supported path is built for exactly that shape:
 *
 *   - KEYSET cursors. Page 500 costs what page 1 costs. There is no deep-paging
 *     penalty, for you or for us.
 *   - NDJSON out. One object per line, streamed, so a full dump never has to
 *     fit in memory at either end.
 *   - INCREMENTAL by default in `sync`. After the first run you only ever pull
 *     what changed, which is the difference between a nightly full crawl and a
 *     nightly no-op.
 *
 * `sync` keeps a watermark in a small state file. Re-running it is cheap and
 * safe; it is meant to live in a cron.
 */
import fs from 'node:fs';
import { CrosslyBuyer } from './lib/client.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (!cmd || cmd === 'help') {
  usage();
  process.exit(0);
}

const client = new CrosslyBuyer({ token: requireToken() });

if (cmd === 'dump') await dump(client, args);
else if (cmd === 'sync') await sync(client, args);
else if (cmd === 'facets') await facets(client);
else {
  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(2);
}

// ── Commands ─────────────────────────────────────────────────────────

function filtersFrom(a) {
  const f = {};
  if (a.query) f.q = a.query;
  if (a.brand) f.brand = a.brand;
  if (a.category) f.category = a.category;
  if (a.condition) f.condition = a.condition;
  if (a.seller) f.seller = a.seller;
  if (a.under) f.maxPriceCents = Math.round(Number(a.under) * 100);
  if (a.over) f.minPriceCents = Math.round(Number(a.over) * 100);
  // A mirror usually wants everything, including what is currently sold out —
  // otherwise items vanish from your copy and reappear, which reads as churn.
  if (a['in-stock-only']) f.inStockOnly = 'true';
  else f.inStockOnly = 'false';
  return f;
}

async function dump(c, a) {
  const out = a.out ? fs.createWriteStream(a.out, { flags: 'w' }) : process.stdout;
  let n = 0;
  const started = Date.now();

  for await (const item of c.walk(filtersFrom(a))) {
    out.write(`${JSON.stringify(item)}\n`);
    n += 1;
    if (n % 1000 === 0) progress(n, started);
  }

  if (out !== process.stdout) out.end();
  progress(n, started, true);
}

/**
 * Pull only what changed since the last run.
 *
 * The watermark is `listedAt` of the newest thing we have seen, and the sort
 * is `newest`, so "everything after the watermark" is one cursor walk that
 * usually terminates on the first page.
 *
 * What this DOES NOT catch is an edit to an old listing — a price change on
 * something listed last year does not move `listedAt`. That is what monitors
 * are for, and pretending otherwise would give people a sync they trust and
 * shouldn't. Stated here rather than discovered later.
 */
async function sync(c, a) {
  const statePath = a.state ?? '.crossly-sync.json';
  const state = readState(statePath);
  const out = a.out ? fs.createWriteStream(a.out, { flags: 'a' }) : process.stdout;

  const filters = filtersFrom(a);
  if (state.watermark) {
    filters.listedAfter = state.watermark;
    console.error(`Incremental since ${state.watermark}`);
  } else {
    console.error('First run — pulling everything, then recording a watermark.');
  }

  let n = 0;
  let newest = state.watermark ?? null;
  const started = Date.now();

  for await (const item of c.walk(filters)) {
    out.write(`${JSON.stringify(item)}\n`);
    n += 1;
    if (item.listedAt && (!newest || item.listedAt > newest)) newest = item.listedAt;
    if (n % 1000 === 0) progress(n, started);
  }

  if (out !== process.stdout) out.end();

  // Written only after a clean walk. Advancing the watermark on a partial run
  // would silently skip everything the failed half would have returned, and
  // the gap is invisible forever after.
  if (newest) writeState(statePath, { watermark: newest, lastRunAt: new Date().toISOString() });

  progress(n, started, true);
  console.error(`Watermark now ${newest ?? '(unset)'}`);
  if (n === 0) console.error('Nothing new. This is the normal steady state.');
}

async function facets(c) {
  const f = await c.facets();
  console.log('Brands:');
  for (const b of f.brands.slice(0, 40)) console.log(`  ${String(b.count).padStart(6)}  ${b.value}`);
  console.log('\nCategories:');
  for (const x of f.categories.slice(0, 40)) console.log(`  ${String(x.count).padStart(6)}  ${x.value}`);
  console.log('\nConditions:');
  for (const x of f.conditions) console.log(`  ${String(x.count).padStart(6)}  ${x.value}`);
}

// ── plumbing ─────────────────────────────────────────────────────────

function progress(n, started, final = false) {
  const secs = (Date.now() - started) / 1000;
  const rate = secs > 0 ? Math.round(n / secs) : 0;
  process.stderr.write(`${final ? '' : '\r'}${n} listings  ${rate}/s${final ? '\n' : ''}`);
}

function readState(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(p, state) {
  fs.writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
}

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
Mirror the Crossly catalogue. NDJSON out, keyset cursors, no deep-paging penalty.

  dump    [--brand X] [--category Y] [--under 100] [--out file.ndjson]
          Everything matching, one JSON object per line.

  sync    [--state .crossly-sync.json] [--out changes.ndjson]
          Only what is new since the last run. Safe to cron.
          Does NOT catch edits to old listings — use a monitor for price drops.

  facets  What brands / categories / conditions currently exist.

Environment: CROSSLY_TOKEN, optionally CROSSLY_API_BASE.
`);
}
