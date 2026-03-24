import { config } from 'dotenv';
import path from 'path';

// Load environment variables for local testing
config({ path: path.resolve(process.cwd(), '.env') });

import express, { Request, Response } from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcpServerFactory.js';
import { AuthService, AuthRequest, getBaseUrl } from './lib/authService.js';
import { AbapAdtServer } from './AbapAdtServer.js';

// Initialize OAuth Proxy Service
const authService = new AuthService();

const app = express();

// Enable CORS for all routes
app.use(cors({
  credentials: true,
  exposedHeaders: ['Mcp-Session-Id'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'MCP-Protocol-Version', 'Authorization', 'x-sap-destination-name']
}));

// JSON config
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper to extract JWT from Authorization header
function getUserJwt(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// OAuth Proxy State Management (in-memory, per-instance)
// ═══════════════════════════════════════════════════════════════════
const oauthStates = new Map<string, {
  mcpRedirectUri: string;
  state: string;
  timestamp: number;
}>();

// ═══════════════════════════════════════════════════════════════════
// Streamable HTTP Session Management  
// ═══════════════════════════════════════════════════════════════════
const httpSessions = new Map<string, {
  server: AbapAdtServer;
  transport: StreamableHTTPServerTransport;
  createdAt: Date;
  userToken?: string;
}>();

// Cleanup expired sessions (older than 24 hours)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of httpSessions.entries()) {
    if (now - session.createdAt.getTime() > 24 * 60 * 60 * 1000) {
      console.log(`[HTTP Sessions] Cleaning up expired session: ${id}`);
      session.transport.close();
      httpSessions.delete(id);
    }
  }
}, 60 * 60 * 1000); // Check every hour

// ═══════════════════════════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeHttpSessions: httpSessions.size,
    version: '1.0.0-streamable'
  });
});

// ═══════════════════════════════════════════════════════════════════
// 1. STREAMABLE HTTP ENDPOINTS (Modern — /mcp)
// ═══════════════════════════════════════════════════════════════════

/** POST /mcp — Main MCP endpoint for Streamable HTTP */
app.post('/mcp', authService.authenticateJWT() as express.RequestHandler, async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && httpSessions.has(sessionId)) {
      // Reuse existing session
      const session = httpSessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      const newSessionId = randomUUID();
      const userJwt = authReq.jwtToken || getUserJwt(req) || undefined;
      const destName = req.headers['x-sap-destination-name'] as string | undefined;

      const server = await createMcpServer(userJwt, destName);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        enableDnsRebindingProtection: false
      });

      await server.connect(transport);
      httpSessions.set(newSessionId, {
        server,
        transport,
        createdAt: new Date(),
        userToken: userJwt
      });

      // Cleanup on transport close
      transport.onclose = async () => {
        httpSessions.delete(newSessionId);
        await server.closeSession();
        console.log(`[Streamable HTTP] Session ${newSessionId} closed and ABAP session destroyed.`);
      };

      console.log(`[Streamable HTTP] New session created: ${newSessionId}`);
      await transport.handleRequest(req, res, req.body);

    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID or not an initialize request' },
        id: req.body?.id || null
      });
    }
  } catch (error: any) {
    console.error('[Streamable HTTP POST Error]', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: error.message },
        id: req.body?.id || null
      });
    }
  }
});

/** GET /mcp — Server-to-client notifications */
app.get('/mcp', authService.authenticateJWT() as express.RequestHandler, async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // If no session ID or no accept header, return server info
  if (!sessionId || !httpSessions.has(sessionId)) {
    const baseUrl = getBaseUrl(req);
    return res.json({
      name: 'abap-mcp-server',
      version: '1.0.0-streamable',
      transport: 'streamable-http',
      endpoints: { mcp: '/mcp', health: '/health' },
      authentication: authService.isConfigured() ? {
        type: 'OAuth 2.0 / XSUAA',
        authorize: `${baseUrl}/oauth/authorize`,
        discovery: `${baseUrl}/.well-known/oauth-authorization-server`
      } : { type: 'none (local dev mode)' }
    });
  }

  const session = httpSessions.get(sessionId)!;
  await session.transport.handleRequest(req, res);
});

