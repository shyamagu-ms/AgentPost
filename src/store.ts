import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { address, id, limits, member, object, onlyKeys, PostError, statuses, text, type Contact, type Message, type Summary } from './contract.js';

const columns = `id, thread_id, reply_to, sender AS "from", recipient AS "to",
subject, created_at, read_at, status`;

export class Store {
  db: Database.Database;

  constructor(dataDir: string) {
    this.db = new Database(join(dataDir, 'agent-post.sqlite'));
    try {
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      const version = this.db.pragma('user_version', { simple: true });
      if (version !== 0 && version !== 2) {
        throw new PostError('SCHEMA_VERSION', `Unsupported database version ${String(version)}; use a new data folder for v2`, 500);
      }
      this.db.pragma('journal_mode = WAL');
      if (version === 0) this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE contacts (
            address TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            thread_id TEXT NOT NULL,
            reply_to TEXT REFERENCES messages(id),
            sender TEXT NOT NULL,
            recipient TEXT NOT NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            read_at TEXT,
            status TEXT NOT NULL CHECK(status IN ('unread','read')),
            idempotency_key TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            UNIQUE(sender, idempotency_key),
            CHECK ((status = 'unread' AND read_at IS NULL) OR (status = 'read' AND read_at IS NOT NULL))
          );
          CREATE INDEX inbox ON messages(recipient, seq);
          CREATE INDEX unread_inbox ON messages(recipient, status, seq);
          PRAGMA user_version = 2;
        `);
      })();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  register(value: unknown): Contact {
    const input = object(value);
    onlyKeys(input, ['address', 'name', 'description']);
    const contact: Contact = {
      address: address(input.address),
      name: text(input.name, 'name', 512)!,
      description: text(input.description, 'description', 4096)!,
      updated_at: new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO contacts VALUES (@address, @name, @description, @updated_at)
      ON CONFLICT(address) DO UPDATE SET name=excluded.name, description=excluded.description, updated_at=excluded.updated_at`).run(contact);
    return contact;
  }

  directory(query: URLSearchParams): { items: Contact[]; next_cursor: string | null } {
    const { limit, after } = page(query, ['q'], 'contacts');
    const q = query.has('q') ? text(query.get('q'), 'q', 512)! : '';
    const rows = this.db.prepare(`SELECT * FROM contacts
      WHERE address > ? AND instr(lower(address || ' ' || name || ' ' || description), lower(?)) > 0
      ORDER BY address LIMIT ?`).all(after, q, limit + 1) as Contact[];
    const items = rows.slice(0, limit);
    return { items, next_cursor: rows.length > limit ? cursor(query, 'contacts', items.at(-1)!.address) : null };
  }

  private summary(messageId: string): Summary {
    const row = this.db.prepare(`SELECT ${columns} FROM messages WHERE id = ?`).get(id(messageId, 'message')) as Summary | undefined;
    if (!row) throw new PostError('MESSAGE_NOT_FOUND', 'Message not found in your inbox', 404);
    return row;
  }

  private received(messageId: string, actor: string): Summary {
    const row = this.summary(messageId);
    if (row.to !== address(actor)) throw new PostError('MESSAGE_NOT_FOUND', 'Message not found in your inbox', 404);
    return row;
  }

  read(messageId: string, actor: string): Message {
    this.received(messageId, actor);
    return this.db.prepare(`SELECT ${columns}, body, idempotency_key FROM messages WHERE id = ?`).get(messageId) as Message;
  }

  status(messageId: string, actor: string, value: unknown): Summary {
    const state = member(value, statuses, 'status');
    return this.db.transaction(() => {
      const row = this.received(messageId, actor);
      if (row.status !== state) this.db.prepare('UPDATE messages SET status = ?, read_at = ? WHERE id = ?')
        .run(state, state === 'read' ? new Date().toISOString() : null, messageId);
      return this.summary(messageId);
    })();
  }

