/**
 * Cloudflare Worker: Consent Storage for GDPR compliance
 *
 * Stores user consent preferences in KV with 365-day TTL.
 * Per-domain isolation via KV key prefix.
 *
 * Endpoints:
 * - GET  /api/consent?id=<user_id> - Retrieve stored consent
 * - POST /api/consent - Store consent preferences
 * - GET  /api/geo - Geo-detection via Cloudflare request.cf
 * - POST /api/analytics - Record consent analytics events
 * - GET  /api/analytics - Admin reporting endpoint (requires auth)
 *
 * KV Bindings:
 * - CONSENT_KV: User consent storage (key format: {domain}:{user_id})
 * - ANALYTICS_KV: Analytics aggregates (key format: analytics:{domain}:{date})
 *
 * TTL: 365 days for consent, 90 days for analytics
 */

interface Env {
  CONSENT_KV: KVNamespace;
  ANALYTICS_KV: KVNamespace;
  ANALYTICS_ADMIN_TOKEN?: string;
}

interface ConsentData {
  categories: {
    analytics: boolean;
    marketing: boolean;
    functional: boolean;
  };
  timestamp: number;
  version: string;
}

interface StoredConsent extends ConsentData {
  domain: string;
  userAgent?: string;
  updatedAt: string;
}

// Analytics event types
type AnalyticsEventType =
  | "consent_given"
  | "consent_updated"
  | "banner_shown"
  | "banner_dismissed";

interface AnalyticsEventRequest {
  event: AnalyticsEventType;
  categories?: {
    analytics?: boolean;
    marketing?: boolean;
    functional?: boolean;
  };
  meta?: {
    timeToDecision?: number;
    source?: "banner" | "preference_center";
  };
}

// Aggregated analytics stored per domain per day
interface DailyAnalytics {
  banner_shown: number;
  consent_given: number;
  consent_updated: number;
  banner_dismissed: number;
  categories: {
    analytics: { accepted: number; rejected: number };
    marketing: { accepted: number; rejected: number };
    functional: { accepted: number; rejected: number };
  };
  timeToDecision: {
    sum: number;
    count: number;
  };
}

interface AnalyticsReportResponse {
  domain: string;
  period: { from: string; to: string };
  totals: {
    bannerShown: number;
    consentGiven: number;
    consentUpdated: number;
    bannerDismissed: number;
    optInRate: number;
  };
  byCategory: {
    analytics: { acceptRate: number };
    marketing: { acceptRate: number };
    functional: { acceptRate: number };
  };
  avgTimeToDecision: number | null;
  daily: Array<{
    date: string;
    bannerShown: number;
    consentGiven: number;
    consentUpdated: number;
    bannerDismissed: number;
  }>;
}

const CONSENT_TTL_SECONDS = 365 * 24 * 60 * 60; // 365 days
const ANALYTICS_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

// Allowed origins per domain
const ALLOWED_DOMAINS: Record<string, string[]> = {
  "gitlab-mcp.sw.foundation": [
    "https://gitlab-mcp.sw.foundation",
    "http://localhost:5173",
    "http://localhost:4173",
  ],
  "privacy.sw.foundation": [
    "https://privacy.sw.foundation",
    "http://localhost:5173",
    "http://localhost:4173",
  ],
};

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname;

    // CORS headers
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = getCorsHeaders(host, origin);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Geo-detection endpoint (no KV needed)
    if (url.pathname === "/api/geo" && request.method === "GET") {
      return handleGeo(request, corsHeaders);
    }

    // Analytics endpoints
    if (url.pathname === "/api/analytics") {
      if (!env.ANALYTICS_KV) {
        return jsonResponse(
          { error: "Analytics storage not configured" },
          500,
          corsHeaders,
        );
      }

      try {
        if (request.method === "POST") {
          return handleAnalyticsEvent(request, host, env, corsHeaders);
        }

        if (request.method === "GET") {
          return handleAnalyticsReport(request, url, host, env, corsHeaders);
        }

        return new Response("Method Not Allowed", {
          status: 405,
          headers: corsHeaders,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        console.error("Analytics error:", message);
        return jsonResponse({ error: "Internal error" }, 500, corsHeaders);
      }
    }

    // Consent endpoints
    if (url.pathname !== "/api/consent") {
      return new Response("Not Found", { status: 404 });
    }

    // Check KV binding
    if (!env.CONSENT_KV) {
      return jsonResponse(
        { error: "Storage not configured" },
        500,
        corsHeaders,
      );
    }

    try {
      if (request.method === "GET") {
        return handleGet(url, host, env, corsHeaders);
      }

      if (request.method === "POST") {
        return handlePost(request, host, env, corsHeaders);
      }

      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("Consent storage error:", message);
      return jsonResponse({ error: "Internal error" }, 500, corsHeaders);
    }
  },
};

