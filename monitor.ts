#!/usr/bin/env -S npx tsx
/**
 * Restock and price-drop monitor.
 *
 *   npx tsx monitor.ts watch --slug some-listing-slug --url https://you.example/hook
 *   npx tsx monitor.ts watch --query "air max" --brand Nike --kind new_listing --url …
 *   npx tsx monitor.ts serve --port 8787 --secret <the secret you were given>
 *   npx tsx monitor.ts list
 *   npx tsx monitor.ts poll <monitorId>
 *
 * ── WHY THIS IS THE FIRST TOOL ───────────────────────────────────────
 * "Tell me when this is back in stock" is the single most common reason
 * anybody writes a marketplace scraper. It is also the one where scraping is
 * worst for everyone: the person wants low latency, so they poll hard; the
 * site sees a machine hitting a product page every few seconds and treats it
 * as an attack; and the resulting block makes the next version stealthier
 * rather than gentler.
 *
 * A monitor inverts it. You get told in about a minute, we do one query
 * instead of thousands, and nobody has to pretend to be a browser.
 *
 * `serve` is a complete, correct webhook receiver — including signature
 * verification, which is the part most integrations skip and the only part
 * that actually matters for security.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { CrosslyBuyer } from './lib/client.js';
import { dollarsToCents, parseArgs, requireToken, text, type ParsedArgs } from './lib/cli.js';
import type { MonitorEvent, MonitorKind, MonitorQuery } from './lib/types.js';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (!cmd || cmd === 'help') {
  usage();
  process.exit(0);
}

if (cmd === 'serve') {
  serve(Number(args.flags.port ?? 8787), text(args.flags.secret) ?? process.env.CROSSLY_MONITOR_SECRET);
} else {
  const client = new CrosslyBuyer({
    token: requireToken([
      'Set CROSSLY_TOKEN to a buyer token (crossly_oat_…).',
      'Get one at https://crossly.net/settings/api — instant, no application.',
    ]),
  });

  if (cmd === 'watch') await watch(client, args);
  else if (cmd === 'list') await list(client);
  else if (cmd === 'poll') await poll(client, args._[1]);
  else if (cmd === 'rm') await remove(client, args._[1]);
  else {
    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exit(2);
  }
}

// ── Commands ─────────────────────────────────────────────────────────

async function watch(client: CrosslyBuyer, { flags: a }: ParsedArgs): Promise<void> {
  // Passed through as given; the server validates the kind and says which are allowed.
  const kind = (text(a.kind) ?? (a.slug ? 'back_in_stock' : 'new_listing')) as MonitorKind;

  const query: MonitorQuery = {};
  if (a.slug) query.slug = text(a.slug);
  if (a.query) query.q = text(a.query);
  if (a.brand) query.brand = text(a.brand);
  if (a.category) query.category = text(a.category);
  if (a.condition) query.condition = text(a.condition);
  if (a.seller) query.seller = text(a.seller);
  if (a.under) query.maxPriceCents = dollarsToCents(a.under);
  if (a.over) query.minPriceCents = dollarsToCents(a.over);

  const url = text(a.url);
  const monitor = await client.createMonitor({
    name: text(a.name) ?? `${kind}: ${text(a.slug ?? a.query ?? a.brand) ?? 'everything'}`,
    kind,
    query,
    delivery: url ? 'webhook' : 'poll',
    ...(url ? { webhookUrl: url } : {}),
  });

  console.log(`Created monitor ${monitor.id} (${monitor.kind}).`);
  if (monitor.webhookSecret) {
    console.log('');
    console.log('  Signing secret — shown ONCE, save it now:');
    console.log(`    ${monitor.webhookSecret}`);
    console.log('');
    console.log('  Verify every delivery with it:');
    console.log(`    npx tsx monitor.ts serve --port 8787 --secret ${monitor.webhookSecret}`);
  } else {
    console.log(`  Poll delivery. Read matches with: npx tsx monitor.ts poll ${monitor.id}`);
  }

  // The seeding rule is surprising if nobody tells you, and the usual reaction
  // to an unexplained silent first run is to assume it is broken.
  console.log('');
  console.log('  Note: the first sweep records the current state WITHOUT notifying.');
  console.log('  A restock alert on an item that is already in stock has not seen a restock.');
}

async function list(client: CrosslyBuyer): Promise<void> {
  const monitors = await client.listMonitors();
  if (!monitors.length) {
    console.log('No monitors yet.');
    return;
  }
  for (const m of monitors) {
    const state = m.active ? 'active' : `PAUSED — ${m.pausedReason ?? 'unknown'}`;
    console.log(`${m.id}  ${m.kind.padEnd(14)} ${String(m.matchCount).padStart(4)} matches  ${state}`);
    console.log(`    ${m.name}`);
  }
}

async function poll(client: CrosslyBuyer, id: string | undefined): Promise<void> {
  if (!id) throw new Error('Usage: monitor.ts poll <monitorId>');
  const matches = await client.monitorMatches(id);
  if (!matches.length) {
    console.log('Nothing yet.');
    return;
  }
  for (const m of matches) {
    const price = m.triggerPriceCents >= 0 ? `$${(m.triggerPriceCents / 100).toFixed(2)}` : '—';
    console.log(`${m.createdAt}  ${m.listingSlug}  ${price}`);
  }
}

async function remove(client: CrosslyBuyer, id: string | undefined): Promise<void> {
  if (!id) throw new Error('Usage: monitor.ts rm <monitorId>');
  await client.deleteMonitor(id);
  console.log(`Deleted ${id}.`);
}

// ── The webhook receiver ─────────────────────────────────────────────

/**
 * Verify, then act. Never the other way round.
 *
 * The signature covers `"{timestamp}.{rawBody}"`, so the body must be read as
 * RAW BYTES and verified before it is parsed. Parsing and re-serialising does
 * not round-trip byte-for-byte — key order and number formatting drift — so a
 * genuine payload would fail, and the usual reaction to that is to stop
 * verifying, which is the actual vulnerability.
 */
