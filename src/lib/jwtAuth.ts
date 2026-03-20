import passport from 'passport';
// @ts-ignore
import { JWTStrategy } from '@sap/xssec';
// @ts-ignore
import xsenv from '@sap/xsenv';
import { Request, Response, NextFunction } from 'express';

// Initialize Passport with JWTStrategy
export function initJwtStrategy() {
  try {
    const services = xsenv.getServices({ uaa: { tag: 'xsuaa' } });
    passport.use(new JWTStrategy(services.uaa));
    // Passport configuration for Express occurs in server.ts
  } catch (error) {
    console.warn('[JWT Auth] XSUAA service not found in VCAP_SERVICES. Local mode fallback will be used.');
  }
}

// Extract JWT from request either via Authorization Header or Passport's authInfo
export function getUserJwt(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const jwtFromHeader = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.substring(7) 
    : null;
    
  // req.authInfo is populated by passport-xssec
  const authInfo = (req as any).authInfo;
  const jwtFromAuthInfo = authInfo && typeof authInfo.getToken === 'function'
    ? authInfo.getToken() 
    : null;
    
  return jwtFromHeader || jwtFromAuthInfo || null;
}

// Middleware that wraps passport.authenticate
// Bypasses validation if VCAP_SERVICES is missing (local dev)
export function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!process.env.VCAP_SERVICES && process.env.SAP_USER && process.env.SAP_PASSWORD) {
    // Local mode: No JWT validation required if using .env
    return next();
  }
  
  // Proceed with JWT validation
  passport.authenticate('JWT', { session: false })(req, res, next);
}
