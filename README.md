# Vue Privacy Worker

Cloudflare Worker companion for [@structured-world/vue-privacy](https://github.com/structured-world/vue-privacy) - GDPR consent storage in KV.

## Features

- Per-domain isolation (KV key prefix)
- 365-day TTL for consent storage
- Simple REST API (GET/POST)
- CORS support with per-domain configuration

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

## Self-Hosting

1. Fork this repository
2. Create KV namespace:
   ```bash
   wrangler kv:namespace create CONSENT_KV
   ```
3. Update `wrangler.toml` with your KV namespace ID
4. Add route for your domain:
   ```toml
   routes = [
     { pattern = "yourdomain.com/api/consent", zone_name = "yourdomain.com" }
   ]
   ```
5. Deploy:
   ```bash
   npm run deploy
   ```

## Development

```bash
npm install
npm run dev      # Local development
npm run deploy   # Manual deploy
```

## Status & Roadmap

### Current (v1.0)

| Feature | Status |
|---------|--------|
| GET/POST consent API | Done |
| Per-domain KV isolation | Done |
| 365-day TTL storage | Done |
| CORS configuration | Done |
| GitHub Actions deploy | Done |

### Planned

| Feature | Description |
|---------|-------------|
| vue-privacy integration | Automatic sync with `@structured-world/vue-privacy` storage backend |
| Rate limiting | Prevent abuse via KV-based rate limiting |
| Consent versioning | Track consent version changes |
| Bulk export | Admin API for compliance exports |
| Analytics events | Optional consent analytics (opt-in rates) |

## Integration with @structured-world/vue-privacy

This worker is designed to work with the `@structured-world/vue-privacy` npm package
for server-side consent storage.

**Note:** Integration with vue-privacy is planned but not yet implemented. Currently the worker
provides a standalone REST API for consent storage.

## License

Apache 2.0
