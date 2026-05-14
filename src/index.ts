#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLaunchTool, registerTopologyLaunchTool } from "./tools/launch.js";
import { registerListManagedTool } from "./tools/list.js";
import { registerInspectTool } from "./tools/inspect.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { isHcomAvailable } from "./hcom.js";

const server = new McpServer({
  name: "hcom-mcp",
  version: "0.1.0",
});

async function main() {
  // Check hcom availability on startup
  const available = await isHcomAvailable();
  if (!available) {
    console.error("ERROR: hcom CLI not found on PATH. Install it first: https://github.com/aannoo/hcom");
    process.exit(1);
  }
  console.error("hcom CLI found, starting MCP server...");

  // Register all tools
  registerLaunchTool(server);
  registerTopologyLaunchTool(server);
  registerListManagedTool(server);
  registerInspectTool(server);
  registerLifecycleTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("hcom-mcp MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});