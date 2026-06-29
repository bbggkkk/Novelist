import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";

export function registerHealthTool(server: McpServer) {
  server.registerTool(
    "health",
    {
      description: "MCP 서버 상태를 확인합니다.",
      inputSchema: {
        workspace: z.string().describe("작업중인 프로젝트 폴더"),
        detail: z.boolean().optional().describe("상세 정보 포함 여부"),
      },
    },
    async ({ detail, workspace }) => {
      const base = {
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: "1.0.0",
      };

      if (detail) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...base, memory: process.memoryUsage(), node: process.version, platform: process.platform, data: { workspace } },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(base, null, 2) }],
      };
    }
  );
}
