import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInput,
} from "openclaw/plugin-sdk/secret-input";

const LOCAL_MCP_DEFAULT_BASE_URL = "http://127.0.0.1:8765";

type LocalMcpPluginConfig = {
  webSearch?: {
    baseUrl?: unknown;
  };
};

function normalizeConfiguredString(value: unknown, path: string): string | undefined {
  try {
    return normalizeSecretInput(
      normalizeResolvedSecretInputString({
        value,
        path,
      }),
    );
  } catch {
    return undefined;
  }
}

function readInlineEnvSecretRefValue(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as { source?: unknown; id?: unknown };
  if (record.source !== "env" || typeof record.id !== "string") {
    return undefined;
  }
  return normalizeSecretInput(env[record.id]);
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/u, "") || undefined;
}

function resolveLocalMcpWebSearchConfig(
  config?: OpenClawConfig,
): LocalMcpPluginConfig["webSearch"] | undefined {
  const pluginConfig = config?.plugins?.entries?.["local-mcp-search"]?.config as
    | LocalMcpPluginConfig
    | undefined;
  const webSearch = pluginConfig?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveLocalMcpBaseUrl(
  config?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const webSearch = resolveLocalMcpWebSearchConfig(config);
  return (
    normalizeBaseUrl(
      normalizeConfiguredString(
        webSearch?.baseUrl,
        "plugins.entries.local-mcp-search.config.webSearch.baseUrl",
      ),
    ) ??
    normalizeBaseUrl(readInlineEnvSecretRefValue(webSearch?.baseUrl, env)) ??
    normalizeBaseUrl(normalizeSecretInput(env.MCP_SEARCH_URL)) ??
    LOCAL_MCP_DEFAULT_BASE_URL
  );
}
