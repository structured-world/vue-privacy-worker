# Vue Privacy Worker

Cloudflare Worker companion for [@structured-world/vue-privacy](https://github.com/structured-world/vue-privacy) - GDPR consent storage in KV.

## Features

- Per-domain isolation (KV key prefix)
- 365-day TTL for consent storage
- Simple REST API (GET/POST)
- CORS support with per-domain configuration
- **Consent analytics** — Track opt-in rates, banner impressions, time to decision
- **Privacy-first analytics** — Only aggregated daily counts, no PII stored
- **Admin reporting API** — Query analytics with date ranges

## API

### Consent Endpoints

#### Get Consent

```
GET /api/consent?id=<user_id>
```

Response:
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

## KV Key Format

```
{domain}:{user_id}
```

Example: `example.com:abc123-def456`

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

### Current (v1.1)

| Feature | Status |
|---------|--------|
| GET/POST consent API | Done |
| Per-domain KV isolation | Done |
| 365-day TTL storage | Done |
| CORS configuration | Done |
| GitHub Actions deploy | Done |
| Analytics events | Done |
| Admin analytics API | Done |

### Planned

| Feature | Description |
|---------|-------------|
| vue-privacy integration | Automatic sync with `@structured-world/vue-privacy` storage backend |
| Rate limiting | Prevent abuse via KV-based rate limiting |
| Consent versioning | Track consent version changes |
| Bulk export | Admin API for compliance exports |

## Integration with @structured-world/vue-privacy

This worker is designed to work with the `@structured-world/vue-privacy` npm package
for server-side consent storage.

**Note:** Integration with vue-privacy is planned but not yet implemented. Currently the worker
provides a standalone REST API for consent storage.

## License

Apache 2.0
