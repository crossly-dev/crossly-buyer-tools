/**
 * The buyer-API client these tools share, built on `@crossly/buyer-sdk`.
 *
 * The SDK supplies the transport: auth, the token-kind check (a seller
 * `crossly_pat_` key is refused before any request), JSON, the
 * `Idempotency-Key` header and the typed `CrosslyBuyerAPIError`. The SDK does
 * not wrap the catalogue, monitors or checkout yet, so those calls go through
 * its `http.request` escape hatch with the types in `./types.ts`.
 *
 * What this file adds on top is the part that makes an integration cheap for
 * us to serve, and it lives in a `fetch` handed to the SDK, so every request
 * gets it:
 *
 *   1. Sends `If-None-Match` on catalogue reads and treats 304 as
 *      "unchanged". A 304 costs the server no serialisation and you no
 *      parsing, so polling becomes almost free.
 *   2. Honours `Retry-After` on 429 (and backs off on 5xx) instead of
 *      hammering. An endpoint you are rate-limited on is slower than one you
 *      are not.
 *   3. Walks with CURSORS rather than page numbers, so page 500 costs what
 *      page 1 costs, for you and for us.
 */
import {
  createBuyerClient,
  CrosslyBuyerAPIError,
  type CrosslyBuyerClient,
  type ListEnvelope,
  type RequestOptions,
} from '@crossly/buyer-sdk';
import type {
  AvailabilityResult,
  Availability,
  BuyRequest,
  BuyResult,
  CatalogItem,
  CheckoutControls,
  CheckoutControlsState,
  CreateMonitorInput,
  Facets,
  ListingDetail,
  Monitor,
  MonitorMatch,
  SearchFilters,
  SearchPage,
} from './types.js';

const DEFAULT_BASE = process.env.CROSSLY_API_BASE ?? 'https://crossly.net/api';

/** Sent after the SDK's own identifier, so we can tell these tools apart in our logs. */
const USER_AGENT = 'crossly-buyer-tools/0.1.0';

/** 429 and 5xx are retried this many times. 4xx never is. */
const RETRIES = 3;

/**
 * No overall request timeout, matching the original tools. The SDK's timer
 * covers the whole call including our Retry-After waits, so its 30s default
 * would cut a polite backoff short. This is the largest delay a Node timer
 * accepts (about 24.8 days).
 */
const NO_TIMEOUT_MS = 2_147_483_647;

/** Catalogue reads are the ones that answer 304; nothing else is conditional. */
function isConditional(url: string, method: string): boolean {
  return method === 'GET' && new URL(url).pathname.includes('/v1/buyer/catalog/');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `fetch` with an ETag cache (keyed by URL, per process) and backoff.
 *
 * It returns a 304 untouched: the SDK turns that into a
 * `CrosslyBuyerAPIError` with status 304, and `conditionalGet` below turns
 * that into `{ unchanged: true }`.
 */
export function createPoliteFetch(base: typeof fetch = globalThis.fetch): typeof fetch {
  const etags = new Map<string, string>();

  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const conditional = isConditional(url, method);

    const headers = new Headers(init?.headers);
    const known = conditional ? etags.get(url) : undefined;
    if (known) headers.set('if-none-match', known);

    for (let attempt = 0; ; attempt += 1) {
      const res = await base(input, { ...init, headers });
      if (res.status === 304) return res;

      // 429 and 5xx are worth retrying; 4xx is not. A malformed request does
      // not become well-formed on the third attempt, and retrying it spends
      // someone's rate limit to learn the same thing again.
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : Math.min(30_000, 2 ** attempt * 1000);
        await res.body?.cancel();
        await sleep(waitMs);
        continue;
      }

      const etag = res.headers.get('etag');
      if (conditional && etag) etags.set(url, etag);
      return res;
    }
  };
}

/**
 * Re-raise an API error with the message the tools have always printed: the
 * envelope's `error.message`, else a bare-string `error`, else `HTTP <status>`.
 * The SDK falls back to the status text, which says less.
 */
function withToolMessage(err: CrosslyBuyerAPIError): CrosslyBuyerAPIError {
  const body = err.body as { error?: { message?: unknown } | string } | null | undefined;
  const envelope = body?.error;
  const message =
    typeof envelope === 'object' && typeof envelope.message === 'string'
      ? envelope.message
      : typeof envelope === 'string'
        ? envelope
        : `HTTP ${err.status}`;
  if (message === err.message) return err;
  return new CrosslyBuyerAPIError(err.status, { code: err.code, message, details: err.details }, err.body);
}

type Conditional<T> = { unchanged: true } | { unchanged: false; data: T };

export interface CrosslyBuyerOptions {
  /** A buyer OAuth token (`crossly_oat_…`). */
  token: string;
  /** API base. Defaults to `CROSSLY_API_BASE`, then production. */
  base?: string;
  /** Underlying fetch, for tests. */
  fetch?: typeof fetch;
}

export class CrosslyBuyer {
  /** The SDK client. Its typed resources (cart, orders, offers…) are all here too. */
  readonly sdk: CrosslyBuyerClient;

