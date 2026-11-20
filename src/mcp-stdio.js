#!/usr/bin/env node
/**
 * VTN Anti-Browser Stdio MCP Bridge (`src/mcp-stdio.js`)
 * Lightweight zero-dependency stdio-to-Streamable-HTTP bridge for MCP clients
 * (Antigravity 2.0, Claude Desktop, Cursor) that prefer local `command`/`args` transport.
 *
 * Forwards newline-delimited JSON-RPC 2.0 messages from stdin to the running
 * VTN Anti-Browser MCP endpoint (`http://127.0.0.1:45678/mcp`) and writes responses to stdout.
 */

const readline = require('readline');

const MCP_URL = process.env.VTN_MCP_URL || `http://${process.env.VTN_HOST || '127.0.0.1'}:${process.env.VTN_PORT || 45678}/mcp`;
let sessionId = null;
let inFlight = 0;
let stdinClosed = false;

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

function writeStdout(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function maybeExit() {
  if (stdinClosed && inFlight === 0) {
    process.exit(0);
  }
}

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    writeStdout({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${err.message}` }
    });
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  };
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  inFlight += 1;
  try {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(60000)
    });

    const returnedSid = res.headers.get('mcp-session-id');
    if (returnedSid) sessionId = returnedSid;

    if (res.status === 202) {
      // Notification accepted; no JSON-RPC response required
      return;
    }

    const text = await res.text();
    let parsed = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    const isValidJsonRpc =
      parsed &&
      typeof parsed === 'object' &&
      (parsed.jsonrpc === '2.0' ||
        (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => item && item.jsonrpc === '2.0')));

    if (!res.ok || !isValidJsonRpc) {
      if (msg.id !== undefined) {
        const detail =
          (parsed && typeof parsed === 'object' && (parsed.error?.message || (typeof parsed.error === 'string' ? parsed.error : null))) ||
          text.trim().slice(0, 300) ||
          `HTTP ${res.status} ${res.statusText || ''}`.trim();
        writeStdout({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32000,
            message: `MCP HTTP error (${res.status}): ${detail}`
          }
        });
      } else {
        process.stderr.write(`[vtn-mcp-stdio] MCP HTTP error (${res.status}): ${text.trim().slice(0, 300)}\n`);
      }
      return;
    }

    writeStdout(parsed);
  } catch (err) {
    if (msg.id !== undefined) {
      writeStdout({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32000,
          message: `Cannot reach VTN Anti-Browser MCP Server at ${MCP_URL}. Please make sure VTN Anti-Browser is running (npm start / Start-VTN-Anti-Browser.bat). Detail: ${err.message}`
        }
      });
    } else {
      process.stderr.write(`[vtn-mcp-stdio] Forward error: ${err.message}\n`);
    }
  } finally {
    inFlight -= 1;
    maybeExit();
  }
});

rl.on('close', () => {
  stdinClosed = true;
  maybeExit();
});
