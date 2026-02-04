import { describe, it, expect, beforeEach } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../index";

// Helper to create a request with specific IP
function createRequest(
  method: string,
  path: string,
  options?: { ip?: string; body?: unknown; origin?: string },
): Request {
  const headers = new Headers({
    "CF-Connecting-IP": options?.ip || "192.168.1.1",
    Origin: options?.origin || "https://gitlab-mcp.sw.foundation",
  });

  if (options?.body) {
    headers.set("Content-Type", "application/json");
  }

  return new Request(`https://gitlab-mcp.sw.foundation${path}`, {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
}

describe("Rate Limiting", () => {
  beforeEach(async () => {
    // Clear all KV entries before each test
    const keys = await env.CONSENT_KV.list({ prefix: "rl:" });
    for (const key of keys.keys) {
      await env.CONSENT_KV.delete(key.name);
    }
  });

  it("should include rate limit headers on successful requests", async () => {
    const request = createRequest("GET", "/api/geo");
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    expect(response.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("should track request count per IP", async () => {
    const ip = "10.0.0.1";
    const ctx = createExecutionContext();

    // First request
    const response1 = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response1.headers.get("X-RateLimit-Remaining")).toBe("99");

    // Second request from same IP
    const ctx2 = createExecutionContext();
    const response2 = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(response2.headers.get("X-RateLimit-Remaining")).toBe("98");
  });

  it("should track different IPs separately", async () => {
    const ctx1 = createExecutionContext();
    const response1 = await worker.fetch(
      createRequest("GET", "/api/geo", { ip: "10.0.0.1" }),
      env,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);

    const ctx2 = createExecutionContext();
    const response2 = await worker.fetch(
      createRequest("GET", "/api/geo", { ip: "10.0.0.2" }),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);

    // Both should have 99 remaining since they're different IPs
    expect(response1.headers.get("X-RateLimit-Remaining")).toBe("99");
    expect(response2.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("should return 429 when rate limit exceeded", async () => {
    const ip = "10.0.0.99";

    // Manually set rate limit state to be at the limit
    await env.CONSENT_KV.put(
      `rl:${ip}`,
      JSON.stringify({ count: 100, resetAt: Math.floor(Date.now() / 1000) + 60 }),
      { expirationTtl: 60 },
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(429);

    const body = await response.json() as { error: string; retryAfter: number };
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(response.headers.get("Retry-After")).toBeTruthy();
  });

  it("should not apply rate limiting to OPTIONS requests", async () => {
    const ip = "10.0.0.100";

    // Set rate limit state to be at the limit
    await env.CONSENT_KV.put(
      `rl:${ip}`,
      JSON.stringify({ count: 100, resetAt: Math.floor(Date.now() / 1000) + 60 }),
      { expirationTtl: 60 },
    );

    const request = new Request("https://gitlab-mcp.sw.foundation/api/consent", {
      method: "OPTIONS",
      headers: {
        "CF-Connecting-IP": ip,
        Origin: "https://gitlab-mcp.sw.foundation",
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    // OPTIONS should succeed even when rate limited
    expect(response.status).toBe(204);
  });

  it("should expose rate limit headers via CORS", async () => {
    const request = createRequest("GET", "/api/geo");
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    const exposeHeaders = response.headers.get("Access-Control-Expose-Headers");
    expect(exposeHeaders).toContain("X-RateLimit-Limit");
    expect(exposeHeaders).toContain("X-RateLimit-Remaining");
    expect(exposeHeaders).toContain("X-RateLimit-Reset");
    expect(exposeHeaders).toContain("Retry-After");
  });
});

describe("Rate Limit Configuration", () => {
  beforeEach(async () => {
    const keys = await env.CONSENT_KV.list({ prefix: "rl:" });
    for (const key of keys.keys) {
      await env.CONSENT_KV.delete(key.name);
    }
  });

  it("should use custom RATE_LIMIT_MAX_REQUESTS from env", async () => {
    const ip = "10.0.0.50";
    // Create custom env with lower limit
    const customEnv = {
      ...env,
      RATE_LIMIT_MAX_REQUESTS: "5",
    };

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      customEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Should use custom limit of 5
    expect(response.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("4");
  });

  it("should fall back to defaults for invalid env values", async () => {
    const ip = "10.0.0.51";
    // Create env with invalid values
    const customEnv = {
      ...env,
      RATE_LIMIT_MAX_REQUESTS: "invalid",
      RATE_LIMIT_WINDOW_SECONDS: "-10",
    };

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      customEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Should fall back to default of 100
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
  });

  it("should fall back to defaults for zero values", async () => {
    const ip = "10.0.0.52";
    const customEnv = {
      ...env,
      RATE_LIMIT_MAX_REQUESTS: "0",
    };

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      customEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Should fall back to default, not block all requests
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.status).toBe(200);
  });
});

describe("Rate Limit Window Expiry", () => {
  beforeEach(async () => {
    const keys = await env.CONSENT_KV.list({ prefix: "rl:" });
    for (const key of keys.keys) {
      await env.CONSENT_KV.delete(key.name);
    }
  });

  it("should reset count when window expires", async () => {
    const ip = "10.0.0.60";

    // Set rate limit state with expired window (resetAt in the past)
    const expiredResetAt = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    await env.CONSENT_KV.put(
      `rl:${ip}`,
      JSON.stringify({ count: 99, resetAt: expiredResetAt }),
      { expirationTtl: 60 },
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Window expired, should start fresh with count=1, remaining=99
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("should maintain count within active window", async () => {
    const ip = "10.0.0.61";

    // Set rate limit state with active window (resetAt in the future)
    const activeResetAt = Math.floor(Date.now() / 1000) + 60; // 60 seconds from now
    await env.CONSENT_KV.put(
      `rl:${ip}`,
      JSON.stringify({ count: 50, resetAt: activeResetAt }),
      { expirationTtl: 60 },
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Window still active, should increment: count=51, remaining=49
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("49");
  });
});

describe("Consent API with Rate Limiting", () => {
  beforeEach(async () => {
    // Clear KV
    const rlKeys = await env.CONSENT_KV.list({ prefix: "rl:" });
    for (const key of rlKeys.keys) {
      await env.CONSENT_KV.delete(key.name);
    }
  });

  it("should include rate limit headers on POST consent", async () => {
    const request = createRequest("POST", "/api/consent", {
      body: {
        categories: { analytics: true, marketing: false, functional: true },
      },
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });

  it("should include rate limit headers on GET consent", async () => {
    const request = createRequest("GET", "/api/consent?id=test-user-123");

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
  });

  it("should include rate limit headers on 404 responses", async () => {
    const request = createRequest("GET", "/api/unknown");

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
  });
});

describe("Rate Limit Corrupted Data Handling", () => {
  // Tests for malformed KV entries that could occur from bugs, manual edits, or data corruption
  beforeEach(async () => {
    const keys = await env.CONSENT_KV.list({ prefix: "rl:" });
    for (const key of keys.keys) {
      await env.CONSENT_KV.delete(key.name);
    }
  });

  it("should handle negative count in KV by starting fresh window", async () => {
    const ip = "10.0.0.70";

    // Corrupted state with negative count
    await env.CONSENT_KV.put(
      `rl:${ip}`,
      JSON.stringify({ count: -5, resetAt: Math.floor(Date.now() / 1000) + 60 }),
      { expirationTtl: 60 },
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Invalid data should be treated as new window (count=1, remaining=99)
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("should handle non-numeric count in KV by starting fresh window", async () => {
    const ip = "10.0.0.71";

    // Corrupted state with string count
    await env.CONSENT_KV.put(
      `rl:${ip}`,
      JSON.stringify({ count: "fifty", resetAt: Math.floor(Date.now() / 1000) + 60 }),
      { expirationTtl: 60 },
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Invalid data should be treated as new window
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("should handle missing fields in KV by starting fresh window", async () => {
    const ip = "10.0.0.72";

    // Corrupted state with missing resetAt
    await env.CONSENT_KV.put(
      `rl:${ip}`,
      JSON.stringify({ count: 50 }),
      { expirationTtl: 60 },
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Missing fields should be treated as new window
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("99");
  });

  it("should fail-open on non-JSON data in KV (no rate limit headers)", async () => {
    const ip = "10.0.0.73";

    // Completely invalid data (not JSON) causes JSON.parse to throw
    await env.CONSENT_KV.put(
      `rl:${ip}`,
      "not-valid-json",
      { expirationTtl: 60 },
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // Fail-open: request succeeds but rate limit headers are not included
    // (KV error is caught and logged, request proceeds without rate limiting)
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBeNull();
  });

  it("should handle NaN resetAt in KV by starting fresh window", async () => {
    const ip = "10.0.0.74";

    // Corrupted state with NaN resetAt
    await env.CONSENT_KV.put(
      `rl:${ip}`,
      JSON.stringify({ count: 50, resetAt: NaN }),
      { expirationTtl: 60 },
    );

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      createRequest("GET", "/api/geo", { ip }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    // NaN resetAt should be treated as new window
    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("99");
  });
});
