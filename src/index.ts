/**
 * Cloudflare Worker: Consent Storage for GDPR compliance
 *
 * Stores user consent preferences in KV with 365-day TTL.
 * Per-domain isolation via KV key prefix.
 *
 * Endpoints:
 * - GET  /api/consent?id=<user_id>&version=<expected_version> - Retrieve stored consent
 *        If version param provided and doesn't match stored version, returns found: false
 * - POST /api/consent - Store consent preferences
 * - GET  /api/geo - Geo-detection via Cloudflare request.cf
 *
 * KV Binding: CONSENT_KV
 * KV Key format: {domain}:{user_id}
 * TTL: 365 days
 */

export interface Env {
  CONSENT_KV: KVNamespace;
  // Rate limit configuration (from wrangler.toml [vars])
  RATE_LIMIT_MAX_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
}

interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
  keyPrefix: string;
}

interface RateLimitState {
  count: number;
  resetAt: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
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

const CONSENT_TTL_SECONDS = 365 * 24 * 60 * 60; // 365 days

// Default rate limit values (can be overridden via wrangler.toml [vars])
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequests: 100,
  windowSeconds: 60,
  keyPrefix: "rl:",
};

/**
 * Get rate limit configuration from environment or defaults
 */
function getRateLimitConfig(env: Env): RateLimitConfig {
  const maxRequests = env.RATE_LIMIT_MAX_REQUESTS
    ? parseInt(env.RATE_LIMIT_MAX_REQUESTS, 10)
    : DEFAULT_RATE_LIMIT.maxRequests;
  const windowSeconds = env.RATE_LIMIT_WINDOW_SECONDS
    ? parseInt(env.RATE_LIMIT_WINDOW_SECONDS, 10)
    : DEFAULT_RATE_LIMIT.windowSeconds;

  // Fall back to defaults if env vars contain invalid numbers (NaN or <= 0)
  const validMaxRequests = Number.isNaN(maxRequests) || maxRequests <= 0
    ? DEFAULT_RATE_LIMIT.maxRequests
    : maxRequests;
  const validWindowSeconds = Number.isNaN(windowSeconds) || windowSeconds <= 0
    ? DEFAULT_RATE_LIMIT.windowSeconds
    : windowSeconds;

  return {
    maxRequests: validMaxRequests,
    windowSeconds: validWindowSeconds,
    keyPrefix: DEFAULT_RATE_LIMIT.keyPrefix,
  };
}

/**
 * Check and update rate limit for an IP address
 * Uses KV with TTL for automatic expiration
 */
async function checkRateLimit(
  request: Request,
  env: Env,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  // CF-Connecting-IP is set by Cloudflare for all requests passing through their network.
  // "unknown" fallback handles direct worker invocations (tests, wrangler dev without proxy).
  // These share a rate limit bucket, which is acceptable for non-production scenarios.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Rate limit keys use "rl:" prefix to avoid collision with consent data in shared KV namespace.
  // Separate namespace would add deployment complexity for minimal benefit.
  const key = `${config.keyPrefix}${ip}`;
  const now = Math.floor(Date.now() / 1000);

  // Note: KV doesn't support atomic increment, so there's a small race window between
  // read and write. For rate limiting, occasional over-counting is acceptable.
  const stored = await env.CONSENT_KV.get(key, "json") as RateLimitState | null;

  let state: RateLimitState;

  // Validate stored data structure (guard against corrupted KV entries)
  // Check: exists, count is non-negative number, resetAt is valid number
  const isValidState = stored &&
    typeof stored.count === "number" && !Number.isNaN(stored.count) && stored.count >= 0 &&
    typeof stored.resetAt === "number" && !Number.isNaN(stored.resetAt);

  if (isValidState && stored.resetAt > now) {
    // Existing window still active
    state = {
      count: stored.count + 1,
      resetAt: stored.resetAt,
    };
  } else {
    // New window (first request or window expired)
    state = {
      count: 1,
      resetAt: now + config.windowSeconds,
    };
  }

  const allowed = state.count <= config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - state.count);

  // Only update KV if request is allowed (blocked requests don't persist to KV).
  // This prevents attackers from resetting their window by flooding with requests.
  // Note: state.count is calculated in memory but only persisted when allowed=true.
  // TTL is set to windowSeconds on each write — entry expires windowSeconds after last allowed request.
  if (allowed) {
    await env.CONSENT_KV.put(key, JSON.stringify(state), {
      expirationTtl: config.windowSeconds,
    });
  }

  return {
    allowed,
    remaining,
    resetAt: state.resetAt,
    limit: config.maxRequests,
  };
}

