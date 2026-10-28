import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, type McpDeps } from '../mcp/server.js';

/** Serves the session's MCP tools on stdio; resolves when the client closes the connection. */
export async function runMcpCommand(deps: McpDeps): Promise<void> {
  const server = createMcpServer(deps);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  // the stdio transport does not notice the client going away; closing stdin ends the session
  process.stdin.once('end', () => void server.close());
  await server.connect(new StdioServerTransport());
  await closed;
}
