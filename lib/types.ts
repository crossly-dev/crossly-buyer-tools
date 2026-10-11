/**
 * Wire shapes for the buyer endpoints these tools use.
 *
 * `@crossly/buyer-sdk` wraps the shopping surface (cart, orders, wishlists,
 * offers, cashback) but not, yet, the catalogue, monitors or checkout. Those
 * calls go through the SDK's own transport (`client.http`), and these types
 * describe what the v1 routes send back. They are written from the route
 * handlers in the API, so if one drifts, the API is the source of truth.
 */

// ── Catalogue ─────────────────────────────────────────────────────────

/** One search result. `GET /v1/buyer/catalog/search` returns a page of these. */
export interface CatalogItem {
  slug: string;
  title: string;
  priceCents: number;
  /** MSRP above the ask, or null. Never fabricated: a compare-at at or below the ask is dropped. */
  compareAtCents: number | null;
  currency: string;
  condition: string | null;
  brand: string | null;
  categoryMain: string | null;
  categorySub: string | null;
  thumbnail: string | null;
  images: string[];
  sellerUsername: string | null;
  sellerDisplayName: string | null;
  /** Units a buyer can take right now. Reserved units are excluded. */
  quantityAvailable: number;
  listedAt: string | null;
  /** Canonical buyer-facing URL. */
  url: string;
  aiMedia: boolean;
  aiMediaDetected: boolean;
}

/** Query parameters the search endpoint accepts. Prices are integer cents. */
export interface SearchFilters {
  q?: string;
  brand?: string;
  category?: string;
  condition?: string;
  seller?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  /** ISO timestamp. Only listings listed after it. */
  listedAfter?: string;
  /** Sent as a string because it is a query parameter. */
  inStockOnly?: 'true' | 'false';
  sort?: string;
  limit?: number;
  /** Opaque keyset cursor from the previous page's `meta.nextCursor`. */
  cursor?: string;
}

export interface SearchPage {
  items: CatalogItem[];
  nextCursor: string | null;
  /** True on a 304: the page has not changed since this process last fetched it. */
  unchanged: boolean;
}

/** `GET /v1/buyer/catalog/listings/:slug`, returned un-enveloped. */
export interface ListingDetail {
  slug: string;
  title: string;
  description: string | null;
  priceCents: number;
  compareAtCents: number | null;
  currency: string;
  status: string;
  available: boolean;
  quantityAvailable: number;
  condition: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  categoryMain: string | null;
  categorySub: string | null;
  images: string[];
  sellerUsername: string | null;
  sellerDisplayName: string | null;
  listedAt: string | null;
}

/** `GET /v1/buyer/catalog/listings/:slug/availability`, the cheapest call in the API. */
export interface Availability {
  slug: string;
  available: boolean;
  quantityAvailable: number;
  priceCents: number;
  currency: string;
  status: string;
}

export type AvailabilityResult = { unchanged: true } | (Availability & { unchanged: false });

export interface FacetCount {
  value: string;
  count: number;
}

/** `GET /v1/buyer/catalog/facets`: three lists, so it is not a `{ data }` envelope. */
export interface Facets {
  brands: FacetCount[];
  conditions: FacetCount[];
  categories: FacetCount[];
}

// ── Monitors ──────────────────────────────────────────────────────────

export type MonitorKind = 'new_listing' | 'price_drop' | 'back_in_stock';
export type MonitorDelivery = 'webhook' | 'poll';

export interface MonitorQuery {
  /** Watch ONE listing. Required for back_in_stock. */
  slug?: string;
  q?: string;
  brand?: string;
  category?: string;
  condition?: string;
  seller?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
}

export interface CreateMonitorInput {
  name: string;
  kind: MonitorKind;
  query: MonitorQuery;
  delivery: MonitorDelivery;
  webhookUrl?: string;
}

export interface Monitor {
  id: string;
  name: string;
  kind: MonitorKind;
  query: MonitorQuery;
  delivery: MonitorDelivery;
  webhookUrl: string | null;
  /** Present ONCE, on the create response of a webhook monitor. Never readable again. */
  webhookSecret?: string;
  active: boolean;
  pausedReason: string | null;
  matchCount: number;
  lastCheckedAt: string | null;
  lastMatchAt: string | null;
  createdAt: string;
}

export interface MonitorMatch {
  listingSlug: string;
  triggerPriceCents: number;
  deliveredAt: string | null;
  createdAt: string;
}

/** The body POSTed to a webhook monitor's URL, signed with `Crossly-Signature`. */
export interface MonitorEvent {
  id: string;
  type: string;
  created: string;
  data: {
    monitorId: string;
    kind: MonitorKind;
    triggerPriceCents: number;
    previousPriceCents: number | null;
    listing: CatalogItem;
  };
}

// ── Checkout ──────────────────────────────────────────────────────────

/** Per-key spending controls. Cents; 0 means "no limit" for the two cent caps. */
export interface CheckoutControls {
  enabled: boolean;
  dailyLimitCents: number;
  perOrderLimitCents: number;
  maxUnitsPerListingPerDay: number;
}

export interface CheckoutControlsState extends CheckoutControls {
  patId: string;
}

export interface BuyRequest {
  listingSlug: string;
  quantity?: number;
  /** A payment method already saved on crossly.net. There is no field for a card. */
  paymentMethodId: string;
  /** Hard cap on the DELIVERED total (item + shipping + tax), in cents. */
  maxTotalCents?: number;
}

export interface BuyResult {
  listingSlug: string;
  quantity: number;
  totalCents: number;
  currency: string;
  chargeCurrency: string;
  chargeAmountMinor: number;
  paymentStatus: string;
  paymentIntentId: string | null;
  orderId: string | null;
}
