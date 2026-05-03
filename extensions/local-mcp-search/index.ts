import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createLocalMcpWebSearchProvider } from "./src/local-mcp-search-provider.js";

export default definePluginEntry({
  id: "local-mcp-search",
  name: "Local MCP Search Plugin",
  description: "Marcel-Claw local MCP search server provider (calls 127.0.0.1:8765/search)",
  register(api) {
    api.registerWebSearchProvider(createLocalMcpWebSearchProvider());
  },
});
