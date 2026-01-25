/**
 * Cloudflare Worker: Consent Storage for GDPR compliance
 *
 * Stores user consent preferences in KV with 365-day TTL.
 * Per-domain isolation via KV key prefix.
 *
 * Endpoints:
 * - GET  /api/consent?id=<user_id> - Retrieve stored consent
 * - POST /api/consent - Store consent preferences
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

// Allowed origins per domain (add domains here)
const ALLOWED_DOMAINS: Record<string, string[]> = {
  // Example:
  // "example.com": ["https://example.com", "https://www.example.com"],
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const host = url.hostname;

    // CORS headers
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = getCorsHeaders(host, origin);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
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

  // Validate required fields
  const userId = data.id;
  if (!userId || typeof userId !== "string") {
    return jsonResponse({ error: "Missing id field" }, 400, corsHeaders);
  }

  if (!/^[a-zA-Z0-9-]{1,64}$/.test(userId)) {
    return jsonResponse({ error: "Invalid id format" }, 400, corsHeaders);
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
