import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { registerHealthTool } from "./health";

/** McpServer + Client를 InMemoryTransport로 연결한 테스트 픽스처를 생성합니다 */
async function createTestFixture() {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerHealthTool(server);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return { client, server };
}

describe("health tool", () => {
  it("tools/list에 health 도구가 포함되어 있어야 한다", async () => {
    const { client } = await createTestFixture();

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain("health");
  });

  it("health 도구의 description과 inputSchema가 올바르게 노출되어야 한다", async () => {
    const { client } = await createTestFixture();

    const { tools } = await client.listTools();
    const healthTool = tools.find((t) => t.name === "health");

    expect(healthTool).toBeDefined();
    expect(healthTool!.description).toBe("MCP 서버 상태를 확인합니다.");
    expect(healthTool!.inputSchema).toBeDefined();
  });

  it("기본 호출 시 status, timestamp, uptime, version을 반환해야 한다", async () => {
    const { client } = await createTestFixture();

    const result = await client.callTool({ name: "health", arguments: {} });
    const content = result.content as { type: string; text: string }[];
    const body = JSON.parse(content[0].text);

    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("uptime");
    expect(body).toHaveProperty("version", "1.0.0");
    expect(body).not.toHaveProperty("memory");
    expect(body).not.toHaveProperty("node");
  });

  it("detail=true 호출 시 memory, node, platform 정보를 추가로 반환해야 한다", async () => {
    const { client } = await createTestFixture();

    const result = await client.callTool({
      name: "health",
      arguments: { detail: true },
    });
    const content = result.content as { type: string; text: string }[];
    const body = JSON.parse(content[0].text);

    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("memory");
    expect(body).toHaveProperty("node", process.version);
    expect(body).toHaveProperty("platform", process.platform);
  });

  it("detail=false 호출 시 기본 응답과 동일해야 한다", async () => {
    const { client } = await createTestFixture();

    const basicResult = await client.callTool({ name: "health", arguments: {} });
    const detailResult = await client.callTool({
      name: "health",
      arguments: { detail: false },
    });

    const basicBody = JSON.parse(
      (basicResult.content as { type: string; text: string }[])[0].text,
    );
    const detailBody = JSON.parse(
      (detailResult.content as { type: string; text: string }[])[0].text,
    );

    expect(basicBody).not.toHaveProperty("memory");
    expect(detailBody).not.toHaveProperty("memory");
  });
});
