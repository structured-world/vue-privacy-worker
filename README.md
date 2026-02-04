# Vue Privacy Worker

Cloudflare Worker companion for [@structured-world/vue-privacy](https://github.com/structured-world/vue-privacy) - GDPR consent storage in KV.

## Features

- Per-domain isolation (KV key prefix)
- 365-day TTL for consent storage
- Simple REST API (GET/POST)
- CORS support with per-domain configuration
- Rate limiting per IP address (configurable)
- Consent versioning for privacy policy updates
- **Consent analytics** — Track opt-in rates, banner impressions, time to decision
- **Privacy-first analytics** — Only aggregated daily counts, no PII stored
- **Admin reporting API** — Query analytics with date ranges

## API

### Consent Endpoints

#### Get Consent

```
GET /api/consent?id=<user_id>&version=<expected_version>
```

Parameters:
- `id` (required): User unique identifier
- `version` (optional): Expected consent version. If provided and doesn't match stored version, returns `found: false` to trigger re-consent

Response (consent found and version matches):
```json
{
  "found": true,
  "consent": {
    "categories": {
      "analytics": true,
      "marketing": false,
      "functional": true
    },
    "timestamp": 1706198400000,
    "version": "1",
    "domain": "example.com",
    "updatedAt": "2024-01-25T12:00:00.000Z"
  }
}
```

Response (version mismatch - triggers re-consent):
```json
{
  "found": false,
  "versionMismatch": true,
  "storedVersion": "1"  // The version stored in KV (null for legacy consents without version)
}
```

#### Store Consent

```
POST /api/consent
Content-Type: application/json

{
  "id": "user-unique-id",
  "categories": {
    "analytics": true,
    "marketing": false,
    "functional": true
  },
  "version": "1"
}
```

Response:
```json
{
  "success": true,
  "id": "user-unique-id"
}
```

### Analytics Endpoints

Track consent interaction metrics to understand user behavior. Privacy-first design: only aggregated counts are stored, no individual events or PII.

#### Record Analytics Event

```
POST /api/analytics
Content-Type: application/json

{
  "event": "consent_given",
  "categories": {
    "analytics": true,
    "marketing": false,
    "functional": true
  },
  "meta": {
    "timeToDecision": 3500,
    "source": "banner"
  }
}
```

**Event types:**
- `banner_shown` — Consent banner was displayed
- `consent_given` — User gave initial consent
- `consent_updated` — User modified their preferences
- `banner_dismissed` — User dismissed banner without action

**Optional fields:**
- `categories` — Only for `consent_given` and `consent_updated` events
- `meta.timeToDecision` — Milliseconds from banner shown to decision
- `meta.source` — Where consent was given: `banner` or `preference_center`

Response:
```json
{
  "success": true
}
```

#### Get Analytics Report (Admin)

```
GET /api/analytics?domain=<domain>&from=2026-01-01&to=2026-01-31
Authorization: Bearer <admin_token>
```

**Query parameters:**
- `domain` — Optional. Defaults to request host
- `from` — Start date (YYYY-MM-DD format)
- `to` — End date (YYYY-MM-DD format)

Response:
```json
{
  "domain": "example.com",
  "period": { "from": "2026-01-01", "to": "2026-01-31" },
  "totals": {
    "bannerShown": 45230,
    "consentGiven": 28456,
    "consentUpdated": 1234,
    "bannerDismissed": 15540,
    "optInRate": 0.629
  },
  "byCategory": {
    "analytics": { "acceptRate": 0.92 },
    "marketing": { "acceptRate": 0.34 },
    "functional": { "acceptRate": 0.98 }
  },
  "avgTimeToDecision": 4200,
  "daily": [
    {
      "date": "2026-01-01",
      "bannerShown": 1523,
      "consentGiven": 892,
      "consentUpdated": 45,
      "bannerDismissed": 586
    }
  ]
}
```

### Privacy Guarantees

Analytics are designed with privacy in mind:
- **No PII stored** — No user IDs, IP addresses, or fingerprints
- **Aggregates only** — Daily counts, not individual events
- **90-day retention** — Analytics auto-expire after 90 days
- **Domain isolation** — Each domain's analytics are separate

### Known Limitations

- **Eventual consistency** — Analytics use KV read-modify-write which has inherent race conditions under high concurrency. Multiple simultaneous events may cause minor count loss. For most consent banner use cases (low-to-moderate traffic), accuracy is sufficient. If exact counts are critical, consider using Durable Objects instead.

## KV Key Format

```
{domain}:{user_id}
```

Example: `example.com:abc123-def456`

## Rate Limiting

The worker implements per-IP rate limiting to prevent abuse.

### Default Limits

- **100 requests per minute** per IP address
- Applies to `/api/consent` endpoints only (GET and POST)
- `/api/geo` and `/api/analytics` are not rate-limited

### Customizing Limits

Override defaults via `wrangler.toml` variables:

```toml
[vars]
RATE_LIMIT_MAX_REQUESTS = "200"    # requests per window
RATE_LIMIT_WINDOW_SECONDS = "120"  # 2 minute window
```

### Response Headers

Rate-limited endpoints (`/api/consent`) include rate limit headers:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests allowed per window |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when window resets |

### Rate Limit Exceeded (429)

When limit is exceeded:

```json
{
  "error": "rate_limit_exceeded",
  "retryAfter": 45
}
```

Response headers include `Retry-After` with seconds until window resets.

### KV Key Format for Rate Limits

Rate limit state is stored in KV with prefix `rl:`:

```
rl:{ip_address}
```

This is a fixed-window rate limiter: the window resets based on an internal
`resetAt` timestamp. The KV entry TTL is set to `windowSeconds` on each allowed
request as a cleanup mechanism — entries auto-expire after the last allowed request.

**Fail-open behavior:** If KV operations fail (e.g., temporary unavailability),
requests proceed without rate limiting. This prioritizes availability over strict
enforcement. Rate limiting resumes automatically when KV recovers.

## Consent Versioning

The worker supports consent versioning to handle privacy policy changes. When your privacy policy or cookie categories change, you can bump the consent version to invalidate existing consents and force users to re-consent.

### How it works

1. When storing consent via POST, include the `version` field (e.g., `"1.0"`, `"2.0"`)
2. When retrieving consent via GET, pass the expected `version` query parameter
3. If the stored version doesn't match the expected version, the response returns `found: false` with `versionMismatch: true`
4. The client should show the consent banner again when version mismatch is detected

### Version mismatch response

```json
{
  "found": false,
  "versionMismatch": true,
  "storedVersion": "1.0"
}
```

### Best practices

- Use semantic versioning (e.g., `"1.0"`, `"1.1"`, `"2.0"`)
- Bump **major** version when cookie categories change
- Bump **minor** version for privacy policy text changes
- Store version in your app config and pass it to both GET and POST requests

### Example: handling privacy policy update

```javascript
// Your app config
const CONSENT_VERSION = "2.0"; // Bump when policy changes

// Check existing consent (relative URL works when served from same domain as the worker)
const response = await fetch(`/api/consent?id=${userId}&version=${CONSENT_VERSION}`);
const { found, versionMismatch } = await response.json();

if (!found) {
  if (versionMismatch) {
    console.log("Privacy policy updated, showing banner");
  }
  showConsentBanner();
}

// Store new consent
await fetch("/api/consent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    id: userId,
    version: CONSENT_VERSION,
    categories: { analytics: true, marketing: false, functional: true }
  })
});
```

## Self-Hosting

1. Fork this repository
2. Create KV namespaces:
   ```bash
   wrangler kv:namespace create CONSENT_KV
   wrangler kv:namespace create ANALYTICS_KV
   ```
3. Update `wrangler.toml` with your KV namespace IDs
4. Set admin token for analytics access:
   ```bash
   wrangler secret put ANALYTICS_ADMIN_TOKEN
   ```
5. Add routes for your domain:
   ```toml
   routes = [
     { pattern = "yourdomain.com/api/consent*", zone_name = "yourdomain.com" },
     { pattern = "yourdomain.com/api/geo", zone_name = "yourdomain.com" },
     { pattern = "yourdomain.com/api/analytics*", zone_name = "yourdomain.com" },
   ]
   ```
6. Deploy:
   ```bash
   yarn deploy
   ```

## Development

```bash
yarn install
yarn dev         # Local development
yarn test        # Run tests
yarn deploy      # Manual deploy
```

## Status & Roadmap

### Current (v1.3)

| Feature | Status |
|---------|--------|
| GET/POST consent API | Done |
| Per-domain KV isolation | Done |
| 365-day TTL storage | Done |
| CORS configuration | Done |
| GitHub Actions deploy | Done |
| Rate limiting | Done |
| Consent versioning | Done |
| Analytics events | Done |
| Admin analytics API | Done |

### Planned

| Feature | Description |
|---------|-------------|
| vue-privacy integration | Automatic sync with `@structured-world/vue-privacy` storage backend |
| Bulk export | Admin API for compliance exports |

## Integration with @structured-world/vue-privacy

This worker is designed to work with the `@structured-world/vue-privacy` npm package
for server-side consent storage.

**Note:** Integration with vue-privacy is planned but not yet implemented. Currently the worker
provides a standalone REST API for consent storage.

## License

Apache 2.0
