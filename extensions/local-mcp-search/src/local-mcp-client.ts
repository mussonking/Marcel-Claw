import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_SEARCH_COUNT,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveSearchCount,
  resolveSiteName,
  resolveTimeoutSeconds,
  withSelfHostedWebSearchEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  assertHttpUrlTargetsPrivateNetwork,
  type LookupFn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveLocalMcpBaseUrl } from "./config.js";

const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_RESPONSE_BYTES = 1_000_000;

const LOCAL_MCP_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

type LocalMcpResultRaw = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  source_engine?: unknown;
  score?: unknown;
};

type LocalMcpResponse = {
  results?: LocalMcpResultRaw[];
  engines_used?: unknown;
};

type LocalMcpResultNormalized = {
  title: string;
  url: string;
  snippet: string;
  engine: string | undefined;
  score: number | undefined;
};

function normalizeResult(raw: unknown): LocalMcpResultNormalized | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as LocalMcpResultRaw;
  const url = typeof candidate.url === "string" ? candidate.url : "";
  if (!url) {
    return null;
  }
  return {
    title: typeof candidate.title === "string" ? candidate.title : "",
    url,
    snippet: typeof candidate.snippet === "string" ? candidate.snippet : "",
    engine: typeof candidate.source_engine === "string" ? candidate.source_engine : undefined,
    score: typeof candidate.score === "number" ? candidate.score : undefined,
  };
}

function buildSearchUrl(params: {
  baseUrl: string;
  query: string;
  count: number;
  type: string;
}): string {
  const url = new URL(params.baseUrl);
  const pathname = url.pathname.endsWith("/") ? `${url.pathname}search` : `${url.pathname}/search`;
  url.pathname = pathname;
  url.search = "";
  url.searchParams.set("q", params.query);
  url.searchParams.set("type", params.type);
  url.searchParams.set("max", String(params.count));
  return url.toString();
}

async function validateLocalMcpBaseUrl(baseUrl: string, lookupFn?: LookupFn): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("Local MCP base URL must be a valid http:// or https:// URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Local MCP base URL must use http:// or https://.");
  }

  await assertHttpUrlTargetsPrivateNetwork(parsed.toString(), {
    dangerouslyAllowPrivateNetwork: true,
    lookupFn,
    errorMessage:
      "Local MCP base URL must target a trusted private or loopback host (e.g. 127.0.0.1).",
  });
}

async function fetchLocalMcpResults(params: {
  baseUrl: string;
  query: string;
  count: number;
  type: string;
  timeoutSeconds: number;
}): Promise<{ results: LocalMcpResultNormalized[]; enginesUsed: string[] }> {
  const url = buildSearchUrl({
    baseUrl: params.baseUrl,
    query: params.query,
    count: params.count,
    type: params.type,
  });

  return await withSelfHostedWebSearchEndpoint(
    {
      url,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 8_000 })).text;
        throw new Error(
          `Local MCP search error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const body = await readResponseText(response, { maxBytes: MAX_RESPONSE_BYTES });
      if (body.truncated) {
        throw new Error("Local MCP search response too large.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text) as LocalMcpResponse;
      } catch {
        throw new Error("Local MCP search returned invalid JSON.");
      }

      if (!parsed || typeof parsed !== "object") {
        return { results: [], enginesUsed: [] };
      }

      const data = parsed as LocalMcpResponse;
      const rawResults = Array.isArray(data.results) ? data.results : [];
      const results: LocalMcpResultNormalized[] = [];
      for (const raw of rawResults) {
        const normalized = normalizeResult(raw);
        if (normalized) {
          results.push(normalized);
        }
        if (results.length >= params.count) {
          break;
        }
      }
      const enginesUsed = Array.isArray(data.engines_used)
        ? data.engines_used.filter((engine): engine is string => typeof engine === "string")
        : [];
      return { results, enginesUsed };
    },
  );
}

export async function runLocalMcpSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  type?: string;
  baseUrl?: string;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Promise<Record<string, unknown>> {
  const count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);
  const type = (params.type ?? "auto").trim() || "auto";
  const baseUrl = params.baseUrl ?? resolveLocalMcpBaseUrl(params.config);
  const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);

  await validateLocalMcpBaseUrl(baseUrl);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: "local-mcp-search",
      query: params.query,
      count,
      type,
      baseUrl,
    }),
  );
  const cached = readCache(LOCAL_MCP_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const startedAt = Date.now();
  const { results, enginesUsed } = await fetchLocalMcpResults({
    baseUrl,
    query: params.query,
    count,
    type,
    timeoutSeconds,
  });

  const payload = {
    query: params.query,
    provider: "local-mcp-search",
    count: results.length,
    enginesUsed,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "local-mcp-search",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
      engine: result.engine,
      score: result.score,
    })),
  } satisfies Record<string, unknown>;

  writeCache(LOCAL_MCP_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
  return payload;
}

export const __testing = {
  buildSearchUrl,
  normalizeResult,
  validateLocalMcpBaseUrl,
  LOCAL_MCP_SEARCH_CACHE,
};
