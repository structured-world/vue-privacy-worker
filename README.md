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
  "storedVersion": "1"
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

// Check existing consent
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
| ~~Consent versioning~~ | ✅ Track consent version changes |
| Bulk export | Admin API for compliance exports |
| Analytics events | Optional consent analytics (opt-in rates) |

## Integration with @structured-world/vue-privacy

This worker is designed to work with the `@structured-world/vue-privacy` npm package
for server-side consent storage.

**Note:** Integration with vue-privacy is planned but not yet implemented. Currently the worker
provides a standalone REST API for consent storage.

## License

Apache 2.0
