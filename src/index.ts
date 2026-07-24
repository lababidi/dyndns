/**
 * dyndns2-compatible update endpoint backed by Cloudflare DNS.
 *
 * Routers call:  GET /nic/update?hostname=<fqdn>[,<fqdn>...]&myip=<ip>[,<ip>...]
 * with HTTP Basic auth. Responds with the standard dyndns2 codes:
 * `good <ip>`, `nochg <ip>`, `badauth`, `nohost`, `notfqdn`, `911`.
 */

export interface Env {
  ZONE_ID: string;
  ZONE_NAME: string;
  CF_API_TOKEN: string;
  AUTH_USERNAME: string;
  AUTH_PASSWORD: string;
}

const CF_API = "https://api.cloudflare.com/client/v4";
const TTL_SECONDS = 60;

interface DnsRecord {
  id: string;
  type: "A" | "AAAA";
  name: string;
  content: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || !["/nic/update", "/update"].includes(url.pathname)) {
      return text("abuse", 404);
    }

    if (!checkAuth(request.headers.get("Authorization"), env)) {
      return text("badauth", 401, { "WWW-Authenticate": 'Basic realm="dyndns"' });
    }

    const hostnames = (url.searchParams.get("hostname") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (hostnames.length === 0) return text("notfqdn");

    const zone = env.ZONE_NAME.toLowerCase();
    const inZone = (h: string) => h === zone || h.endsWith(`.${zone}`);

    const ips = resolveIps(url.searchParams.get("myip"), request);
    if (ips.length === 0) return text("911");

    // One response line per hostname, per the dyndns2 spec.
    const lines: string[] = [];
    for (const hostname of hostnames) {
      if (!inZone(hostname)) {
        lines.push("nohost");
        continue;
      }
      try {
        const results = await Promise.all(ips.map((ip) => upsert(env, hostname, ip)));
        const changed = results.some((r) => r === "good");
        lines.push(`${changed ? "good" : "nochg"} ${ips.join(",")}`);
      } catch (err) {
        console.error(`update failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
        lines.push("911");
      }
    }
    return text(lines.join("\n"));
  },
} satisfies ExportedHandler<Env>;

/** Update or create the A/AAAA record. Returns "good" if it changed, "nochg" if not. */
async function upsert(env: Env, hostname: string, ip: string): Promise<"good" | "nochg"> {
  const type = ip.includes(":") ? "AAAA" : "A";
  const existing = await api<DnsRecord[]>(
    env,
    "GET",
    `/zones/${env.ZONE_ID}/dns_records?type=${type}&name=${encodeURIComponent(hostname)}`,
  );

  const record = existing[0];
  if (record?.content === ip) return "nochg";

  const body = JSON.stringify({ type, name: hostname, content: ip, ttl: TTL_SECONDS, proxied: false });
  if (record) {
    await api(env, "PUT", `/zones/${env.ZONE_ID}/dns_records/${record.id}`, body);
  } else {
    await api(env, "POST", `/zones/${env.ZONE_ID}/dns_records`, body);
  }
  return "good";
}

async function api<T>(env: Env, method: string, path: string, body?: string): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body,
  });
  const raw = await res.text();
  let data: { success: boolean; result: T; errors: unknown[] };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Cloudflare API ${method} ${path} returned non-JSON (${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!res.ok || !data.success) {
    throw new Error(`Cloudflare API ${method} ${path} failed (${res.status}): ${JSON.stringify(data.errors)}`);
  }
  return data.result;
}

/** Prefer valid IPs from `myip` (may be a comma list, v4 and/or v6); fall back to the connecting IP. */
function resolveIps(myip: string | null, request: Request): string[] {
  const fromParam = (myip ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => isIPv4(s) || isIPv6(s));
  if (fromParam.length > 0) return fromParam;

  const connecting = request.headers.get("CF-Connecting-IP");
  return connecting && (isIPv4(connecting) || isIPv6(connecting)) ? [connecting] : [];
}

function isIPv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIPv6(s: string): boolean {
  return /^[0-9a-fA-F:]{2,39}$/.test(s) && s.includes(":");
}

function checkAuth(header: string | null, env: Env): boolean {
  if (!env.AUTH_USERNAME || !env.AUTH_PASSWORD) return false;
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return timingSafeEqual(user, env.AUTH_USERNAME) && timingSafeEqual(pass, env.AUTH_PASSWORD);
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}
