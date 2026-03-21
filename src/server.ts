import { config } from 'dotenv';
import path from 'path';

// Load environment variables for local testing
config({ path: path.resolve(process.cwd(), '.env') });

import express, { Request, Response } from 'express';
import cors from 'cors';
import passport from 'passport';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpServer } from './mcpServerFactory.js';
import { initJwtStrategy, jwtAuthMiddleware, getUserJwt } from './lib/jwtAuth.js';

// Initialize Passport strategy for BTP XSUAA
initJwtStrategy();

const app = express();

// Enable CORS for all routes (necessary for AppRouter and MCP clients)
app.use(cors());
app.use(express.json());
app.use(passport.initialize());

// Store active SSE transports by sessionId
const transports = new Map<string, SSEServerTransport>();

// Token debugging endpoints - Public so user can see if any token reaches the backend
app.get('/api/token', (req: Request, res: Response) => {
  const token = getUserJwt(req);
  if (token) {
    res.json({ 
      authenticated: true,
      token: `Bearer ${token}`,
      message: "Token received successfully."
    });
  } else {
    res.json({ 
      authenticated: false,
      message: "No JWT found in request. If you are accessing this URL directly in a browser, this is expected unless you are behind an AppRouter."
    });
  }
});

// 1. Client connects to /mcp/sse to establish the Server-Sent Events stream
app.get('/mcp/sse', jwtAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const userJwt = getUserJwt(req) || undefined;
    const destName = req.headers['x-sap-destination-name'] as string | undefined;

    // Send headers immediately to prevent AppRouter 504 Timeout
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx/AppRouter buffering
    res.flushHeaders();

    // Create SSE transport. The endpoint string is where clients will POST their messages
    // The SDK appends ?sessionId=... to this endpoint
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
  if (!sessionId) {
    return res.status(400).send("Missing sessionId parameter");
  }

  const transport = transports.get(sessionId);
  if (transport) {
    try {
      await transport.handlePostMessage(req, res);
    } catch (error: any) {
      console.error("[POST MESSAGE ERROR]", error);
      res.status(500).send(error.message);
    }
  } else {
    console.warn(`[POST MESSAGE] Session not found: ${sessionId}`);
    console.warn(`[POST MESSAGE] Active sessions: ${Array.from(transports.keys()).join(', ')}`);
    res.status(404).send("Session not found");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`MCP ABAP ADT API Express Server running on port ${PORT}`);
  console.log(`SSE Endpoint: http://localhost:${PORT}/mcp/sse`);
});
