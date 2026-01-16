import { Database } from "@db/sqlite";
import { load } from "@std/dotenv";

await load({ envPath: ".env.local", export: true });
const API_TOKEN = Deno.env.get("API_TOKEN");
if (!API_TOKEN) throw new Error("API_TOKEN environment variable is required");

const RATE_LIMIT_MS = 6000; // (six seven voice) six seconds!!

const db = new Database("data/data.db");
db.exec(`create table if not exists keys (
  id INTEGER NOT NULL PRIMARY KEY,
  base_url TEXT NOT NULL,
  key TEXT NOT NULL,
  last_used INTEGER DEFAULT 0
) strict`);

type Key = {
  readonly id: number;
  readonly baseUrl: string;
  readonly key: string;
};

const stmtGetLeastRecentlyUsedKey = db.prepare(
  `SELECT id, base_url as baseUrl, key FROM keys ORDER BY last_used ASC LIMIT 1`,
);
const stmtUpdateLastUsed = db.prepare(`UPDATE keys SET last_used = ? WHERE id = ?`);
const stmtGetLastUsed = db.prepare(`SELECT last_used FROM keys WHERE id = ?`);

const getLeastRecentlyUsedKey = (): Key => {
  const row = stmtGetLeastRecentlyUsedKey.get<Key>();
  if (!row) throw new Error("No API keys available in database");
  return row;
};

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

export default {
  async fetch(request: Request, _info: Deno.ServeHandlerInfo<Deno.Addr>): Promise<Response> {
    if (request.headers.get("authorization") !== `Bearer ${API_TOKEN}`) {
      return oaiError({
        status: 401,
        message: "Invalid authentication credentials",
        type: "invalid_request_error",
        code: "invalid_api_key",
      });
    }

    const key = getLeastRecentlyUsedKey();

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

    const url = new URL(request.url);
    const targetUrl = `${key.baseUrl}${url.pathname}${url.search}`;

    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${key.key}`);
    headers.delete("host");

    const body = await request.blob();
    const forwardedRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body,
    });

    const response = await fetch(forwardedRequest);
    return response;
  },
} satisfies Deno.ServeDefaultExport;