/** DELETE /mcp — Session termination */
app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !httpSessions.has(sessionId)) {
    return res.status(400).json({ error: 'Invalid or missing session ID' });
  }

  const session = httpSessions.get(sessionId)!;
  await session.transport.handleRequest(req, res);
  httpSessions.delete(sessionId);
  await session.server.closeSession();
  console.log(`[Streamable HTTP] Session terminated: ${sessionId}`);
});

// ═══════════════════════════════════════════════════════════════════
// 2. OAUTH PROXY ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

/** RFC 8414 — OAuth Authorization Server Metadata Discovery */
app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (req, res) => {
  if (!authService.isConfigured()) {
    return res.status(501).json({ error: 'OAuth not configured', message: 'XSUAA service is not bound.' });
  }
  const baseUrl = getBaseUrl(req);
  const serviceInfo = authService.getServiceInfo()!;
  res.json({
    issuer: serviceInfo.url,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: `${baseUrl}/health`
  });
});

/** OAuth Client Registration (RFC 7591) */
app.post('/oauth/register', (req, res) => {
  if (!authService.isConfigured()) {
    return res.status(501).json({ error: 'OAuth not configured' });
  }
  const creds = authService.getClientCredentials()!;
  const baseUrl = getBaseUrl(req);
  res.json({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_secret_expires_at: 0,
    redirect_uris: [`${baseUrl}/oauth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic'
  });
});

/** GET /oauth/register — Discovery metadata for static client */
app.get('/oauth/register', (req, res) => {
  if (!authService.isConfigured()) {
    return res.status(501).json({ error: 'OAuth not configured' });
  }
  const baseUrl = getBaseUrl(req);
  res.json({
    registration_endpoint: `${baseUrl}/oauth/register`,
    client_registration_types_supported: ['static'],
    static_client_available: true
  });
});

/** Step 1: Start OAuth Authorization Code flow */
app.get('/oauth/authorize', (req, res) => {
  if (!authService.isConfigured()) {
    return res.status(501).json({ error: 'OAuth not configured' });
  }

  const state = req.query.state as string || randomUUID();
  const baseUrl = getBaseUrl(req);
  const mcpRedirectUri = req.query.redirect_uri as string || ''; // Empty string means manual HTML flow

  // Store the MCP Client's redirect URI (or empty for manual flow)
  oauthStates.set(state, { mcpRedirectUri, state, timestamp: Date.now() });

  // Cleanup states older than 10 minutes
  for (const [key, value] of oauthStates.entries()) {
    if (Date.now() - value.timestamp > 600000) oauthStates.delete(key);
  }

  const authUrl = authService.getAuthorizationUrl(state, baseUrl);
  console.log(`[OAuth] Redirecting to XSUAA: ${authUrl}`);
  res.redirect(authUrl);
});

/** Step 2: XSUAA callback — Receives authorization code and redirects back to MCP Client */
app.get('/oauth/callback', async (req, res) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;

    if (error) {
      const errorMsg = req.query.error_description as string || error;
      return res.status(400).send(`<html><body style="font-family:sans-serif;text-align:center;padding:2rem;">
        <h1>❌ Authentication Failed</h1><p>${errorMsg}</p>
        <a href="/oauth/authorize" style="padding:.5rem 1rem;background:#007bff;color:white;text-decoration:none;border-radius:4px;">Try Again</a>
      </body></html>`);
    }

    if (!code) {
      return res.status(400).send(`<html><body style="font-family:sans-serif;text-align:center;padding:2rem;">
        <h1>❌ Error</h1><p>Authorization code not provided.</p>
      </body></html>`);
    }

    // Look up the MCP Client's redirect URI from the state
    const mcpInfo = state && oauthStates.get(state);
    if (!mcpInfo) {
      return res.status(400).send(`<html><body style="font-family:sans-serif;text-align:center;padding:2rem;">
        <h1>❌ Error</h1><p>OAuth state not found or expired. Please try again.</p>
      </body></html>`);
    }
    
    oauthStates.delete(state);

    if (!mcpInfo.mcpRedirectUri) {
      // MANUAL OOB FLOW: No redirect URI was provided, so we exchange the token here and show it on-screen
      const baseUrl = getBaseUrl(req);
      const tokenData = await authService.exchangeCodeForToken(code, authService.getRedirectUri(baseUrl));
      
      return res.send(`<html>
        <body style="font-family:sans-serif;text-align:center;padding:2rem;background:#f4f4f5;color:#333;">
          <h1 style="color:#10b981;">✅ Authentication Successful</h1>
          <p style="font-size:1.1rem;margin-bottom:1rem;">Please copy the Access Token below and configure your MCP Client:</p>
          <textarea readonly style="width:100%;max-width:800px;height:250px;padding:15px;border-radius:8px;border:1px solid #ccc;font-family:monospace;font-size:14px;">${tokenData.access_token}</textarea>
        </body>
      </html>`);
    }

    // AUTOMATED FLOW: Redirect the authorization code back to the MCP Client
    const callbackUrl = new URL(mcpInfo.mcpRedirectUri);
    const params = new URLSearchParams({ code, state });
    console.log(`[OAuth] Redirecting code back to MCP Client: ${callbackUrl.toString()}`);
    res.redirect(`${callbackUrl.toString()}?${params}`);

  } catch (error: any) {
    console.error('[OAuth Callback Error]', error);
    res.status(500).send(`<html><body style="font-family:sans-serif;text-align:center;padding:2rem;">
      <h1>❌ Error</h1><p>${error.message}</p>
    </body></html>`);
  }
});

/** Step 3: Token exchange — MCP Client exchanges code for access_token */
const tokenHandler = async (req: Request, res: Response) => {
  try {
    if (!authService.isConfigured()) {
      return res.status(501).json({ error: 'oauth_not_configured' });
    }

    const grantType = req.body?.grant_type;
    const baseUrl = getBaseUrl(req);
    let tokenData;

    if (grantType === 'authorization_code' || req.body?.code) {
      const code = req.body.code;
      if (!code) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code' });
      tokenData = await authService.exchangeCodeForToken(code, authService.getRedirectUri(baseUrl));
    } else if (grantType === 'refresh_token' || req.body?.refresh_token) {
      const refreshToken = req.body.refresh_token;
      if (!refreshToken) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token' });
      tokenData = await authService.refreshAccessToken(refreshToken);
    } else {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }

    console.log(`[OAuth] Token exchange successful — grant_type: ${grantType}`);
    res.json(tokenData);
  } catch (error: any) {
    console.error('[OAuth Token Error]', error);
    res.status(400).json({ error: 'invalid_grant', error_description: error.message });
  }
};
app.get('/oauth/token', tokenHandler);
app.post('/oauth/token', tokenHandler);

// ═══════════════════════════════════════════════════════════════════
// 3. LEGACY TOKEN DEBUG ENDPOINT
// ═══════════════════════════════════════════════════════════════════
app.get('/api/token', (req: Request, res: Response) => {
  const token = getUserJwt(req);
  res.json(token
    ? { authenticated: true, token: `Bearer ${token}` }
    : { authenticated: false, message: "No JWT found in request." }
  );
});

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ABAP MCP API Express Server (Streamable HTTP) running on port ${PORT}`);
  console.log(`  Streamable HTTP: POST/GET/DELETE /mcp`);
  console.log(`  OAuth Authorize:  GET /oauth/authorize`);
  console.log(`  OAuth Discovery:  GET /.well-known/oauth-authorization-server`);
  console.log(`  Health Check:     GET /health`);
});