function serve(port: number, secret: string | undefined): void {
  if (!secret) {
    console.error('A signing secret is required: --secret, or CROSSLY_MONITOR_SECRET.');
    console.error('Without it any stranger can POST you a fake "back in stock" and be believed.');
    process.exit(2);
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const sigHeader = req.headers['crossly-signature'];

      const verdict = verify(raw, sigHeader, secret);
      if (!verdict.ok) {
        console.error(`REJECTED: ${verdict.reason}`);
        // 400, not 200. Answering 200 to a forged request tells the sender it
        // worked and tells us the endpoint is healthy; both are false.
        res.writeHead(400).end(verdict.reason);
        return;
      }

      // Safe to parse now: these exact bytes were signed by Crossly.
      const event = JSON.parse(raw.toString('utf8')) as MonitorEvent;
      const { listing, kind, previousPriceCents, triggerPriceCents } = event.data;

      const now = `$${(triggerPriceCents / 100).toFixed(2)}`;
      const was = previousPriceCents != null ? ` (was $${(previousPriceCents / 100).toFixed(2)})` : '';
      console.log(`${kind}: ${listing.title} — ${now}${was}`);
      console.log(`  ${listing.url}`);

      // 200 promptly, work afterwards. A receiver that does its processing
      // before answering will eventually time out, get retried, and process
      // the same event twice.
      res.writeHead(200).end('ok');
    });
  });

  server.listen(port, () => {
    console.log(`Listening on :${port}. Point a monitor's --url at this.`);
  });
}

/** Tolerance for clock skew and retry delay. Five minutes, not five seconds. */
const TOLERANCE_SECONDS = 300;

type Verdict = { ok: true } | { ok: false; reason: string };

function verify(rawBody: Buffer, header: string | string[] | undefined, secret: string): Verdict {
  if (typeof header !== 'string') return { ok: false, reason: 'missing_signature' };

  const parts: Partial<Record<string, string>> = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'malformed_header' };

  // Timestamp check FIRST: it is cheap, and a replayed request should be
  // refused on age even if its signature is (genuinely) valid.
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody.toString('utf8')}`)
    .digest('hex');

  // Constant-time. A plain === returns on the first differing byte, and that
  // timing difference is enough to forge a signature given enough attempts.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

// ── plumbing ─────────────────────────────────────────────────────────

function usage(): void {
  console.log(`
Crossly monitor — be told, instead of asking.

  watch   --slug <slug> --url <your-webhook>        restock alert for one item
          --query <text> [--brand X] [--under 50]   new-listing alert for a search
          --kind new_listing|price_drop|back_in_stock
          (omit --url to create a poll monitor instead)

  serve   --port 8787 --secret <signing secret>     verified webhook receiver
  list                                              your monitors
  poll    <monitorId>                               matches for a poll monitor
  rm      <monitorId>                               delete one

Environment: CROSSLY_TOKEN, optionally CROSSLY_API_BASE.
`);
}
