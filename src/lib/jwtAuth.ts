import passport from 'passport';
// @ts-ignore
import { XssecPassportStrategy, XsuaaService } from '@sap/xssec';
// @ts-ignore
import xsenv from '@sap/xsenv';
import { Request, Response, NextFunction } from 'express';

// Initialize Passport with JWTStrategy
export function initJwtStrategy() {
  try {
    const services = xsenv.getServices({ uaa: { tag: 'xsuaa' } });
    passport.use('JWT', new XssecPassportStrategy(new XsuaaService(services.uaa)));
    console.log('[JWT Auth] Passport JWT Strategy initialized successfully.');
  } catch (error: any) {
    console.warn('[JWT Auth] XSUAA service not found or initialization failed. Local mode fallback will be used.');
    console.warn('[JWT Auth] Error details:', error.message);
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
  
  // Proceed with JWT validation using a custom callback for better error reporting
  passport.authenticate('JWT', { session: false }, (err: any, user: any, info: any) => {
    if (err) {
      console.error('[JWT Auth] Passport error:', err);
      return res.status(500).json({ error: 'Authentication internal error', details: err.message });
    }
    if (!user) {
      console.warn('[JWT Auth] Authentication failed:', info?.message || 'No user found');
      return res.status(401).json({ 
        error: 'Unauthorized', 
        message: info?.message || 'Valid JWT token required',
        hint: 'Ensure you are sending a Bearer token in the Authorization header or accessing via AppRouter.'
      });
    }
    // Success - attach user and authInfo to request
    (req as any).user = user;
    (req as any).authInfo = info; // xssec puts token info here
    next();
  })(req, res, next);
}
