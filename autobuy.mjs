#!/usr/bin/env node
/**
 * Auto-checkout: buy a listing the moment it meets your terms.
 *
 *   node autobuy.mjs setup   --daily 20000 --per-order 8000 --max-per-listing 1
 *   node autobuy.mjs status
 *   node autobuy.mjs buy     --slug some-slug --pm pm_123 --max 4500
 *   node autobuy.mjs snipe   --slug some-slug --pm pm_123 --max 4500
 *
 * ── READ THIS BEFORE YOU RUN IT ──────────────────────────────────────
 * This spends real money with nobody watching. Everything below is built
 * around that one fact:
 *
 *   - `setup` comes FIRST and is not optional. A key cannot spend until you
 *     switch it on and give it a ceiling. That is enforced server-side, so
 *     forgetting is a refusal rather than a surprise.
 *   - `--max` is a hard limit on the DELIVERED total, not the sticker price.
 *     Shipping and tax are resolved at checkout; a bot that only checks the
 *     listing price will happily pay $40 of postage on a $12 item.
 *   - Every purchase carries a stable Idempotency-Key. Retrying is the normal
 *     way an automated buyer double-spends, and it happens on a timeout — the
 *     case where you never learn the first attempt succeeded.
 *
 * ── AND ON SNIPING ───────────────────────────────────────────────────
 * `snipe` waits for stock and buys immediately. It uses the availability
 * endpoint with conditional requests, so an unchanged answer costs almost
 * nothing, and it still backs off — a faster poll would not win anyway,
 * because the server enforces a per-listing velocity cap that exists
 * specifically so the fastest bot cannot take every unit. Sniping harder is
 * wasted effort by design; the honest way to be first is a monitor.
 */
import { CrosslyBuyer, sleep } from './lib/client.mjs';

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (!cmd || cmd === 'help') {
  usage();
  process.exit(0);
}

const client = new CrosslyBuyer({ token: requireToken() });

if (cmd === 'setup') await setup(client, args);
else if (cmd === 'status') await status(client);
else if (cmd === 'buy') await buyOnce(client, args);
else if (cmd === 'snipe') await snipe(client, args);
else {
  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(2);
}

// ── Commands ─────────────────────────────────────────────────────────

async function setup(c, a) {
  const controls = await c.setCheckoutControls({
    enabled: a.off ? false : true,
    dailyLimitCents: Number(a.daily ?? 0),
    perOrderLimitCents: Number(a['per-order'] ?? 0),
    maxUnitsPerListingPerDay: Number(a['max-per-listing'] ?? 1),
  });
  console.log('Checkout controls for THIS key:');
  printControls(controls);
  if (!controls.dailyLimitCents) {
    console.log('');
    console.log('  Warning: dailyLimitCents is 0, which means NO daily ceiling.');
    console.log('  Set --daily to bound what a lost key can spend before you notice.');
  }
}

async function status(c) {
  printControls(await c.checkoutControls());
}

function printControls(x) {
  console.log(`  enabled                  ${x.enabled}`);
  console.log(`  dailyLimitCents          ${x.dailyLimitCents || '(no limit)'}`);
  console.log(`  perOrderLimitCents       ${x.perOrderLimitCents || '(no limit)'}`);
  console.log(`  maxUnitsPerListingPerDay ${x.maxUnitsPerListingPerDay}`);
}

async function buyOnce(c, a) {
  const slug = required(a, 'slug');
  const pm = required(a, 'pm');
  const maxTotalCents = a.max ? Math.round(Number(a.max) * 100) : undefined;

  try {
    const order = await c.buy({
      listingSlug: slug,
      quantity: Number(a.qty ?? 1),
      paymentMethodId: pm,
      ...(maxTotalCents ? { maxTotalCents } : {}),
      // A key stable for THIS intent. Re-running the same command after a
      // timeout replays the original result instead of buying a second one.
      idempotencyKey: a.key ?? `autobuy:${slug}:${maxTotalCents ?? 'any'}`,
    });

    console.log(`Bought ${order.listingSlug} for $${(order.totalCents / 100).toFixed(2)}.`);
    console.log(`  order ${order.orderId ?? '(pending webhook)'}  payment ${order.paymentStatus}`);
    return order;
  } catch (err) {
    explainRefusal(err);
    process.exitCode = 1;
    return null;
  }
}