function getCorsHeaders(host: string, origin: string): Record<string, string> {
  const allowedOrigins = ALLOWED_DOMAINS[host] || [`https://${host}`];
  const allowed = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function handleGeo(
  request: Request,
  corsHeaders: Record<string, string>,
): Response {
  const cf = request.cf as
    | { country?: string; isEUCountry?: string; continent?: string }
    | undefined;

  return jsonResponse(
    {
      isEU: cf?.isEUCountry === "1",
      countryCode: cf?.country ?? null,
      continent: cf?.continent ?? null,
      method: "worker",
    },
    200,
    corsHeaders,
  );
}

async function handleGet(
  url: URL,
  host: string,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const userId = url.searchParams.get("id");

  if (!userId) {
    return jsonResponse({ error: "Missing id parameter" }, 400, corsHeaders);
  }

  // Validate user ID format (alphanumeric + hyphen, max 64 chars)
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(userId)) {
    return jsonResponse({ error: "Invalid id format" }, 400, corsHeaders);
  }

  const kvKey = `${host}:${userId}`;
  const stored = await env.CONSENT_KV.get(kvKey);

  if (!stored) {
    return jsonResponse({ found: false }, 200, corsHeaders);
  }

  try {
    const consent = JSON.parse(stored) as StoredConsent;
    return jsonResponse({ found: true, consent }, 200, corsHeaders);
  } catch {
    return jsonResponse(
      { found: false, error: "Corrupted data" },
      200,
      corsHeaders,
    );
  }
}

async function handlePost(
  request: Request,
  host: string,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid request body" }, 400, corsHeaders);
  }

  const data = body as Record<string, unknown>;

  // User ID: use provided or generate new UUID
  let userId: string;
  if (data.id && typeof data.id === "string") {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(data.id)) {
      return jsonResponse({ error: "Invalid id format" }, 400, corsHeaders);
    }
    userId = data.id;
  } else {
    userId = crypto.randomUUID();
  }

  const categories = data.categories;
  if (!categories || typeof categories !== "object") {
    return jsonResponse(
      { error: "Missing categories field" },
      400,
      corsHeaders,
    );
  }

  const cats = categories as Record<string, unknown>;

  // Validate category values (must be booleans)
  const validCategories = ["analytics", "marketing", "functional"];
  for (const cat of validCategories) {
    if (typeof cats[cat] !== "boolean") {
      return jsonResponse({ error: `Invalid ${cat} value` }, 400, corsHeaders);
    }
  }

  const version = typeof data.version === "string" ? data.version : "1";

  const storedConsent: StoredConsent = {
    domain: host,
    categories: {
      analytics: cats.analytics as boolean,
      marketing: cats.marketing as boolean,
      functional: cats.functional as boolean,
    },
    timestamp: Date.now(),
    version,
    userAgent: request.headers.get("User-Agent") || undefined,
    updatedAt: new Date().toISOString(),
  };

  const kvKey = `${host}:${userId}`;

  await env.CONSENT_KV.put(kvKey, JSON.stringify(storedConsent), {
    expirationTtl: CONSENT_TTL_SECONDS,
  });

  return jsonResponse({ success: true, id: userId }, 200, corsHeaders);
}

// ============================================================================
// Analytics Handlers
// ============================================================================

