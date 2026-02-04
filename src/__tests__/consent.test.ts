import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, afterEach } from "vitest";
import worker from "../index";

const TEST_HOST = "gitlab-mcp.sw.foundation";
const TEST_ORIGIN = "https://gitlab-mcp.sw.foundation";

/**
 * Helper to create a Request object for testing
 */
function createRequest(
  path: string,
  options: RequestInit = {},
): Request {
  const url = `https://${TEST_HOST}${path}`;
  return new Request(url, {
    headers: {
      Origin: TEST_ORIGIN,
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });
}

/**
 * Helper to invoke the worker and get JSON response
 */
async function fetchWorker(
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const request = createRequest(path, options);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);

  const data = (await response.json()) as Record<string, unknown>;
  return { status: response.status, data };
}

describe("Consent API", () => {
  // Test user IDs for cleanup
  const testUserIds: string[] = [];

  afterEach(async () => {
    // Cleanup: remove all test data from KV
    for (const userId of testUserIds) {
      await env.CONSENT_KV.delete(`${TEST_HOST}:${userId}`);
    }
    testUserIds.length = 0;
  });

  describe("GET /api/consent", () => {
    it("should return found: false when consent does not exist", async () => {
      const { status, data } = await fetchWorker("/api/consent?id=nonexistent-user-123");

      expect(status).toBe(200);
      expect(data.found).toBe(false);
    });

    it("should return error for missing id parameter", async () => {
      const { status, data } = await fetchWorker("/api/consent");

      expect(status).toBe(400);
      expect(data.error).toBe("Missing id parameter");
    });

    it("should return error for invalid id format", async () => {
      const { status, data } = await fetchWorker("/api/consent?id=invalid@id!");

      expect(status).toBe(400);
      expect(data.error).toBe("Invalid id format");
    });

    it("should return stored consent when it exists", async () => {
      // Arrange: store consent directly in KV
      const userId = "test-user-get-" + Date.now();
      testUserIds.push(userId);

      const storedConsent = {
        domain: TEST_HOST,
        categories: {
          analytics: true,
          marketing: false,
          functional: true,
        },
        timestamp: Date.now(),
        version: "1.0",
        updatedAt: new Date().toISOString(),
      };

      await env.CONSENT_KV.put(
        `${TEST_HOST}:${userId}`,
        JSON.stringify(storedConsent),
      );

      // Act
      const { status, data } = await fetchWorker(`/api/consent?id=${userId}`);

      // Assert
      expect(status).toBe(200);
      expect(data.found).toBe(true);
      expect(data.consent).toMatchObject({
        domain: TEST_HOST,
        version: "1.0",
        categories: {
          analytics: true,
          marketing: false,
          functional: true,
        },
      });
    });
  });

  describe("GET /api/consent - Version Validation", () => {
    /**
     * When the client requests a specific version and it matches,
     * the consent should be returned normally
     */
    it("should return consent when version matches", async () => {
      // Arrange: store consent with version 2.0
      const userId = "test-version-match-" + Date.now();
      testUserIds.push(userId);

      const storedConsent = {
        domain: TEST_HOST,
        categories: {
          analytics: true,
          marketing: false,
          functional: true,
        },
        timestamp: Date.now(),
        version: "2.0",
        updatedAt: new Date().toISOString(),
      };

      await env.CONSENT_KV.put(
        `${TEST_HOST}:${userId}`,
        JSON.stringify(storedConsent),
      );

      // Act: request with matching version
      const { status, data } = await fetchWorker(
        `/api/consent?id=${userId}&version=2.0`,
      );

      // Assert: consent returned
      expect(status).toBe(200);
      expect(data.found).toBe(true);
      expect((data.consent as Record<string, unknown>).version).toBe("2.0");
    });

    /**
     * When the client requests a specific version but stored version is different,
     * found: false should be returned to trigger re-consent
     */
    it("should return found: false when version does not match", async () => {
      // Arrange: store consent with version 1.0
      const userId = "test-version-mismatch-" + Date.now();
      testUserIds.push(userId);

      const storedConsent = {
        domain: TEST_HOST,
        categories: {
          analytics: true,
          marketing: false,
          functional: true,
        },
        timestamp: Date.now(),
        version: "1.0",
        updatedAt: new Date().toISOString(),
      };

      await env.CONSENT_KV.put(
        `${TEST_HOST}:${userId}`,
        JSON.stringify(storedConsent),
      );

      // Act: request with different version (privacy policy changed)
      const { status, data } = await fetchWorker(
        `/api/consent?id=${userId}&version=2.0`,
      );

      // Assert: found: false forces re-consent
      expect(status).toBe(200);
      expect(data.found).toBe(false);
      expect(data.versionMismatch).toBe(true);
      expect(data.storedVersion).toBe("1.0");
    });

    /**
     * When no version parameter is provided, consent should be returned
     * regardless of stored version (backward compatible)
     */
    it("should return consent when version parameter not provided", async () => {
      // Arrange: store consent with version 2.0
      const userId = "test-no-version-param-" + Date.now();
      testUserIds.push(userId);

      const storedConsent = {
        domain: TEST_HOST,
        categories: {
          analytics: true,
          marketing: false,
          functional: true,
        },
        timestamp: Date.now(),
        version: "2.0",
        updatedAt: new Date().toISOString(),
      };

      await env.CONSENT_KV.put(
        `${TEST_HOST}:${userId}`,
        JSON.stringify(storedConsent),
      );

      // Act: request without version parameter
      const { status, data } = await fetchWorker(`/api/consent?id=${userId}`);

      // Assert: consent returned (backward compatible)
      expect(status).toBe(200);
      expect(data.found).toBe(true);
      expect((data.consent as Record<string, unknown>).version).toBe("2.0");
    });

    /**
     * Edge case: version parameter provided but empty
     * Should treat as no version parameter (backward compatible)
     */
    it("should ignore empty version parameter", async () => {
      // Arrange
      const userId = "test-empty-version-" + Date.now();
      testUserIds.push(userId);

      const storedConsent = {
        domain: TEST_HOST,
        categories: {
          analytics: true,
          marketing: false,
          functional: true,
        },
        timestamp: Date.now(),
        version: "1.0",
        updatedAt: new Date().toISOString(),
      };

      await env.CONSENT_KV.put(
        `${TEST_HOST}:${userId}`,
        JSON.stringify(storedConsent),
      );

      // Act: request with empty version
      const { status, data } = await fetchWorker(
        `/api/consent?id=${userId}&version=`,
      );

      // Assert: consent returned because empty version param is treated as "no version check"
      // (empty string is falsy in JavaScript, so `if (expectedVersion && ...)` skips validation)
      expect(status).toBe(200);
      expect(data.found).toBe(true);
    });
  });

  describe("POST /api/consent", () => {
    it("should store consent with version", async () => {
      // Arrange
      const userId = "test-post-version-" + Date.now();
      testUserIds.push(userId);

      const consentPayload = {
        id: userId,
        categories: {
          analytics: true,
          marketing: false,
          functional: true,
        },
        version: "3.0",
      };

      // Act: store consent
      const { status, data } = await fetchWorker("/api/consent", {
        method: "POST",
        body: JSON.stringify(consentPayload),
      });

      // Assert: success
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.id).toBe(userId);

      // Verify: read back and check version
      const stored = await env.CONSENT_KV.get(`${TEST_HOST}:${userId}`);
      expect(stored).not.toBeNull();

      const parsed = JSON.parse(stored!) as Record<string, unknown>;
      expect(parsed.version).toBe("3.0");
    });

    it("should default version to '1' when not provided", async () => {
      // Arrange
      const userId = "test-post-default-version-" + Date.now();
      testUserIds.push(userId);

      const consentPayload = {
        id: userId,
        categories: {
          analytics: true,
          marketing: false,
          functional: true,
        },
        // No version provided
      };

      // Act
      const { status, data } = await fetchWorker("/api/consent", {
        method: "POST",
        body: JSON.stringify(consentPayload),
      });

      // Assert
      expect(status).toBe(200);
      expect(data.success).toBe(true);

      // Verify: default version
      const stored = await env.CONSENT_KV.get(`${TEST_HOST}:${userId}`);
      const parsed = JSON.parse(stored!) as Record<string, unknown>;
      expect(parsed.version).toBe("1");
    });

    it("should generate user ID when not provided", async () => {
      // Arrange
      const consentPayload = {
        categories: {
          analytics: false,
          marketing: false,
          functional: true,
        },
        version: "1.0",
      };

      // Act
      const { status, data } = await fetchWorker("/api/consent", {
        method: "POST",
        body: JSON.stringify(consentPayload),
      });

      // Assert
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.id).toBeDefined();
      expect(typeof data.id).toBe("string");

      // Cleanup: add generated ID to cleanup list
      testUserIds.push(data.id as string);
    });

    it("should return error for missing categories", async () => {
      const { status, data } = await fetchWorker("/api/consent", {
        method: "POST",
        body: JSON.stringify({ id: "test", version: "1.0" }),
      });

      expect(status).toBe(400);
      expect(data.error).toBe("Missing categories field");
    });

    it("should return error for invalid category value", async () => {
      const { status, data } = await fetchWorker("/api/consent", {
        method: "POST",
        body: JSON.stringify({
          id: "test",
          categories: {
            analytics: "yes", // Should be boolean
            marketing: false,
            functional: true,
          },
        }),
      });

      expect(status).toBe(400);
      expect(data.error).toBe("Invalid analytics value");
    });
  });

  describe("GET /api/geo", () => {
    it("should return geo information", async () => {
      const { status, data } = await fetchWorker("/api/geo");

      expect(status).toBe(200);
      expect(data.method).toBe("worker");
      // isEU may be undefined in test environment
      expect("isEU" in data).toBe(true);
    });
  });

  describe("CORS", () => {
    it("should handle OPTIONS preflight request", async () => {
      const request = createRequest("/api/consent", { method: "OPTIONS" });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
        "GET",
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
        "POST",
      );
    });

    it("should include CORS headers in response", async () => {
      const request = createRequest("/api/consent?id=test");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(TEST_ORIGIN);
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
      expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
    });
  });

  describe("Error handling", () => {
    it("should return 404 for unknown paths", async () => {
      const request = createRequest("/api/unknown");
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
    });

    it("should return 405 for unsupported methods", async () => {
      const request = createRequest("/api/consent?id=test", { method: "PUT" });
      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(405);
    });
  });
});
