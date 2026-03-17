declare namespace Cloudflare {
  interface Env {
    CONSENT_KV: KVNamespace;
    RATE_LIMIT_MAX_REQUESTS?: string;
    RATE_LIMIT_WINDOW_SECONDS?: string;
  }
}
