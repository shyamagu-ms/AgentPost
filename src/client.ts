import { type Config } from './config.js';
import { object, PostError } from './contract.js';

export async function request(config: Config, method: string, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(config.baseUrl + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeout),
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(config.actor ? { 'X-Agent-Address': config.actor } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
    throw new PostError(timeout ? 'TIMEOUT' : 'CONNECTION_ERROR',
      `${timeout ? 'Request timed out' : 'Cannot complete request to the local server'}. ${method === 'POST' ? 'Write result may be unknown; retry send/reply with the same idempotency key and identical content.' : 'No successful result was received.'}`, 503);
  }
  let envelope;
  try { envelope = object(await response.json(), 'server response'); }
  catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new PostError('TIMEOUT', 'Response timed out; write result may be unknown. Retry send/reply with the same key and identical content.', 503);
    }
    throw new PostError('INVALID_RESPONSE', `Server returned invalid JSON (HTTP ${response.status}); write result may be unknown`, 502);
  }
  if (response.ok && envelope.ok === true && Object.hasOwn(envelope, 'data')) return envelope.data;
  if (!response.ok && envelope.ok === false && envelope.error && typeof envelope.error === 'object' && !Array.isArray(envelope.error)) {
    const error = object(envelope.error, 'server error');
    if (typeof error.code === 'string' && typeof error.message === 'string') throw new PostError(error.code, error.message, response.status);
  }
  throw new PostError('INVALID_RESPONSE', `Server returned an invalid envelope (HTTP ${response.status}); write result may be unknown`, 502);
}
