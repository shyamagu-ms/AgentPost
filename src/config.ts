import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { address, object, onlyKeys, PostError } from './contract.js';

export interface Options {
  dataDir?: string;
  as?: string;
  timeout?: string;
}

export interface Connection {
  format: 'agent-post/2';
  base_url: string;
  token: string;
}

export interface Config {
  dataDir: string;
  baseUrl: string;
  token: string;
  actor?: string;
  timeout: number;
}

export function dataPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PostError('CONFIG_ERROR', 'Specify --data-dir <folder> or AGENT_POST_DATA_DIR');
  }
  return resolve(value);
}

export function loopbackUrl(value: unknown): URL {
  let url: URL;
  try { url = new URL(String(value)); }
  catch { throw new PostError('CONFIG_ERROR', 'base_url must be a loopback HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.port === '0' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new PostError('CONFIG_ERROR', 'base_url must be a loopback HTTP URL without credentials, path, query, or fragment');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

export function readConnection(file: string): Connection {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    throw new PostError('CONFIG_ERROR', `Cannot read connection file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const input = object(value, 'connection file');
  onlyKeys(input, ['format', 'base_url', 'token']);
  if (input.format !== 'agent-post/2' || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) {
    throw new PostError('CONFIG_ERROR', 'Not an Agent Post v2 data directory; do not reuse legacy data');
  }
  return { format: 'agent-post/2', base_url: loopbackUrl(input.base_url).origin, token: input.token };
}

export function resolveConfig(options: Options): Config {
  const dataDir = dataPath(options.dataDir ?? process.env.AGENT_POST_DATA_DIR);
  const connection = readConnection(resolve(dataDir, 'connection.json'));
  const actor = options.as ?? (process.env.AGENT_POST_ADDRESS || undefined);
  const timeout = Number(options.timeout ?? '10000');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) {
    throw new PostError('INVALID_INPUT', 'timeout must be 1..300000 milliseconds');
  }
  return { dataDir, baseUrl: connection.base_url, token: connection.token, timeout,
    actor: actor === undefined ? undefined : address(actor) };
}

export function requireActor(config: Config): string {
  if (!config.actor) throw new PostError('ADDRESS_REQUIRED', 'Specify --as <address> or AGENT_POST_ADDRESS');
  return config.actor;
}
