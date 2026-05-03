import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const LOCAL_MCP_CREDENTIAL_PATH = "plugins.entries.local-mcp-search.config.webSearch.baseUrl";

type LocalMcpClientModule = typeof import("./local-mcp-client.js");

let localMcpClientModulePromise: Promise<LocalMcpClientModule> | undefined;

function loadLocalMcpClientModule(): Promise<LocalMcpClientModule> {
  localMcpClientModulePromise ??= import("./local-mcp-client.js");
  return localMcpClientModulePromise;
}

const LocalMcpSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-15).",
      minimum: 1,
      maximum: 15,
    },
    type: {
      type: "string",
      description: "Search type passed to the MCP server: auto, web, news.",
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createLocalMcpWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "local-mcp-search",
    label: "Local MCP Search",
    hint: "Self-hosted MCP search server (Exa + Tavily + Context7 + Grep.app)",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    credentialLabel: "Local MCP Search Base URL",
    envVars: ["MCP_SEARCH_URL"],
    placeholder: "http://127.0.0.1:8765",
    autoDetectOrder: 1,
    credentialPath: LOCAL_MCP_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: LOCAL_MCP_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "local-mcp-search" },
      configuredCredential: { pluginId: "local-mcp-search", field: "baseUrl" },
      selectionPluginId: "local-mcp-search",
    }),
    credentialNote: [
      "Optional. The plugin defaults to http://127.0.0.1:8765 when no base URL is set.",
      "Override via plugins.entries.local-mcp-search.config.webSearch.baseUrl",
      "or the MCP_SEARCH_URL environment variable.",
    ].join("\n"),
    createTool: (ctx) => ({
      description:
        "Search the web through the local MCP Search server (Exa + Tavily + Context7 + Grep.app). Returns titles, URLs, and snippets.",
      parameters: LocalMcpSearchSchema,
      execute: async (args) => {
        const { runLocalMcpSearch } = await loadLocalMcpClientModule();
        return await runLocalMcpSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readNumberParam(args, "count", { integer: true }),
          type: readStringParam(args, "type"),
        });
      },
    }),
  };
}
