/**
 * A tiny Crossly buyer-API client.
 *
 * Zero dependencies, Node 18+. Deliberately small enough to read in one
 * sitting, because the point of these tools is to be COPIED — if the client
 * were a framework, people would skip it and write their own, and the first
 * thing they would leave out is the part that makes their integration cheap
 * for us to serve.
 *
 * The three things it does that a naive fetch loop would not:
 *
 *   1. Sends `If-None-Match` and treats 304 as "unchanged". A 304 costs the
 *      server no serialisation and you no parsing, so polling becomes almost
 *      free and there is no reason to poll less politely.
 *   2. Honours `Retry-After` on 429 instead of hammering. Backing off is how
 *      you stay fast: an endpoint you are rate-limited on is slower than one
 *      you are not.
 *   3. Walks with CURSORS rather than page numbers, so page 500 costs what
 *      page 1 costs — for you and for us.
 */

const DEFAULT_BASE = process.env.CROSSLY_API_BASE ?? 'https://crossly.net/api';

export class CrosslyBuyer {
  /**
   * @param {object} opts
   * @param {string} opts.token  A buyer OAuth token (`crossly_oat_…`).
   * @param {string} [opts.base] API base. Defaults to production.
   */
  constructor({ token, base = DEFAULT_BASE } = {}) {
    if (!token) {
      throw new Error(
        'A buyer token is required. Get one at https://crossly.net/settings/api — it is ' +
          'self-serve and instant; there is no application to fill in.',
      );
    }
    this.token = token;
    this.base = base.replace(/\/$/, '');
    /** ETag cache, keyed by URL. This is what makes polling cheap. */
    this._etags = new Map();
  }

  /**
   * One request, with backoff and conditional-GET handling.
   *
   * Returns `{ status, data, unchanged }`. `unchanged` is true on a 304, in
   * which case `data` is null and you should keep whatever you had.
   */
  async request(path, { method = 'GET', body, headers = {}, useEtag = false, retries = 3 } = {}) {
    const url = `${this.base}${path}`;
    const h = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
      ...headers,
    };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (useEtag && this._etags.has(url)) h['if-none-match'] = this._etags.get(url);

    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(url, {
        method,
        headers: h,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (res.status === 304) return { status: 304, data: null, unchanged: true };

      // 429 and 5xx are worth retrying; 4xx is not — a malformed request does
      // not become well-formed on the third attempt, and retrying it just
      // spends someone's rate limit to learn the same thing again.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 2 ** attempt * 1000);
        await sleep(waitMs);
        continue;
      }

      const etag = res.headers.get('etag');
      if (useEtag && etag) this._etags.set(url, etag);

      const text = await res.text();
      const data = text ? safeJson(text) : null;

      if (!res.ok) {
        const message = data?.error?.message ?? data?.error ?? `HTTP ${res.status}`;
        const err = new Error(message);
        err.status = res.status;
        err.code = data?.error?.code;
        err.details = data?.error?.details;
        throw err;
      }

      return { status: res.status, data, unchanged: false };
    }
  }

  // ── Catalogue ──────────────────────────────────────────────────────

  /** One page of search results. */
  async search(params = {}) {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
    );
    const { data, unchanged } = await this.request(`/v1/buyer/catalog/search?${qs}`, {
      useEtag: true,
    });
    if (unchanged) return { items: [], nextCursor: null, unchanged: true };
    return {
      items: data.data ?? [],
      nextCursor: data.meta?.nextCursor ?? null,
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
  async *walk(params = {}) {
    let cursor;
    for (;;) {
      const page = await this.search({ ...params, limit: 100, cursor });
      for (const item of page.items) yield item;
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  async listing(slug) {
    const { data } = await this.request(`/v1/buyer/catalog/listings/${encodeURIComponent(slug)}`, {
      useEtag: true,
    });
    return data;
  }

  /** The cheapest call in the API. Poll this one if you must poll. */
  async availability(slug) {
    const { data, unchanged } = await this.request(
      `/v1/buyer/catalog/listings/${encodeURIComponent(slug)}/availability`,
      { useEtag: true },
    );
    return unchanged ? { unchanged: true } : { ...data, unchanged: false };
  }

  async facets() {
    const { data } = await this.request('/v1/buyer/catalog/facets', { useEtag: true });
    return data;
  }

  // ── Monitors ───────────────────────────────────────────────────────

  async createMonitor(monitor) {
    const { data } = await this.request('/v1/buyer/monitors', { method: 'POST', body: monitor });
    return data;
  }

  async listMonitors() {
    const { data } = await this.request('/v1/buyer/monitors');
    return data.data ?? [];
  }

  async monitorMatches(id) {
    const { data } = await this.request(`/v1/buyer/monitors/${id}/matches`);
    return data.data ?? [];
  }

  async deleteMonitor(id) {
    await this.request(`/v1/buyer/monitors/${id}`, { method: 'DELETE' });
  }

  // ── Checkout ───────────────────────────────────────────────────────

  async checkoutControls() {
    const { data } = await this.request('/v1/buyer/checkout/controls');
    return data;
  }

  async setCheckoutControls(controls) {
    const { data } = await this.request('/v1/buyer/checkout/controls', {
      method: 'PUT',
      body: controls,
    });
    return data;
  }

  /**
   * Buy something.
   *
   * `idempotencyKey` is REQUIRED by this client even though the API will
   * accept a request without one. Without it a retry — a timeout, a dropped
   * connection, a process restart mid-flight — buys the item a second time,
   * and that is the single most likely way an automated buyer loses money.
   * Making it non-optional here costs one argument and removes the failure.
   */
  async buy({ idempotencyKey, ...body }) {
    if (!idempotencyKey) {
      throw new Error(
        'idempotencyKey is required. Use a stable value derived from what you are buying ' +
          '(e.g. `${monitorId}:${slug}`) so a retry cannot buy it twice.',
      );
    }
    const { data } = await this.request('/v1/buyer/checkout', {
      method: 'POST',
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
    return data;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
