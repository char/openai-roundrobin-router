import { Database } from "@db/sqlite";
import { load } from "@std/dotenv";

await load({ envPath: ".env.local", export: true });
await load({ envPath: ".env", export: true });

const API_TOKEN = Deno.env.get("API_TOKEN");
if (!API_TOKEN) throw new Error("API_TOKEN environment variable is required");

const RATE_LIMIT_MS = 6000; // (six seven voice) six seconds!!

const db = new Database("data/data.db");

type Key = {
  readonly id: number;
  readonly baseUrl: string;
  readonly key: string;
  readonly pool: string;
};

db.exec(`create table if not exists keys (
  id INTEGER NOT NULL PRIMARY KEY,
  base_url TEXT NOT NULL,
  key TEXT NOT NULL,
  pool TEXT NOT NULL,
  last_used INTEGER DEFAULT 0
) strict`);

const stmtGetLeastRecentlyUsedKey = db.prepare(
  `SELECT id, base_url as baseUrl, key, pool FROM keys WHERE pool = ? ORDER BY last_used ASC LIMIT 1`,
);
const getLeastRecentlyUsedKey = (pool: string): Key | undefined => {
  const row = stmtGetLeastRecentlyUsedKey.get<Key>(pool);
  return row ?? undefined;
};

const stmtUpdateLastUsed = db.prepare(`UPDATE keys SET last_used = ? WHERE id = ?`);
const stmtGetLastUsed = db.prepare(`SELECT last_used FROM keys WHERE id = ?`);

const updateLastUsed = (keyId: number, now: number): void => {
  stmtUpdateLastUsed.run(now, keyId);
};

const getLastUsed = (keyId: number): number => {
  const row = stmtGetLastUsed.get<{ last_used: number }>(keyId);
  return row?.last_used || 0;
};

type OpenAIError = {
  readonly status: number;
  readonly message: string;
  readonly type: string;
  readonly code: string;
  readonly headers?: Record<string, string>;
};
const oaiError = (error: OpenAIError): Response => {
  const { message, type, code } = error;
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        code,
        param: null,
      },
    }),
    {
      status: error.status,
      headers: {
        "content-type": "application/json",
        ...error.headers,
      },
    },
  );
};

const handler = async (
  request: Request,
  _info: Deno.ServeHandlerInfo<Deno.Addr>,
): Promise<Response> => {
  const authz = request.headers.get("authorization") ?? "";
  const apiToken = authz.startsWith("Bearer ") ? authz.substring("Bearer ".length) : undefined;
  const key = apiToken ? getLeastRecentlyUsedKey(apiToken) : undefined;
  if (!key) {
    return oaiError({
      status: 401,
      message: "Invalid authentication credentials",
      type: "invalid_request_error",
      code: "invalid_api_key",
    });
  }

  const url = new URL(request.url);

  const now = Date.now();
  const lastUsed = getLastUsed(key.id);
  const timeSinceLastUse = now - lastUsed;
  if (timeSinceLastUse < RATE_LIMIT_MS) {
    return oaiError({
      status: 429,
      message: "Rate limit reached for requests. All API keys have been used too recently.",
      type: "requests",
      code: "rate_limit_exceeded",
      headers: {
        "retry-after": Math.ceil((RATE_LIMIT_MS - timeSinceLastUse) / 1000).toString(),
      },
    });
  }

  updateLastUsed(key.id, now);

  const targetUrl = `${key.baseUrl}${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${key.key}`);
  for (const h of [
    "host",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-server",
    "x-real-ip",
    "x-scheme",
  ]) {
    headers.delete(h);
  }

  const body = await request.blob();
  const forwardedRequest = new Request(targetUrl, {
    method: request.method,
    headers: headers,
    body,
  });

  console.log(forwardedRequest);
  console.log(
    Deno.inspect(JSON.parse(await body.text()), {
      breakLength: Infinity,
      colors: true,
      compact: true,
      depth: Infinity,
    }),
  );

  const response = await fetch(forwardedRequest);
  console.log(response);
  return response;
};

export default {
  fetch: handler,
} satisfies Deno.ServeDefaultExport;

if (import.meta.main) {
  const BIND_PATH = Deno.env.get("BIND_PATH");
  if (BIND_PATH === undefined) throw new Error("BIND_PATH environment variable is required");
  const server = Deno.serve({ path: BIND_PATH }, handler);
  await server.finished;
}