/**
 * Add rate limit headers to a Headers object
 */
function addRateLimitHeaders(
  headers: Record<string, string>,
  result: RateLimitResult,
): Record<string, string> {
  return {
    ...headers,
    "X-RateLimit-Limit": result.limit.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": result.resetAt.toString(),
  };
}

/**
 * Create a 429 Too Many Requests response
 */
function rateLimitResponse(
  corsHeaders: Record<string, string>,
  result: RateLimitResult,
): Response {
  const headers = addRateLimitHeaders(corsHeaders, result);
  headers["Retry-After"] = Math.max(1, result.resetAt - Math.floor(Date.now() / 1000)).toString();

  return new Response(
    JSON.stringify({
      error: "rate_limit_exceeded",
      retryAfter: parseInt(headers["Retry-After"], 10),
    }),
    {
      status: 429,
      headers: { ...headers, "Content-Type": "application/json" },
    },
  );
}

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
    _ctx?: ExecutionContext,
  ): Promise<Response> {
    // ExecutionContext is part of Cloudflare Workers API but unused in this simple worker.
    // Keeping the parameter in the signature ensures compatibility with the Workers runtime
    // (which always passes ctx as third argument), while the underscore prefix indicates it is unused.
    const url = new URL(request.url);
    const host = url.hostname;

    // CORS headers
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = getCorsHeaders(host, origin);

    // Handle CORS preflight (no rate limiting for OPTIONS)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Geo-detection endpoint (no KV needed, no rate limiting)
    if (url.pathname === "/api/geo" && request.method === "GET") {
      return handleGeo(request, corsHeaders);
    }

    // Consent endpoints only from here
    if (url.pathname !== "/api/consent") {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    // Check KV binding (required for rate limiting and consent storage)
    if (!env.CONSENT_KV) {
      return jsonResponse(
        { error: "Storage not configured" },
        500,
        corsHeaders,
      );
    }

    // Check rate limit for all non-OPTIONS requests
    // On KV errors, allow request to proceed (fail-open for availability)
    let rateLimitResult: RateLimitResult | null = null;
    try {
      const rateLimitConfig = getRateLimitConfig(env);
      rateLimitResult = await checkRateLimit(request, env, rateLimitConfig);
    } catch (err) {
      // Log error but don't block request — prefer availability over strict rate limiting
      console.error("Rate limit check failed:", err instanceof Error ? err.message : err);
    }

    if (rateLimitResult && !rateLimitResult.allowed) {
      return rateLimitResponse(corsHeaders, rateLimitResult);
    }

    // Add rate limit headers to all responses (if rate limit check succeeded)
    const headersWithRateLimit = rateLimitResult
      ? addRateLimitHeaders(corsHeaders, rateLimitResult)
      : corsHeaders;

    try {
      if (request.method === "GET") {
        return handleGet(url, host, env, headersWithRateLimit);
      }

      if (request.method === "POST") {
        return handlePost(request, host, env, headersWithRateLimit);
      }

      return new Response("Method Not Allowed", {
        status: 405,
        headers: headersWithRateLimit,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("Consent storage error:", message);
      return jsonResponse({ error: "Internal error" }, 500, headersWithRateLimit);
    }
  },
};

function getCorsHeaders(host: string, origin: string): Record<string, string> {
  const allowedOrigins = ALLOWED_DOMAINS[host] || [`https://${host}`];
  const allowed = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After",
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
    | { country?: string; isEUCountry?: string; continent?: string; region?: string }
    | undefined;

  return jsonResponse(
    {
      isEU: cf?.isEUCountry === "1",
      countryCode: cf?.country ?? null,
      continent: cf?.continent ?? null,
      region: cf?.region ?? null,
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
  // Version param is optional - if provided, we validate against stored consent version
  // Version comparison is case-sensitive and format-agnostic (client controls format)
  const expectedVersion = url.searchParams.get("version");

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

    // Version validation: if expectedVersion is provided and doesn't match stored version,
    // return found: false to force re-consent. This handles legacy consents without version
    // field (consent.version would be undefined, triggering mismatch - correct behavior).
    if (expectedVersion && consent.version !== expectedVersion) {
      return jsonResponse(
        {
          found: false,
          versionMismatch: true,
          // For legacy consents without version field, storedVersion will be null
          storedVersion: consent.version ?? null,
        },
        200,
        corsHeaders,
      );
    }

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