/**
 * Wait for stock, then buy.
 *
 * The backoff is not politeness theatre — it is the correct strategy. The
 * server caps units-per-listing-per-day per key, so hammering cannot win you
 * more than one unit; all it does is spend your rate limit and get you a 429
 * at the exact moment stock appears.
 */
async function snipe(c, a) {
  const slug = required(a, 'slug');
  const intervalMs = Math.max(2000, Number(a.interval ?? 10) * 1000);
  const deadline = a.for ? Date.now() + Number(a.for) * 60_000 : Infinity;

  console.log(`Watching ${slug} every ${intervalMs / 1000}s. Ctrl-C to stop.`);
  console.log('(A monitor would tell you instead of you asking — see monitor.mjs.)');

  for (;;) {
    if (Date.now() > deadline) {
      console.log('Deadline reached; stopping.');
      return;
    }

    const av = await c.availability(slug);
    if (av.unchanged) {
      // 304 — nothing moved. Cost us almost nothing, so this is fine to repeat.
      await sleep(intervalMs);
      continue;
    }

    if (av.available) {
      const maxTotalCents = a.max ? Math.round(Number(a.max) * 100) : undefined;
      if (maxTotalCents && av.priceCents > maxTotalCents) {
        console.log(
          `In stock at $${(av.priceCents / 100).toFixed(2)}, above your max. Not buying.`,
        );
        return;
      }
      console.log(`In stock at $${(av.priceCents / 100).toFixed(2)} — buying.`);
      await buyOnce(c, a);
      return;
    }

    await sleep(intervalMs);
  }
}

/**
 * Turn a refusal into something actionable.
 *
 * Each of these has a different fix, and a bot that logs "403" for all of them
 * teaches its owner nothing. `checkout_not_enabled_for_key` in particular is
 * the one everybody hits first, and it is a one-command fix.
 */
function explainRefusal(err) {
  const fixes = {
    checkout_not_enabled_for_key:
      'This key cannot spend yet. Run:  node autobuy.mjs setup --daily 20000 --per-order 8000',
    per_order_limit_exceeded:
      'The order is over this key\'s per-order ceiling. Raise it with `setup --per-order`, ' +
      'or buy something cheaper.',
    daily_limit_exceeded:
      'This key has spent its 24h allowance. It is a ROLLING window, so it frees up ' +
      'gradually rather than at midnight. Note that refunds do not give the allowance back.',
    listing_velocity_exceeded:
      'You have already bought your allowed units of this listing today. This cap exists so ' +
      'one automated buyer cannot take a seller\'s whole stock.',
    over_max_total:
      'The DELIVERED total (item + shipping + tax) is above your --max. Nothing was charged.',
    authentication_required:
      'This card wants 3-D Secure, which needs you present. Finish it on crossly.net, or ' +
      'save a card that does not require it.',
  };

  console.error(`Refused: ${err.message}`);
  const fix = fixes[err.code];
  if (fix) console.error(`\n  ${fix}`);
  if (err.details) console.error(`\n  ${JSON.stringify(err.details)}`);
}

// ── plumbing ─────────────────────────────────────────────────────────

function required(a, key) {
  if (!a[key]) {
    console.error(`--${key} is required.`);
    process.exit(2);
  }
  return a[key];
}

function requireToken() {
  const token = process.env.CROSSLY_TOKEN;
  if (!token) {
    console.error('Set CROSSLY_TOKEN to a buyer token with the buyer:checkout:write scope.');
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
Crossly auto-checkout. This spends real money — read autobuy.mjs before running it.

  setup   --daily <cents> --per-order <cents> [--max-per-listing 1] [--off]
          Switch THIS key on for spending and set its ceilings. Required first.

  status  What this key is allowed to spend.

  buy     --slug <slug> --pm <paymentMethodId> [--max <dollars>] [--qty 1]
          Buy once. --max is the DELIVERED total, not the sticker price.

  snipe   --slug <slug> --pm <paymentMethodId> [--max <dollars>]
          [--interval <seconds>] [--for <minutes>]
          Wait for stock, then buy. A monitor is better; see monitor.mjs.

Environment: CROSSLY_TOKEN. Payment methods are saved on crossly.net —
this tool never sees a card number, and the API has no field for one.
`);
}
