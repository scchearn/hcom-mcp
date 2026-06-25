#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerLaunchTool, registerTopologyLaunchTool } from "./tools/launch.js";
import {
  registerConfigPathsTool,
  registerListAllTool,
  registerListManagedTool,
  registerListPresetsTool,
  registerListTopologiesTool,
  registerStatusTool,
} from "./tools/list.js";
import { registerListModelsTool, registerModelResources } from "./tools/models.js";
import { registerInspectTool } from "./tools/inspect.js";
import { registerPruneTool } from "./tools/prune.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerThreadSeedTool, registerThreadInspectTool } from "./tools/threads.js";
import { registerAdoptTool } from "./tools/adopt.js";
import { isHcomAvailable } from "./hcom.js";

const PORT = parseInt(process.env.HCOM_MCP_PORT ?? "3111", 10);

function createHcomMcpServer(): McpServer {
  const s = new McpServer({ name: "hcom-mcp", version: "0.1.0" });
  registerLaunchTool(s);
  registerTopologyLaunchTool(s);
  registerListManagedTool(s);
  registerListAllTool(s);
  registerListModelsTool(s);
  registerModelResources(s);
  registerListPresetsTool(s);
  registerListTopologiesTool(s);
  registerConfigPathsTool(s);
  registerStatusTool(s);
  registerInspectTool(s);
  registerPruneTool(s);
  registerLifecycleTools(s);
  registerThreadSeedTool(s);
  registerThreadInspectTool(s);
  registerAdoptTool(s);
  return s;
}

function isLocalhostHost(hostHeader: string): boolean {
  const colonIdx = hostHeader.lastIndexOf(":");
  const hostname = colonIdx > 0 ? hostHeader.slice(0, colonIdx) : hostHeader;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

async function main() {
  const available = await isHcomAvailable();
  if (!available) {
    console.error("ERROR: hcom CLI not found on PATH. Install it first: https://github.com/aannoo/hcom");
    process.exit(1);
  }
  console.error("hcom CLI found, starting MCP server...");

  const httpServer = createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    if (!isLocalhostHost(host)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    const server = createHcomMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      transport.close().catch(() => {});
      server.close().catch(() => {});
    };

    res.on("close", cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP request error:", err);
      cleanup();
    }
  });

  httpServer.listen(PORT, "127.0.0.1", () => {
    console.error(`hcom-mcp HTTP server listening on http://127.0.0.1:${PORT}/mcp`);
  });

  const shutdown = () => {
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
