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

interface Env {
  CONSENT_KV: KVNamespace;
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
    ctx?: ExecutionContext,
  ): Promise<Response> {
    // ctx is provided by Cloudflare runtime but not used in this worker
    void ctx;
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
    "Access-Control-Allow-Headers": "Content-Type",
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
        { found: false, versionMismatch: true, storedVersion: consent.version },
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
