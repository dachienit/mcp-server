#!/usr/bin/env node

// BTP Bridge Script — Zero external dependencies, Node 22+ only
// Bridges local STDIO ↔ Remote BTP SSE, injecting JWT automatically.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BTP_URL = process.env.BTP_URL || 'https://robert-bosch-gmbh-rb-btphub-taf-d-bt222d00-mcp-approuter.cfapps.eu10-004.hana.ondemand.com';
// Support JWT from: 1) env var, 2) command line argument
const JWT_TOKEN = process.env.JWT_TOKEN || process.argv[2];
const DESTINATION = process.env.SAP_DESTINATION_NAME || 'T4X_011';

if (!JWT_TOKEN) {
  process.stderr.write('[Bridge] ERROR: Missing JWT_TOKEN environment variable.\n');
  process.exit(1);
}

const commonHeaders = {
  'Authorization': `Bearer ${JWT_TOKEN}`,
  'x-sap-destination-name': DESTINATION
};

let messageEndpoint = null;

// ─── 1. Connect to SSE (GET /mcp/sse) using raw https module ───
function connectSSE() {
  const sseUrl = new URL(`${BTP_URL}/mcp/sse`);
  const options = {
    hostname: sseUrl.hostname,
    port: sseUrl.port || 443,
    path: sseUrl.pathname,
    method: 'GET',
    headers: {
      ...commonHeaders,
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache'
    }
  };

  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      process.stderr.write(`[Bridge] SSE connection failed with status ${res.statusCode}\n`);
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        process.stderr.write(`[Bridge] Response: ${body.substring(0, 300)}\n`);
        process.exit(1);
      });
      return;
    }

    process.stderr.write('[Bridge] SSE connection established.\n');

    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          currentData = line.substring(5).trim();
        } else if (line.trim() === '') {
          // Empty line = end of SSE message
          if (currentEvent === 'endpoint') {
            messageEndpoint = currentData.startsWith('http')
              ? currentData
              : `${BTP_URL}${currentData}`;
            process.stderr.write(`[Bridge] Got message endpoint: ${messageEndpoint}\n`);
          } else if (currentEvent === 'message' || (!currentEvent && currentData)) {
            // Forward server response to STDIO client
            const buf = Buffer.from(currentData, 'utf-8');
            process.stdout.write(currentData + '\n');
          }
          currentEvent = '';
          currentData = '';
        }
      }
    });

    res.on('end', () => {
      process.stderr.write('[Bridge] SSE connection closed by server.\n');
      process.exit(0);
    });

    res.on('error', (err) => {
      process.stderr.write(`[Bridge] SSE stream error: ${err.message}\n`);
      process.exit(1);
    });
  });

  req.on('error', (err) => {
    process.stderr.write(`[Bridge] SSE connection error: ${err.message}\n`);
    process.exit(1);
  });

  req.end();
}

// ─── 2. Forward STDIO input to BTP (POST /mcp/messages) ───
function postMessage(bodyStr) {
  if (!messageEndpoint) {
    process.stderr.write('[Bridge] Warning: SSE endpoint not ready yet, queuing...\n');
    setTimeout(() => postMessage(bodyStr), 500);
    return;
  }

  const postUrl = new URL(messageEndpoint);
  const postData = Buffer.from(bodyStr, 'utf-8');

  const options = {
    hostname: postUrl.hostname,
    port: postUrl.port || 443,
    path: postUrl.pathname + postUrl.search,
    method: 'POST',
    headers: {
      ...commonHeaders,
      'Content-Type': 'application/json',
      'Content-Length': postData.length
    }
  };

  const req = https.request(options, (res) => {
    // We expect 202 Accepted; responses come via SSE stream
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200 && res.statusCode !== 202) {
        process.stderr.write(`[Bridge] POST response ${res.statusCode}: ${body.substring(0, 200)}\n`);
      }
    });
  });

  req.on('error', (err) => {
    process.stderr.write(`[Bridge] POST error: ${err.message}\n`);
  });

  req.write(postData);
  req.end();
}

// ─── 3. Listen on STDIN for JSON-RPC messages from MCP Client ───
let stdinBuffer = '';

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;

  // Try to parse complete JSON objects separated by newlines
  let newlineIdx;
  while ((newlineIdx = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.substring(0, newlineIdx).trim();
    stdinBuffer = stdinBuffer.substring(newlineIdx + 1);

    if (line.length > 0) {
      try {
        JSON.parse(line); // Validate it's valid JSON
        postMessage(line);
      } catch (e) {
        // Not JSON, might be Content-Length header from STDIO protocol, skip
      }
    }
  }
});

process.stdin.on('end', () => {
  process.stderr.write('[Bridge] STDIN closed.\n');
  process.exit(0);
});

// ─── Start ───
process.stderr.write('[Bridge] Starting BTP MCP Bridge (Zero-dependency mode)...\n');
connectSSE();