  constructor({ token, base = DEFAULT_BASE, fetch: fetchImpl }: CrosslyBuyerOptions) {
    if (!token) {
      throw new Error(
        'A buyer token is required. Get one at https://crossly.net/settings/api — it is ' +
          'self-serve and instant; there is no application to fill in.',
      );
    }
    this.sdk = createBuyerClient({
      token,
      baseUrl: base,
      fetch: createPoliteFetch(fetchImpl),
      timeoutMs: NO_TIMEOUT_MS,
      userAgent: USER_AGENT,
    });
  }

  private async request<T>(opts: RequestOptions): Promise<T> {
    try {
      return await this.sdk.http.request<T>(opts);
    } catch (err) {
      throw err instanceof CrosslyBuyerAPIError ? withToolMessage(err) : err;
    }
  }

  /** A GET that may answer 304. */
  private async conditionalGet<T>(path: string, query?: object): Promise<Conditional<T>> {
    try {
      const data = await this.request<T>({ method: 'GET', path, ...(query ? { query } : {}) });
      return { unchanged: false, data };
    } catch (err) {
      if (err instanceof CrosslyBuyerAPIError && err.status === 304) return { unchanged: true };
      throw err;
    }
  }

  // ── Catalogue ──────────────────────────────────────────────────────

  /** One page of search results. */
  async search(params: SearchFilters = {}): Promise<SearchPage> {
    type Page = ListEnvelope<CatalogItem> & { meta?: { nextCursor?: string | null } };
    const res = await this.conditionalGet<Page>('/v1/buyer/catalog/search', params);
    if (res.unchanged) return { items: [], nextCursor: null, unchanged: true };
    return {
      items: res.data.data ?? [],
      nextCursor: res.data.meta?.nextCursor ?? null,
      unchanged: false,
    };
  }

  /**
   * Every listing matching a query, as an async iterator.
   *
   * Yields items one at a time so a caller can start work on the first page
   * while the rest is still arriving, and never has to hold the whole
   * catalogue in memory to process it.
   */
  async *walk(params: SearchFilters = {}): AsyncGenerator<CatalogItem, void, undefined> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.search({ ...params, limit: 100, cursor });
      for (const item of page.items) yield item;
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  /** One listing in full. Null when it has not changed since this process last read it. */
  async listing(slug: string): Promise<ListingDetail | null> {
    const res = await this.conditionalGet<ListingDetail>(
      `/v1/buyer/catalog/listings/${encodeURIComponent(slug)}`,
    );
    return res.unchanged ? null : res.data;
  }

  /** The cheapest call in the API. Poll this one if you must poll. */
  async availability(slug: string): Promise<AvailabilityResult> {
    const res = await this.conditionalGet<Availability>(
      `/v1/buyer/catalog/listings/${encodeURIComponent(slug)}/availability`,
    );
    return res.unchanged ? { unchanged: true } : { ...res.data, unchanged: false };
  }

  /** Brands, categories and conditions with live stock. Null when unchanged. */
  async facets(): Promise<Facets | null> {
    const res = await this.conditionalGet<Facets>('/v1/buyer/catalog/facets');
    return res.unchanged ? null : res.data;
  }

  // ── Monitors ───────────────────────────────────────────────────────

  createMonitor(monitor: CreateMonitorInput): Promise<Monitor> {
    return this.request<Monitor>({ method: 'POST', path: '/v1/buyer/monitors', body: monitor });
  }

  async listMonitors(): Promise<Monitor[]> {
    const res = await this.request<ListEnvelope<Monitor>>({ method: 'GET', path: '/v1/buyer/monitors' });
    return res.data ?? [];
  }

  async monitorMatches(id: string): Promise<MonitorMatch[]> {
    const res = await this.request<ListEnvelope<MonitorMatch>>({
      method: 'GET',
      path: `/v1/buyer/monitors/${encodeURIComponent(id)}/matches`,
    });
    return res.data ?? [];
  }

  async deleteMonitor(id: string): Promise<void> {
    await this.request<void>({ method: 'DELETE', path: `/v1/buyer/monitors/${encodeURIComponent(id)}` });
  }

  // ── Checkout ───────────────────────────────────────────────────────

  checkoutControls(): Promise<CheckoutControlsState> {
    return this.request<CheckoutControlsState>({ method: 'GET', path: '/v1/buyer/checkout/controls' });
  }

  setCheckoutControls(controls: CheckoutControls): Promise<CheckoutControlsState> {
    return this.request<CheckoutControlsState>({
      method: 'PUT',
      path: '/v1/buyer/checkout/controls',
      body: controls,
    });
  }

  /**
   * Buy something.
   *
   * `idempotencyKey` is REQUIRED here, and the API refuses a purchase without
   * one. Without it a retry (a timeout, a dropped connection, a process
   * restart mid-flight) buys the item a second time, and that is the single
   * most likely way an automated buyer loses money.
   */
  async buy({ idempotencyKey, ...body }: BuyRequest & { idempotencyKey: string }): Promise<BuyResult> {
    if (!idempotencyKey) {
      throw new Error(
        'idempotencyKey is required. Use a stable value derived from what you are buying ' +
          '(e.g. `${monitorId}:${slug}`) so a retry cannot buy it twice.',
      );
    }
    return this.request<BuyResult>({
      method: 'POST',
      path: '/v1/buyer/checkout',
      body,
      idempotencyKey,
    });
  }
}