const VALID_EVENT_TYPES: AnalyticsEventType[] = [
  "consent_given",
  "consent_updated",
  "banner_shown",
  "banner_dismissed",
];

// Returns current date in UTC (YYYY-MM-DD format)
// Using UTC ensures consistent daily buckets across all timezones
function getDateKey(): string {
  return new Date().toISOString().split("T")[0];
}

function getAnalyticsKey(domain: string, date: string): string {
  return `analytics:${domain}:${date}`;
}

function createEmptyDailyAnalytics(): DailyAnalytics {
  return {
    banner_shown: 0,
    consent_given: 0,
    consent_updated: 0,
    banner_dismissed: 0,
    categories: {
      analytics: { accepted: 0, rejected: 0 },
      marketing: { accepted: 0, rejected: 0 },
      functional: { accepted: 0, rejected: 0 },
    },
    timeToDecision: {
      sum: 0,
      count: 0,
    },
  };
}

async function handleAnalyticsEvent(
  request: Request,
  host: string,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const body = await request.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid request body" }, 400, corsHeaders);
  }

  const data = body as Record<string, unknown>;

  // Validate event type
  const eventType = data.event as string;
  if (!eventType || !VALID_EVENT_TYPES.includes(eventType as AnalyticsEventType)) {
    return jsonResponse(
      { error: "Invalid or missing event type" },
      400,
      corsHeaders,
    );
  }

  const dateKey = getDateKey();
  const kvKey = getAnalyticsKey(host, dateKey);

  // Get current daily analytics or create new
  // Note: Read-modify-write has inherent race condition in KV.
  // For analytics counters, small count loss under high concurrency is acceptable.
  // If exact counts are needed, use Durable Objects instead.
  const stored = await env.ANALYTICS_KV.get(kvKey);
  const analytics: DailyAnalytics = stored
    ? (JSON.parse(stored) as DailyAnalytics)
    : createEmptyDailyAnalytics();

  // Increment event counter
  analytics[eventType as keyof Pick<DailyAnalytics, AnalyticsEventType>]++;

  // Update category stats if categories provided
  const categories = data.categories as Record<string, boolean> | undefined;
  if (
    categories &&
    (eventType === "consent_given" || eventType === "consent_updated")
  ) {
    for (const cat of ["analytics", "marketing", "functional"] as const) {
      if (typeof categories[cat] === "boolean") {
        if (categories[cat]) {
          analytics.categories[cat].accepted++;
        } else {
          analytics.categories[cat].rejected++;
        }
      }
    }
  }

  // Update time to decision stats if provided (must be positive)
  const meta = data.meta as { timeToDecision?: number } | undefined;
  if (
    meta?.timeToDecision &&
    typeof meta.timeToDecision === "number" &&
    meta.timeToDecision > 0
  ) {
    analytics.timeToDecision.sum += meta.timeToDecision;
    analytics.timeToDecision.count++;
  }

  // Store updated analytics
  await env.ANALYTICS_KV.put(kvKey, JSON.stringify(analytics), {
    expirationTtl: ANALYTICS_TTL_SECONDS,
  });

  return jsonResponse({ success: true }, 200, corsHeaders);
}

