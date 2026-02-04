// Type declarations for test environment
declare module "cloudflare:test" {
  interface ProvidedEnv {
    CONSENT_KV: KVNamespace;
    ANALYTICS_KV: KVNamespace;
    ANALYTICS_ADMIN_TOKEN: string;
  }
}
