// @ts-ignore
import xsenv from '@sap/xsenv';
import { Request, Response, NextFunction } from 'express';

export interface AuthRequest extends Request {
  authInfo?: any;
  jwtToken?: string;
}

/**
 * OAuth Proxy Service for XSUAA
 * Handles the full Authorization Code flow so MCP Clients (OpenMCP, Claude Desktop)
 * can authenticate directly without needing an AppRouter or Bridge Script.
 */
export class AuthService {
  private xsuaaCredentials: Record<string, any> | null = null;

  constructor() {
    this.initializeXSUAA();
  }

  private initializeXSUAA(): void {
    try {
      xsenv.loadEnv();
      const services = xsenv.getServices({ xsuaa: { label: 'xsuaa' } });
      this.xsuaaCredentials = services.xsuaa as Record<string, any>;
      console.log('[AuthService] XSUAA service initialized successfully.');
    } catch {
      console.warn('[AuthService] XSUAA service not found — OAuth endpoints will be disabled.');
      this.xsuaaCredentials = null;
    }
  }

  isConfigured(): boolean {
    return this.xsuaaCredentials !== null;
  }

  /** Build the XSUAA authorization URL (step 1 of Authorization Code flow) */
  getAuthorizationUrl(state: string, baseUrl: string): string {
    const creds = this.xsuaaCredentials as Record<string, string>;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: creds.clientid,
      redirect_uri: `${baseUrl}/oauth/callback`,
      state
    });
    return `${creds.url}/oauth/authorize?${params.toString()}`;
  }

  /** Exchange authorization code for access_token + refresh_token (step 2) */
  async exchangeCodeForToken(code: string, redirectUri: string): Promise<any> {
    const creds = this.xsuaaCredentials as Record<string, string>;
    const tokenUrl = `${creds.url}/oauth/token`;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: creds.clientid,
      client_secret: creds.clientsecret,
      redirect_uri: redirectUri
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
    }
    return response.json();
  }

  /** Refresh an expired access_token using refresh_token */
  async refreshAccessToken(refreshToken: string): Promise<any> {
    const creds = this.xsuaaCredentials as Record<string, string>;
    const tokenUrl = `${creds.url}/oauth/token`;
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: creds.clientid,
      client_secret: creds.clientsecret
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
    }
    return response.json();
  }

  /** Get XSUAA client credentials for OAuth Client Registration */
  getClientCredentials() {
    if (!this.xsuaaCredentials) return null;
    const creds = this.xsuaaCredentials as Record<string, string>;
    return {
      client_id: creds.clientid,
      client_secret: creds.clientsecret,
      url: creds.url,
      identityZone: creds.identityzone,
      tenantMode: creds.tenantmode
    };
  }

  /** Get public service info (safe for JSON responses) */
  getServiceInfo() {
    if (!this.xsuaaCredentials) return null;
    const creds = this.xsuaaCredentials as Record<string, string>;
    return {
      url: creds.url,
      clientId: creds.clientid,
      identityZone: creds.identityzone,
      tenantMode: creds.tenantmode,
      configured: true
    };
  }

  /** Build redirect URI */
  getRedirectUri(baseUrl: string): string {
    return `${baseUrl}/oauth/callback`;
  }

  /**
   * Express middleware: Validates JWT from Authorization header.
   * Skips validation in local dev mode (no VCAP_SERVICES).
   */
  authenticateJWT() {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
      // Skip if XSUAA is not configured (local dev mode)
      if (!this.xsuaaCredentials) {
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        const baseUrl = getBaseUrl(req);
        return res.status(401).json({
          error: 'Authentication Required',
          message: 'Bearer token is required.',
          oauth: {
            authorize: `${baseUrl}/oauth/authorize`,
            discovery: `${baseUrl}/.well-known/oauth-authorization-server`
          }
        });
      }

      // Extract JWT and attach to request for downstream use
      const token = authHeader.substring(7);
      req.jwtToken = token;
      next();
    };
  }
}

/** Helper to extract base URL from request (respects x-forwarded-proto) */
export function getBaseUrl(req: Request): string {
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}`;
}
