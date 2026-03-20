const xssec = require('@sap/xssec');
console.log('xssec exports:', Object.keys(xssec));
if (xssec.JWTStrategy) console.log('JWTStrategy found');
if (xssec.XssecPassportStrategy) console.log('XssecPassportStrategy found');
if (xssec.XsuaaService) console.log('XsuaaService found');
