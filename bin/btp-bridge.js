import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import EventSource from 'eventsource';

const BTP_URL = process.env.BTP_URL || 'https://robert-bosch-gmbh-rb-btphub-taf-d-bt222d00-mcp-approuter.cfapps.eu10-004.hana.ondemand.com';
const JWT_TOKEN = process.env.JWT_TOKEN;
const DESTINATION = process.env.SAP_DESTINATION_NAME || 'T4X_011';
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

if (!JWT_TOKEN) {
  process.stderr.write("Missing JWT_TOKEN environment variable.\n");
  process.exit(1);
}

// Setup Proxy Agent if behind Corporate Firewall
const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;
const headers = {
  'Authorization': `Bearer ${JWT_TOKEN}`,
  'x-sap-destination-name': DESTINATION
};

// 1. Establish SSE Connection (acting as MCP Client to BTP)
const sseUrl = `${BTP_URL}/mcp/sse`;
const eventSource = new EventSource(sseUrl, {
  https: { agent },
  headers
});

let messageEndpoint = null;

// Function to correctly format JSON-RPC messages for MCP STDIO Transport
function sendToClient(messageStr) {
  const buf = Buffer.from(messageStr, 'utf-8');
  process.stdout.write(`Content-Length: ${buf.length}\r\n\r\n${messageStr}`);
}

eventSource.on('endpoint', (e) => {
  messageEndpoint = e.data.startsWith('http') ? e.data : `${BTP_URL}${e.data}`;
  process.stderr.write(`[Bridge] Connected to SSE. Forward endpoint: ${messageEndpoint}\n`);
});

eventSource.on('message', (e) => {
  // Pass BTP Server's response back to standard output (Claude/Cursor/Inspector)
  sendToClient(e.data); 
});

eventSource.onerror = (err) => {
  process.stderr.write(`[Bridge] SSE Error: ${err.message || 'Connection Lost'}\n`);
};

// 2. Listen to STDIO (acting as MCP Server for local Claude/Cursor/Inspector)
let buffer = Buffer.alloc(0);

process.stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  
  // Parse Content-Length headers as required by MCP Protocol
  while (true) {
    const match = buffer.toString('utf-8').match(/^Content-Length: (\d+)\r\n\r\n/);
    if (!match) break;
    
    const headerLen = match[0].length;
    const bodyLen = parseInt(match[1], 10);
    
    if (buffer.length < headerLen + bodyLen) break; // Incomplete message
    
    const bodyStr = buffer.subarray(headerLen, headerLen + bodyLen).toString('utf-8');
    buffer = buffer.subarray(headerLen + bodyLen); // Shift buffer
    
    if (messageEndpoint) {
      try {
        // Forward local JSON-RPC request to BTP Server
        await fetch(messageEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers
          },
          body: bodyStr,
          agent
        });
      } catch (err) {
        process.stderr.write(`[Bridge] Error forwarding message: ${err.message}\n`);
      }
    } else {
      process.stderr.write(`[Bridge] Warning: Tried to send message before SSE endpoint was ready.\n`);
    }
  }
});
