import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { dataPath, type Config } from './config.js';
import { address, errorInfo, id, limits, object, onlyKeys, PostError, type RecordValue } from './contract.js';
import { acquireLock, initialize, writeConnection } from './data.js';
import { Store } from './store.js';

async function jsonBody(request: IncomingMessage): Promise<RecordValue> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new PostError('CONTENT_TYPE', 'Content-Type must be application/json', 415);
  }
  let size = 0;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      request.off('data', data);
      request.off('end', end);
      request.off('error', failed);
      request.off('aborted', aborted);
    };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => failed(new PostError('INVALID_INPUT', 'Request body was interrupted'));
    const end = () => { cleanup(); resolve(); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.json) {
        cleanup();
        request.resume();
        reject(new PostError('PAYLOAD_TOO_LARGE', `JSON exceeds ${limits.json} bytes`, 413));
      } else chunks.push(chunk);
    };
    request.on('data', data);
    request.once('end', end);
    request.once('error', failed);
    request.once('aborted', aborted);
  });
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return object(JSON.parse(decoded));
  } catch (error) {
    if (error instanceof PostError) throw error;
    throw new PostError('INVALID_JSON', 'Body must be a UTF-8 JSON object');
  }
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body) + '\n');
}

export interface RunningServer {
  server: Server;
  config: Config;
  close(): Promise<void>;
}

export async function startServer(options: { dataDir: string; port?: number }): Promise<RunningServer> {
  const port = options.port ?? 43127;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PostError('INVALID_INPUT', 'port must be 0..65535');
  const dataDir = dataPath(options.dataDir);
  const connection = initialize(dataDir);
  const release = acquireLock(dataDir);
  let store: Store;
  try { store = new Store(dataDir); }
  catch (error) { release(); throw error; }
  const config: Config = { dataDir, baseUrl: '', token: connection.token, timeout: 10000 };
  const log = (event: string, detail: RecordValue = {}) => {
    appendFileSync(join(dataDir, 'server.jsonl'), JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n', { mode: 0o600 });
  };
  const hosts = new Set<string>();
  const token = Buffer.from(config.token);
  const server = createServer(async (request, response) => {
    try {
      if (!request.headers.host || !hosts.has(request.headers.host.toLowerCase())) throw new PostError('INVALID_HOST', 'Host is not allowed', 403);
      if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new PostError('ORIGIN_FORBIDDEN', 'Browser-origin requests are not supported', 403);
      }
      const authorization = request.headers.authorization;
      const supplied = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
      if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) throw new PostError('UNAUTHORIZED', 'Valid local token required', 401);
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new PostError('INVALID_INPUT', 'Invalid request target');
      const target = new URL(request.url, config.baseUrl);
      let parts: string[];
      try { parts = target.pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part)); }
      catch { throw new PostError('INVALID_INPUT', 'Invalid URL encoding'); }
      const method = request.method;
      let result: unknown;
      let status = 200;
      if (method === 'GET' && target.pathname === '/v1/health') {
        onlyQuery(target, []);
        store.db.prepare('SELECT 1').get();
        result = { healthy: true, schema_version: 2 };
      } else if (target.pathname === '/v1/contacts' && method === 'GET') {
        result = store.directory(target.searchParams);
      } else if (target.pathname === '/v1/contacts' && method === 'PUT') {
        onlyQuery(target, []);
        result = store.register(await jsonBody(request));
      } else if (parts[0] === 'v1' && parts[1] === 'messages') {
        const actor = address(request.headers['x-agent-address'], 'X-Agent-Address');
        if (parts.length === 2 && method === 'GET') result = store.list(actor, target.searchParams);
        else if (parts.length === 2 && method === 'POST') {
          onlyQuery(target, []);
          result = store.send(actor, await jsonBody(request));
          status = 201;
        } else if (parts.length === 3 && method === 'GET') {
          onlyQuery(target, []);
          result = store.read(id(parts[2], 'message'), actor);
        } else if (parts.length === 4 && parts[3] === 'status' && method === 'PATCH') {
          onlyQuery(target, []);
          const input = await jsonBody(request);
          onlyKeys(input, ['status']);
          result = store.status(id(parts[2], 'message'), actor, input.status);
        } else throw new PostError('NOT_FOUND', 'Unknown API route or method', 404);
      } else throw new PostError('NOT_FOUND', 'Unknown API route or method', 404);
      respond(response, status, { ok: true, data: result });
    } catch (error) {
      const info = errorInfo(error);
      if (!(error instanceof PostError)) {
        // Never log request bodies, query strings, tokens, or SQL parameter values.
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_0-9]+$/.test(error.code) ? error.code : undefined;
        try { log('internal_error', { error_type: error instanceof Error ? error.name : 'unknown', error_code: code }); }
        catch (logError) { process.stderr.write(`Agent Post log failure: ${String(logError)}\n`); }
      }
      if (!response.headersSent && !response.destroyed) respond(response, error instanceof PostError ? error.status : 500, { ok: false, error: info });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', failed);
        resolve();
      });
    });
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new PostError('INTERNAL_ERROR', 'Server did not bind a TCP port', 500);
    config.baseUrl = `http://127.0.0.1:${bound.port}`;
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      hosts.add(`${host}:${bound.port}`);
      if (bound.port === 80) hosts.add(host);
    }
    writeConnection(dataDir, { ...connection, base_url: config.baseUrl });
    log('started', { pid: process.pid, base_url: config.baseUrl });
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    release();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    server,
    config,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => {
          try {
            store.close();
            release();
            if (error) throw error;
            log('stopped');
            resolve();
          } catch (closeError) { reject(closeError); }
        });
      });
      return closing;
    },
  };
}

function onlyQuery(target: URL, allowed: string[]): void {
  for (const key of target.searchParams.keys()) {
    if (!allowed.includes(key)) throw new PostError('INVALID_INPUT', `Unknown query parameter ${key}`);
  }
}
