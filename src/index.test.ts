import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "./index";

// Helper to create a request with optional body and headers
function createRequest(
  method: string,
  path: string,
  options?: {
    body?: unknown;
    origin?: string;
    authorization?: string;
    host?: string;
  },
): Request {
  const host = options?.host ?? "privacy.sw.foundation";
  const url = `https://${host}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options?.origin) {
    headers["Origin"] = options.origin;
  }

  if (options?.authorization) {
    headers["Authorization"] = options.authorization;
  }

  return new Request(url, {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
}

// Helper to make a request and parse JSON response
async function fetchJson<T>(
  request: Request,
  testEnv: typeof env,
): Promise<{ status: number; data: T }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  const data = (await response.json()) as T;
  return { status: response.status, data };
}

describe("Consent API", () => {
  // Test GET /api/consent without id parameter
  it("GET /api/consent returns error when id is missing", async () => {
    const request = createRequest("GET", "/api/consent");
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(400);
    expect(data.error).toBe("Missing id parameter");
  });

  // Test GET /api/consent with invalid id format
  it("GET /api/consent returns error for invalid id format", async () => {
    const request = createRequest("GET", "/api/consent?id=invalid@id!");
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(400);
    expect(data.error).toBe("Invalid id format");
  });

  // Test GET /api/consent for non-existent user
  it("GET /api/consent returns found:false for non-existent user", async () => {
    const request = createRequest("GET", "/api/consent?id=nonexistent-user");
    const { status, data } = await fetchJson<{ found: boolean }>(request, env);

    expect(status).toBe(200);
    expect(data.found).toBe(false);
  });

  // Test POST /api/consent and GET flow
  it("POST /api/consent stores consent and GET retrieves it", async () => {
    const userId = `test-user-${Date.now()}`;
    const consentData = {
      id: userId,
      categories: {
        analytics: true,
        marketing: false,
        functional: true,
      },
      version: "1.0",
    };

    // Store consent
    const postRequest = createRequest("POST", "/api/consent", {
      body: consentData,
    });
    const postResult = await fetchJson<{ success: boolean; id: string }>(
      postRequest,
      env,
    );

    expect(postResult.status).toBe(200);
    expect(postResult.data.success).toBe(true);
    expect(postResult.data.id).toBe(userId);

    // Retrieve consent
    const getRequest = createRequest("GET", `/api/consent?id=${userId}`);
    const getResult = await fetchJson<{
      found: boolean;
      consent: {
        categories: { analytics: boolean; marketing: boolean; functional: boolean };
        version: string;
      };
    }>(getRequest, env);

    expect(getResult.status).toBe(200);
    expect(getResult.data.found).toBe(true);
    expect(getResult.data.consent.categories.analytics).toBe(true);
    expect(getResult.data.consent.categories.marketing).toBe(false);
    expect(getResult.data.consent.categories.functional).toBe(true);
    expect(getResult.data.consent.version).toBe("1.0");
  });

  // Test POST /api/consent generates UUID when id not provided
  it("POST /api/consent generates UUID when id not provided", async () => {
    const consentData = {
      categories: {
        analytics: true,
        marketing: true,
        functional: true,
      },
    };

    const request = createRequest("POST", "/api/consent", { body: consentData });
    const { status, data } = await fetchJson<{ success: boolean; id: string }>(
      request,
      env,
    );

    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.id).toMatch(/^[a-f0-9-]{36}$/); // UUID format
  });

  // Test POST /api/consent with invalid body
  it("POST /api/consent returns error for invalid body", async () => {
    const request = new Request("https://privacy.sw.foundation/api/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "invalid json{",
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const data = (await response.json()) as { error: string };
    expect(data.error).toBe("Invalid request body");
  });

  // Test POST /api/consent with missing categories
  it("POST /api/consent returns error when categories missing", async () => {
    const request = createRequest("POST", "/api/consent", {
      body: { id: "test-user" },
    });
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(400);
    expect(data.error).toBe("Missing categories field");
  });
});

describe("Geo API", () => {
  // Test GET /api/geo
  it("GET /api/geo returns geo information", async () => {
    const request = createRequest("GET", "/api/geo");
    const { status, data } = await fetchJson<{
      isEU: boolean;
      countryCode: string | null;
      continent: string | null;
      method: string;
    }>(request, env);

    expect(status).toBe(200);
    expect(typeof data.isEU).toBe("boolean");
    expect(data.method).toBe("worker");
  });
});

describe("Analytics API", () => {
  // Test POST /api/analytics with valid event
  it("POST /api/analytics records banner_shown event", async () => {
    const request = createRequest("POST", "/api/analytics", {
      body: { event: "banner_shown" },
    });
    const { status, data } = await fetchJson<{ success: boolean }>(request, env);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  // Test POST /api/analytics with consent_given event and categories
  it("POST /api/analytics records consent_given with categories", async () => {
    const request = createRequest("POST", "/api/analytics", {
      body: {
        event: "consent_given",
        categories: {
          analytics: true,
          marketing: false,
          functional: true,
        },
        meta: {
          timeToDecision: 3500,
          source: "banner",
        },
      },
    });
    const { status, data } = await fetchJson<{ success: boolean }>(request, env);

    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  // Test POST /api/analytics with invalid event type
  it("POST /api/analytics returns error for invalid event type", async () => {
    const request = createRequest("POST", "/api/analytics", {
      body: { event: "invalid_event" },
    });
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(400);
    expect(data.error).toBe("Invalid or missing event type");
  });

  // Test POST /api/analytics with missing event
  it("POST /api/analytics returns error when event missing", async () => {
    const request = createRequest("POST", "/api/analytics", {
      body: { categories: {} },
    });
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(400);
    expect(data.error).toBe("Invalid or missing event type");
  });

  // Test GET /api/analytics without authorization
  it("GET /api/analytics returns 401 without authorization", async () => {
    const request = createRequest(
      "GET",
      "/api/analytics?from=2026-01-01&to=2026-01-31",
    );
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(401);
    expect(data.error).toBe("Authorization required");
  });

  // Test GET /api/analytics with invalid token
  it("GET /api/analytics returns 403 with invalid token", async () => {
    const request = createRequest(
      "GET",
      "/api/analytics?from=2026-01-01&to=2026-01-31",
      { authorization: "Bearer invalid-token" },
    );
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(403);
    expect(data.error).toBe("Invalid token");
  });

  // Test GET /api/analytics with missing date params
  it("GET /api/analytics returns error when dates missing", async () => {
    const request = createRequest("GET", "/api/analytics", {
      authorization: "Bearer test-admin-token",
    });
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(400);
    expect(data.error).toBe("Missing from/to date parameters");
  });

  // Test GET /api/analytics with invalid date format
  it("GET /api/analytics returns error for invalid date format", async () => {
    const request = createRequest(
      "GET",
      "/api/analytics?from=01-01-2026&to=01-31-2026",
      { authorization: "Bearer test-admin-token" },
    );
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(400);
    expect(data.error).toBe("Invalid date format. Use YYYY-MM-DD");
  });

  // Test GET /api/analytics with valid auth returns report
  it("GET /api/analytics returns report with valid auth", async () => {
    const today = new Date().toISOString().split("T")[0];

    // First, record some events
    await fetchJson(
      createRequest("POST", "/api/analytics", {
        body: { event: "banner_shown" },
      }),
      env,
    );
    await fetchJson(
      createRequest("POST", "/api/analytics", {
        body: {
          event: "consent_given",
          categories: { analytics: true, marketing: false, functional: true },
        },
      }),
      env,
    );

    // Now fetch the report
    const request = createRequest(
      "GET",
      `/api/analytics?from=${today}&to=${today}`,
      { authorization: "Bearer test-admin-token" },
    );
    const { status, data } = await fetchJson<{
      domain: string;
      period: { from: string; to: string };
      totals: {
        bannerShown: number;
        consentGiven: number;
        optInRate: number;
      };
      byCategory: {
        analytics: { acceptRate: number };
        marketing: { acceptRate: number };
        functional: { acceptRate: number };
      };
      daily: Array<{ date: string; bannerShown: number; consentGiven: number }>;
    }>(request, env);

    expect(status).toBe(200);
    expect(data.domain).toBe("privacy.sw.foundation");
    expect(data.period.from).toBe(today);
    expect(data.period.to).toBe(today);
    expect(data.totals.bannerShown).toBeGreaterThanOrEqual(1);
    expect(data.totals.consentGiven).toBeGreaterThanOrEqual(1);
    expect(typeof data.totals.optInRate).toBe("number");
    expect(data.daily.length).toBeGreaterThanOrEqual(1);
  });

  // Test all event types
  it("POST /api/analytics accepts all valid event types", async () => {
    const eventTypes = [
      "consent_given",
      "consent_updated",
      "banner_shown",
      "banner_dismissed",
    ];

    for (const eventType of eventTypes) {
      const request = createRequest("POST", "/api/analytics", {
        body: { event: eventType },
      });
      const { status, data } = await fetchJson<{ success: boolean }>(
        request,
        env,
      );

      expect(status).toBe(200);
      expect(data.success).toBe(true);
    }
  });

  // Test date range too large validation
  it("GET /api/analytics returns error for date range exceeding 366 days", async () => {
    const request = createRequest(
      "GET",
      "/api/analytics?from=2024-01-01&to=2026-01-01",
      { authorization: "Bearer test-admin-token" },
    );
    const { status, data } = await fetchJson<{ error: string }>(request, env);

    expect(status).toBe(400);
    expect(data.error).toBe("Date range too large (max 366 days)");
  });

  // Test negative timeToDecision is ignored (verify event still succeeds)
  it("POST /api/analytics ignores negative timeToDecision values", async () => {
    // Record event with negative timeToDecision - should succeed but not track the time
    const { status, data } = await fetchJson<{ success: boolean }>(
      createRequest("POST", "/api/analytics", {
        body: {
          event: "banner_dismissed",
          meta: { timeToDecision: -1000 },
        },
      }),
      env,
    );

    // Event should still be recorded successfully
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  // Test Infinity timeToDecision is ignored
  it("POST /api/analytics ignores Infinity timeToDecision values", async () => {
    const { status, data } = await fetchJson<{ success: boolean }>(
      createRequest("POST", "/api/analytics", {
        body: {
          event: "banner_dismissed",
          meta: { timeToDecision: Infinity },
        },
      }),
      env,
    );

    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });
});

describe("CORS", () => {
  // Test OPTIONS preflight
  it("OPTIONS returns 204 with CORS headers", async () => {
    const request = new Request("https://privacy.sw.foundation/api/consent", {
      method: "OPTIONS",
      headers: { Origin: "https://privacy.sw.foundation" },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://privacy.sw.foundation",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "GET",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
  });

  // Test localhost origin for development
  it("allows localhost origins for development", async () => {
    const request = new Request(
      "https://privacy.sw.foundation/api/consent?id=test",
      {
        method: "GET",
        headers: { Origin: "http://localhost:5173" },
      },
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
  });
});

describe("Error handling", () => {
  // Test 404 for unknown paths
  it("returns 404 for unknown paths", async () => {
    const request = createRequest("GET", "/api/unknown");

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });

  // Test 405 for unsupported methods
  it("returns 405 for unsupported methods on /api/consent", async () => {
    const request = new Request("https://privacy.sw.foundation/api/consent", {
      method: "DELETE",
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(405);
  });
});
