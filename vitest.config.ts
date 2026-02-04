import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["CONSENT_KV", "ANALYTICS_KV"],
          bindings: {
            ANALYTICS_ADMIN_TOKEN: "test-admin-token",
          },
        },
      },
    },
  },
});
