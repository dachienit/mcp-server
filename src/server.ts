import { config } from 'dotenv';
import path from 'path';

// Load environment variables for local testing
config({ path: path.resolve(process.cwd(), '.env') });

import express, { Request, Response } from 'express';
import passport from 'passport';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpServer } from './mcpServerFactory.js';
import { initJwtStrategy, jwtAuthMiddleware, getUserJwt } from './lib/jwtAuth.js';

// Initialize Passport strategy for BTP XSUAA
initJwtStrategy();

const app = express();
app.use(express.json());
app.use(passport.initialize());

// Store active SSE transports by sessionId
const transports = new Map<string, SSEServerTransport>();

// Token debugging endpoints
app.get('/api/token', jwtAuthMiddleware, (req: Request, res: Response) => {
  const token = getUserJwt(req);
  if (token) {
    res.json({ token: `Bearer ${token}` });
  } else {
    res.status(401).json({ error: 'No JWT found' });
  }
});

// 1. Client connects to /mcp/sse to establish the Server-Sent Events stream
app.get('/mcp/sse', jwtAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userJwt = getUserJwt(req) || undefined;
    const destName = req.headers['x-sap-destination-name'] as string | undefined;

    // Create SSE transport. The endpoint string is where clients will POST their messages
    const transport = new SSEServerTransport("/mcp/messages", res);
    
    // Create new MCP Server instance using the Factory
    // This connects to the correct ADT on-prem backend based on parameters
    const server = await createMcpServer(userJwt, destName);
    await server.connect(transport);
    
    transports.set(transport.sessionId, transport);

    // Cleanup session when connection closes
    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };
  } catch (error: any) {
    console.error("[SSE ERROR]", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// 2. Client posts JSON-RPC messages to /mcp/messages?sessionId=<session-id>
app.post('/mcp/messages', jwtAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports.get(sessionId);
  if (transport) {
    try {
      await transport.handlePostMessage(req, res);
    } catch (error: any) {
      console.error("[POST MESSAGE ERROR]", error);
      res.status(500).send(error.message);
    }
  } else {
    res.status(404).send("Session not found");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`MCP ABAP ADT API Express Server running on port ${PORT}`);
  console.log(`SSE Endpoint: http://localhost:${PORT}/mcp/sse`);
});
