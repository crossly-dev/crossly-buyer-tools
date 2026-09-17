# Crossly buyer tools

Four working tools for the things people build against a marketplace. Zero
dependencies, Node 18+, MIT.

```bash
export CROSSLY_TOKEN=crossly_oat_...   # instant, self-serve, no application

node monitor.mjs      watch --slug some-listing --url https://you.example/hook
node autobuy.mjs      setup --daily 20000 --per-order 8000
node catalog-sync.mjs sync  --out changes.ndjson
node deal-scanner.mjs scan  --brand Nike --min-discount 25
```

| | |
|---|---|
| `monitor.mjs` | restock / price-drop / new-listing alerts, plus a **verified** webhook receiver |
| `autobuy.mjs` | buy without being present, with spend caps and idempotency |
| `catalog-sync.mjs` | mirror the catalogue to NDJSON, incrementally |
| `deal-scanner.mjs` | find listings below their peer median |

## Why these exist

Every one of these is something people already build by scraping. That is bad
for both sides and it is *our* fault when it happens: a marketplace that
publishes no search API has decided that crawling its HTML is the only way to
answer "what do you have", and then treats the crawling as an attack.

The arms race that follows has a predictable shape. Harder blocks produce
better scrapers, not fewer — the only people deterred are the ones who would
have been easy to serve, while anyone with a commercial reason to get the data
buys residential proxies and carries on. Meanwhile the block is
indistinguishable from a bug for every legitimate integrator, and support ends
up explaining to a genuine partner why their IP is banned.

So the data has a front door. It is metered, attributable and rate-limited —
which is exactly what scraping is not, and exactly what lets us be generous
with it. We would rather know who you are and serve you cheaply than not know
and fight you expensively.

**Crossly still runs bot protection.** This does not replace it. It removes
most of the *reasons* to go around it.

## The one that matters: stop polling

`monitor.mjs` is the whole argument.

Polling a search endpoint every five seconds costs us a query per client per
tick, forever, and the frequency is set by whoever is most impatient. A monitor
costs one sweep per distinct saved search, no matter how many people want the
answer — and you find out in about a minute instead of within your poll
interval.

```bash
# be told
node monitor.mjs watch --slug rare-thing --url https://you.example/hook
node monitor.mjs serve --port 8787 --secret <secret shown once on create>
```

Can't accept an inbound request? Create the monitor without `--url` and read
matches with `node monitor.mjs poll <id>`. Still one sweep on our side.

**The first sweep records state without notifying.** A restock alert created
while the item is in stock has not observed a restock, and a new-listing
monitor would otherwise deliver the entire back catalogue as its first event.

## Verify your webhooks

`monitor.mjs serve` is a complete receiver, including the part most
integrations skip:

- verifies **before** parsing, over the **raw bytes** — `JSON.parse` then
  `stringify` does not round-trip byte-for-byte, so verifying a re-serialised
  body fails on genuine payloads, and the usual reaction is to stop verifying
- **constant-time** compare, because a byte-at-a-time `===` leaks enough timing
  to forge a signature
- rejects a stale timestamp, so a captured request cannot be replayed forever
- answers **400** to a bad signature, not 200 — telling a forger it worked is
  worse than useless

Verifiers for eleven other languages: [`crossly-dev/crossly-*`](https://github.com/crossly-dev),
under `webhooks/`.

## Spending money

`autobuy.mjs` is the only tool here that spends. Five independent gates, none
implying another:

1. a **separate scope** (`buyer:checkout:write`) — never bundled with cart access
2. a **per-key switch**, off by default; the scope alone does nothing
3. **spend caps**, per order and rolling 24h
4. **per-listing velocity**, so one buyer cannot take a seller's whole stock
5. **idempotency** — the API REFUSES a purchase with no `Idempotency-Key`, so a retry cannot buy twice

The API has **no field for a card**. You name a payment method you already
saved on crossly.net, and Stripe refuses it unless it is attached to your own
customer record — so a stolen key cannot charge a new card, or someone else's.

A card that demands 3-D Secure cannot be charged unattended. That returns
`402 authentication_required` rather than pretending to succeed.

## Cheap at volume, deliberately

- **keyset cursors** — page 500 costs what page 1 costs, for you and for us.
  No deep-paging penalty, so mirroring the catalogue is not an act of
  aggression.
- **ETags** — send `If-None-Match`; an unchanged page answers `304` with no
  body. The client here does it automatically. This is what makes polling
  cheap enough that we do not have to discourage it.
- **`Retry-After`** — honoured on 429. Backing off is how you stay fast.

## Rules

Don't resell the catalogue as your own. Don't use `autobuy` to clear a seller's
stock — the velocity cap enforces it, but the reason it exists is that scalping
our sellers makes the marketplace worse for everyone including you. Identify
your integration with a `User-Agent` so we can talk to you before we rate-limit
you.

Something missing, or an endpoint that made you reach for a scraper? Open an
issue. That is a bug report about the API, and we would rather fix it.

## License

MIT