  send(actor: string, value: unknown): { message: Summary; replayed: boolean; recipient_registered: boolean } {
    const sender = address(actor);
    const input = object(value);
    onlyKeys(input, ['to', 'subject', 'body', 'reply_to', 'idempotency_key']);
    const body = text(input.body, 'body', limits.body)!;
    const key = text(input.idempotency_key, 'idempotency_key', 200)!;
    const parent = input.reply_to === undefined ? undefined : this.received(id(input.reply_to, 'reply_to'), sender);
    const recipient = input.to === undefined && parent ? parent.from : address(input.to, 'to');
    if (parent && recipient !== parent.from) throw new PostError('INVALID_INPUT', 'A reply must go to the original sender');
    const subject = input.subject === undefined && parent ? parent.subject : text(input.subject, 'subject', limits.subject)!;
    const hash = createHash('sha256').update(JSON.stringify({ sender, recipient, subject, body, reply_to: parent?.id ?? null })).digest('hex');
    return this.db.transaction(() => {
      const registered = Boolean(this.db.prepare('SELECT 1 FROM contacts WHERE address = ?').get(recipient));
      const previous = this.db.prepare('SELECT id, payload_hash FROM messages WHERE sender = ? AND idempotency_key = ?')
        .get(sender, key) as { id: string; payload_hash: string } | undefined;
      if (previous) {
        if (previous.payload_hash !== hash) throw new PostError('IDEMPOTENCY_CONFLICT', 'Key already used with different content', 409);
        return { message: this.summary(previous.id), replayed: true, recipient_registered: registered };
      }
      const messageId = randomUUID();
      this.db.prepare(`INSERT INTO messages
        (id,thread_id,reply_to,sender,recipient,subject,body,created_at,read_at,status,idempotency_key,payload_hash)
        VALUES (?,?,?,?,?,?,?,?,NULL,'unread',?,?)`).run(
        messageId, parent?.thread_id ?? messageId, parent?.id ?? null, sender, recipient, subject, body,
        new Date().toISOString(), key, hash,
      );
      return { message: this.summary(messageId), replayed: false, recipient_registered: registered };
    })();
  }

  list(actor: string, query: URLSearchParams): { items: Summary[]; next_cursor: string | null } {
    const recipient = address(actor);
    const { limit, after } = page(query, ['status'], recipient);
    const state = query.has('status') ? member(query.get('status'), [...statuses, 'all'], 'status') : 'unread';
    const rows = this.db.prepare(`SELECT seq, ${columns} FROM messages
      WHERE recipient = ? AND seq > ? ${state === 'all' ? '' : 'AND status = ?'} ORDER BY seq LIMIT ?`)
      .all(recipient, Number(after || 0), ...(state === 'all' ? [] : [state]), limit + 1) as (Summary & { seq: number })[];
    const items = rows.slice(0, limit);
    return {
      items: items.map(({ seq: _seq, ...item }) => item),
      next_cursor: rows.length > limit ? cursor(query, recipient, String(items.at(-1)!.seq)) : null,
    };
  }
}

function fingerprint(query: URLSearchParams, scope: string): string {
  return createHash('sha256').update(JSON.stringify([scope, [...query].filter(([key]) => key !== 'cursor' && key !== 'limit').sort()])).digest('hex');
}

function cursor(query: URLSearchParams, scope: string, after: string): string {
  return Buffer.from(JSON.stringify({ filter: fingerprint(query, scope), after })).toString('base64url');
}

function page(query: URLSearchParams, filters: string[], scope: string): { limit: number; after: string } {
  for (const key of query.keys()) {
    if (!['limit', 'cursor', ...filters].includes(key) || query.getAll(key).length !== 1) {
      throw new PostError('INVALID_INPUT', `Unknown or repeated query parameter ${key}`);
    }
  }
  const limit = query.has('limit') ? Number(query.get('limit')) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new PostError('INVALID_INPUT', 'limit must be 1..200');
  if (!query.has('cursor')) return { limit, after: '' };
  try {
    const parsed = object(JSON.parse(Buffer.from(query.get('cursor')!, 'base64url').toString('utf8')));
    if (parsed.filter !== fingerprint(query, scope) || typeof parsed.after !== 'string') throw new Error('mismatch');
    if (scope === 'contacts') address(parsed.after);
    else if (!/^[1-9][0-9]*$/.test(parsed.after) || !Number.isSafeInteger(Number(parsed.after))) throw new Error('invalid sequence');
    return { limit, after: parsed.after };
  } catch {
    throw new PostError('INVALID_CURSOR', 'Cursor does not match this address and filter');
  }
}
