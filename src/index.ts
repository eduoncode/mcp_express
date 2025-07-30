import express from "express";
import { randomUUID } from "node:crypto";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import z from "zod";

const app = express();
app.use(express.json());

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

// Handle POST requests for client-to-server communication
app.post("/mcp", async (req, res) => {
  console.error("Request body:", req.body);
  console.error("isInitializeRequest:", isInitializeRequest(req.body));
  // Check for existing session ID
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  console.error("Received request with session ID:", sessionId);
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    // Reuse existing transport
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New initialization request
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        // Store the transport by session ID
        transports[sessionId] = transport;
      },
      // DNS rebinding protection is disabled by default for backwards compatibility. If you are running this server
      // locally, make sure to set:
      // enableDnsRebindingProtection: true,
      // allowedHosts: ['127.0.0.1'],
    });

    // Clean up transport when closed
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
      }
    };
    const server = new McpServer({
      name: "example-server",
      version: "1.0.0",
    });

    server.registerResource(
      "echo",
      new ResourceTemplate("echo://{message}", { list: undefined }),
      {
        title: "Echo Resource",
        description: "Echoes back messages as resources",
      },
      async (uri, { message }) => ({
        contents: [
          {
            uri: uri.href,
            text: `Resource echo: ${message}`,
          },
        ],
      })
    );

    server.registerTool(
      "echo",
      {
        title: "Echo Tool",
        description: "Echoes back the provided message",
        inputSchema: { message: z.string() },
      },
      async ({ message }) => ({
        content: [{ type: "text", text: `Tool echo: ${message}` }],
      })
    );

    server.registerPrompt(
      "echo",
      {
        title: "Echo Prompt",
        description: "Creates a prompt to process a message",
        argsSchema: { message: z.string() },
      },
      ({ message }) => ({
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Please process this message: ${message}`,
            },
          },
        ],
      })
    );

    // ... set up server resources, tools, and prompts ...

    // Connect to the MCP server
    await server.connect(transport);
    // Após conectar, envie o sessionId no header da resposta
    if (transport.sessionId) {
      res.setHeader("mcp-session-id", transport.sessionId);
    }
  } else {
    // Invalid request
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
    return;
  }

  // Handle the request
  await transport.handleRequest(req, res, req.body);
});

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (
  req: express.Request,
  res: express.Response
) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

// Handle GET requests for server-to-client notifications via SSE
app.get("/mcp", handleSessionRequest);

// Handle DELETE requests for session termination
app.delete("/mcp", handleSessionRequest);

app.listen(3000, () => {
  console.error("Server is running on http://localhost:3000");
});
