export class PostError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const statuses = ['unread', 'read'] as const;
export type Status = typeof statuses[number];
export type RecordValue = Record<string, unknown>;
export const limits = { subject: 512, body: 256 * 1024, json: 1024 * 1024 };

export function object(value: unknown, label = 'input'): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PostError('INVALID_INPUT', `${label} must be an object`);
  }
  return value as RecordValue;
}

export function onlyKeys(value: RecordValue, keys: string[]): void {
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length) throw new PostError('INVALID_INPUT', `Unknown fields: ${unknown.join(', ')}`);
}

export function text(value: unknown, label: string, max: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max || value.includes('\0')
    || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new PostError('INVALID_INPUT', `${label} must be nonempty UTF-8 text, at most ${max} bytes, without NUL`);
  }
  return value;
}

export function id(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new PostError('INVALID_INPUT', `${label} must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,127}`);
  }
  return value;
}

export function address(value: unknown, label = 'address'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}@[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new PostError('INVALID_INPUT', `${label} must be a logical address such as backend@product-a (ASCII, at most 64@128 characters)`);
  }
  return value.toLowerCase();
}

export function member<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new PostError('INVALID_INPUT', `${label} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

export interface Message {
  id: string;
  thread_id: string;
  reply_to: string | null;
  from: string;
  to: string;
  subject: string;
  body: string;
  created_at: string;
  read_at: string | null;
  status: Status;
  idempotency_key: string;
}

export type Summary = Omit<Message, 'body' | 'idempotency_key'>;

export interface Contact {
  address: string;
  name: string;
  description: string;
  updated_at: string;
}

export function errorInfo(error: unknown): { code: string; message: string } {
  return error instanceof PostError
    ? { code: error.code, message: error.message }
    : { code: 'INTERNAL_ERROR', message: 'Unexpected failure; inspect the local server log or terminal.' };
}
