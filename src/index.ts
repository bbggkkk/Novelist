// MCP Server Entry Point
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { registerHealthTool } from "./tools/health";

const server = new McpServer({
  name: "novelist-mcp-server",
  version: "1.0.0",
});

// Register tools
registerHealthTool(server);

// Start server (top-level await requires ESM + "type": "module")
const transport = new StdioServerTransport();
await server.connect(transport);