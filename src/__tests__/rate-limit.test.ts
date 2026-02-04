import { describe, it, expect, beforeEach, vi } from "vitest";
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
