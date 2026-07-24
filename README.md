# dyndns

A dyndns2-compatible dynamic DNS endpoint running as a Cloudflare Worker, writing
A/AAAA records into the `example.com` zone via the Cloudflare API. Point any router's
"custom dyndns" client at it.

**Deployed at:** `https://dyndns.example.com`

## Protocol

```
GET /nic/update?hostname=<fqdn>[,<fqdn>...]&myip=<ip>[,<ip>...]
Authorization: Basic <user:pass>
```

Responses follow the dyndns2 convention, one line per hostname:

| Response     | Meaning                                        |
| ------------ | ---------------------------------------------- |
| `good <ip>`  | Record updated (or created)                    |
| `nochg <ip>` | IP unchanged, nothing written                  |
| `badauth`    | Bad/missing Basic auth (HTTP 401)              |
| `nohost`     | Hostname not in the allowlist                  |
| `notfqdn`    | No hostname given                              |
| `911`        | Server-side failure (Cloudflare API / config)  |

If `myip` is missing or invalid, the connecting IP (`CF-Connecting-IP`) is used.
IPv6 addresses update AAAA records; both can be sent comma-separated in one call.
Records are written DNS-only (grey cloud) with TTL 60.

## Configuration

Plain vars (in `wrangler.jsonc`):

- `ZONE_ID` — Cloudflare zone to write into
- `ZONE_NAME` — zone apex; any hostname in this zone may be updated

Secrets (`wrangler secret put <NAME>`, or set at deploy time):

- `CF_API_TOKEN` — API token with **Zone → DNS → Edit** on the zone only
- `AUTH_USERNAME` / `AUTH_PASSWORD` — Basic-auth credentials the router sends

Local dev values live in `.dev.vars` (gitignored).

## Router setup

- Update URL: `https://dyndns.example.com/nic/update`
  (append `?hostname=home.example.com&myip=%IP%` if the firmware expects a full URL
  with placeholders rather than dyndns2 provider fields)
- Hostname: `home.example.com`
- Username/password: the `AUTH_USERNAME` / `AUTH_PASSWORD` secrets

Manual update / cron fallback:

```sh
curl -u "$USER:$PASS" "https://dyndns.example.com/nic/update?hostname=home.example.com"
```

## Develop & deploy

```sh
npm install
npm run dev      # local dev server (uses .dev.vars)
npm run deploy   # wrangler deploy (requires wrangler login or CLOUDFLARE_API_TOKEN)
```

Any hostname under `example.com` can be created/updated with valid credentials — no
per-hostname allowlist. Hostnames outside the zone get `nohost` (and the API
token couldn't touch them anyway).