async function handleAnalyticsReport(
  request: Request,
  url: URL,
  host: string,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  // Check admin authorization
  const authHeader = request.headers.get("Authorization");
  if (!env.ANALYTICS_ADMIN_TOKEN) {
    return jsonResponse(
      { error: "Admin access not configured" },
      500,
      corsHeaders,
    );
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Authorization required" }, 401, corsHeaders);
  }

  const token = authHeader.slice(7);
  if (token !== env.ANALYTICS_ADMIN_TOKEN) {
    return jsonResponse({ error: "Invalid token" }, 403, corsHeaders);
  }

  // Parse and validate query params
  const domainParam = url.searchParams.get("domain");
  // Validate domain format if provided (alphanumeric, dots, hyphens only)
  const domain =
    domainParam && /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(domainParam)
      ? domainParam
      : host;
  const fromDate = url.searchParams.get("from");
  const toDate = url.searchParams.get("to");

  if (!fromDate || !toDate) {
    return jsonResponse(
      { error: "Missing from/to date parameters" },
      400,
      corsHeaders,
    );
  }

  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(fromDate) || !dateRegex.test(toDate)) {
    return jsonResponse(
      { error: "Invalid date format. Use YYYY-MM-DD" },
      400,
      corsHeaders,
    );
  }

  // Generate date range
  const dates = getDateRange(fromDate, toDate);
  if (dates.length === 0) {
    return jsonResponse(
      { error: "Invalid date range" },
      400,
      corsHeaders,
    );
  }

  if (dates.length > 366) {
    return jsonResponse(
      { error: "Date range too large (max 366 days)" },
      400,
      corsHeaders,
    );
  }

  // Fetch all daily analytics in the range
  // Sequential KV lookups are acceptable for admin-only endpoint with max 366 days.
  // For higher scale, consider KV list() with prefix or aggregation in Durable Objects.
  const dailyData: Array<{ date: string; data: DailyAnalytics }> = [];
  for (const date of dates) {
    const kvKey = getAnalyticsKey(domain, date);
    const stored = await env.ANALYTICS_KV.get(kvKey);
    if (stored) {
      dailyData.push({ date, data: JSON.parse(stored) as DailyAnalytics });
    }
  }

  // Aggregate totals
  const totals = {
    bannerShown: 0,
    consentGiven: 0,
    consentUpdated: 0,
    bannerDismissed: 0,
  };
  const categoryTotals = {
    analytics: { accepted: 0, rejected: 0 },
    marketing: { accepted: 0, rejected: 0 },
    functional: { accepted: 0, rejected: 0 },
  };
  let timeToDecisionSum = 0;
  let timeToDecisionCount = 0;

  for (const { data } of dailyData) {
    totals.bannerShown += data.banner_shown;
    totals.consentGiven += data.consent_given;
    totals.consentUpdated += data.consent_updated;
    totals.bannerDismissed += data.banner_dismissed;

    for (const cat of ["analytics", "marketing", "functional"] as const) {
      categoryTotals[cat].accepted += data.categories[cat].accepted;
      categoryTotals[cat].rejected += data.categories[cat].rejected;
    }

    timeToDecisionSum += data.timeToDecision.sum;
    timeToDecisionCount += data.timeToDecision.count;
  }

  // Calculate rates
  const optInRate =
    totals.bannerShown > 0 ? totals.consentGiven / totals.bannerShown : 0;

  const byCategory = {
    analytics: {
      acceptRate: calculateAcceptRate(categoryTotals.analytics),
    },
    marketing: {
      acceptRate: calculateAcceptRate(categoryTotals.marketing),
    },
    functional: {
      acceptRate: calculateAcceptRate(categoryTotals.functional),
    },
  };

  const avgTimeToDecision =
    timeToDecisionCount > 0
      ? Math.round(timeToDecisionSum / timeToDecisionCount)
      : null;

  // Build daily breakdown
  const daily = dailyData.map(({ date, data }) => ({
    date,
    bannerShown: data.banner_shown,
    consentGiven: data.consent_given,
    consentUpdated: data.consent_updated,
    bannerDismissed: data.banner_dismissed,
  }));

  const report: AnalyticsReportResponse = {
    domain,
    period: { from: fromDate, to: toDate },
    totals: {
      ...totals,
      optInRate: Math.round(optInRate * 1000) / 1000,
    },
    byCategory,
    avgTimeToDecision,
    daily,
  };

  return jsonResponse(report, 200, corsHeaders);
}

function calculateAcceptRate(stats: { accepted: number; rejected: number }): number {
  const total = stats.accepted + stats.rejected;
  if (total === 0) return 0;
  return Math.round((stats.accepted / total) * 1000) / 1000;
}

function getDateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const fromDate = new Date(from);
  const toDate = new Date(to);

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return [];
  }

  if (fromDate > toDate) {
    return [];
  }

  const current = new Date(fromDate);
  while (current <= toDate) {
    dates.push(current.toISOString().split("T")[0]);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}
