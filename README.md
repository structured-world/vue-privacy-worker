# Consent Worker

Cloudflare Worker for storing GDPR consent preferences in KV.

## Features

- Per-domain isolation (KV key prefix)
- 365-day TTL for consent storage
- Simple REST API (GET/POST)

## API

### Get Consent

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

### Store Consent

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

## KV Key Format

```
{domain}:{user_id}
```

Example: `example.com:abc123-def456`

## Adding a New Domain

1. Add route in `wrangler.toml`:
   ```toml
   routes = [
     { pattern = "newdomain.com/api/consent", zone_name = "newdomain.com" }
   ]
   ```

2. Optionally add CORS origins in `src/index.ts` `ALLOWED_DOMAINS`

## Secrets Required

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers edit |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

## Development

```bash
npm install
npm run dev      # Local development
npm run deploy   # Manual deploy
```

## Integration with @structured-world/consent

This worker is designed to work with the `@structured-world/consent` npm package
when KV storage backend is enabled (see issue #8 in consent repo).
