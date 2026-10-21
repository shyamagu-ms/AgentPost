#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataPath, requireActor, resolveConfig, type Config, type Options } from './config.js';
import { errorInfo, id, limits, object, PostError, text } from './contract.js';
import { request } from './client.js';
import { startServer } from './server.js';

const program = new Command();
let usedKey: string | undefined;
let writeAttempted = false;
function output(value: unknown): void {
  process.stdout.write(JSON.stringify({ ok: true, data: value, ...(usedKey ? { idempotency_key: usedKey } : {}) }, null, 2) + '\n');
}
function options(): Options { return program.opts<Options>(); }
function configured(actor = false): Config {
  const config = resolveConfig(options());
  if (actor) requireActor(config);
  return config;
}
function body(command: Command): string {
  const args = command.opts<{ body?: string; bodyStdin?: boolean; bodyFile?: string }>();
  if ([args.body !== undefined, Boolean(args.bodyStdin), args.bodyFile !== undefined].filter(Boolean).length !== 1) {
    throw new PostError('INVALID_INPUT', 'Specify exactly one of --body <text>, --body-stdin, or --body-file <UTF-8-file>');
  }
  if (args.body !== undefined) return text(args.body, 'body', limits.body)!;
  let bytes: Buffer;
  try { bytes = readFileSync(args.bodyFile ? resolve(args.bodyFile) : 0); }
  catch (error) { throw new PostError('INPUT_ERROR', `Cannot read message body: ${error instanceof Error ? error.message : String(error)}`); }
  try { return text(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'body', limits.body)!; }
  catch (error) {
    if (error instanceof PostError) throw error;
    throw new PostError('INVALID_INPUT', 'Body must be valid UTF-8; use --body-file or configure pipeline encoding');
  }
}
function payloadOptions(command: Command): Command {
  return command.option('--body <text>', 'Message body')
    .option('--body-stdin', 'Read UTF-8 body from standard input')
    .option('--body-file <file>', 'Read body from a UTF-8 file')
    .option('--idempotency-key <key>', 'Reuse the same key and content when retrying');
}
async function send(command: Command, replyTo?: string): Promise<void> {
  usedKey = command.opts<{ idempotencyKey?: string }>().idempotencyKey ?? randomUUID();
  text(usedKey, 'idempotency_key', 200);
  const config = configured(true);
  const args = command.opts<{ to?: string; subject?: string; replyTo?: string }>();
  const parent = replyTo ?? args.replyTo;
  const value = {
    ...(args.to === undefined ? {} : { to: args.to }),
    ...(args.subject === undefined ? {} : { subject: args.subject }),
    ...(parent === undefined ? {} : { reply_to: id(parent, 'reply_to') }),
    body: body(command), idempotency_key: usedKey,
  };
  writeAttempted = true;
  output(await request(config, 'POST', '/v1/messages', value));
}

program.name('agent-post').description('A small local mailbox for agents (JSON output)')
  .version('0.2.0')
  .option('--data-dir <folder>', 'Server data folder; alternatively AGENT_POST_DATA_DIR')
  .option('--as <address>', 'Self-declared address; alternatively AGENT_POST_ADDRESS')
  .option('--timeout <milliseconds>', 'HTTP timeout, 1..300000', '10000')
  .exitOverride();

program.command('serve').description('Start in the foreground; initialize a new data folder automatically')
  .option('--port <number>', 'Loopback port; 0 selects an available port', '43127')
  .action(async (args: { port: string }) => {
    const running = await startServer({ dataDir: dataPath(options().dataDir ?? process.env.AGENT_POST_DATA_DIR), port: Number(args.port) });
    const stop = () => {
      void running.close().then(() => { process.exitCode = 0; }, error => {
        process.stderr.write(JSON.stringify({ ok: false, error: errorInfo(error) }) + '\n');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('SIGHUP', stop);
    output({ running: true, pid: process.pid, data_dir: running.config.dataDir, base_url: running.config.baseUrl });
  });

program.command('health').action(async () => output(await request(configured(), 'GET', '/v1/health')));
const contacts = program.command('contacts').description('Server-side address book; registration is not required for delivery');
contacts.command('put <address>')
  .requiredOption('--name <text>', 'Display name')
  .requiredOption('--description <text>', 'Responsibilities and when to contact this address')
  .action(async (address: string, args: { name: string; description: string }) => {
    output(await request(configured(), 'PUT', '/v1/contacts', { address, ...args }));
  });
contacts.command('list')
  .option('--q <text>', 'Substring of address, name or description')
  .option('--limit <count>', 'Page size, 1..200')
  .option('--cursor <value>', 'next_cursor from the same query')
  .action(async (args: Record<string, string>) => output(await request(configured(), 'GET', `/v1/contacts?${new URLSearchParams(args)}`)));

payloadOptions(program.command('send').option('--to <address>', 'Recipient; can be unregistered')
  .option('--subject <text>', 'Subject; required unless replying')
  .option('--reply-to <id>', 'Reply to a message in your inbox'))
  .action(async (_args: unknown, command: Command) => send(command));
payloadOptions(program.command('reply <message-id>').description('Shortcut for send --reply-to; inherits recipient and subject'))
  .action(async (messageId: string, _args: unknown, command: Command) => send(command, messageId));

program.command('list').description('List your inbox without bodies; never marks read')
  .option('--status <status>', 'unread, read, or all', 'unread')
  .option('--limit <count>', 'Page size, 1..200')
  .option('--cursor <value>', 'next_cursor from the same address and filter')
  .action(async (args: Record<string, string>) => output(await request(configured(true), 'GET', `/v1/messages?${new URLSearchParams(args)}`)));
program.command('read <message-id>').description('Fetch your received message without marking it read')
  .option('--mark-read', 'Also explicitly mark the message read')
  .action(async (messageId: string, args: { markRead?: boolean }) => {
    const config = configured(true);
    const path = `/v1/messages/${encodeURIComponent(id(messageId, 'message'))}`;
    const message = await request(config, 'GET', path);
    if (args.markRead) {
      const updated = await request(config, 'PATCH', path + '/status', { status: 'read' });
      output({ ...object(message, 'message response'), ...object(updated, 'status response') });
    } else output(message);
  });
program.command('status <message-id>').requiredOption('--set <status>', 'read or unread')
  .action(async (messageId: string, args: { set: string }) => {
    output(await request(configured(true), 'PATCH', `/v1/messages/${encodeURIComponent(id(messageId, 'message'))}/status`, { status: args.set }));
  });

try { await program.parseAsync(); }
catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
    let info = errorInfo(error);
    if (error instanceof CommanderError) info = { code: 'USAGE_ERROR', message: error.message };
    else if (error instanceof Error && !(error instanceof PostError)) info = { code: 'LOCAL_ERROR', message: error.message };
    const unknown = writeAttempted && ['TIMEOUT', 'CONNECTION_ERROR', 'INVALID_RESPONSE', 'INTERNAL_ERROR'].includes(info.code);
    process.stderr.write(JSON.stringify({
      ok: false, error: info, ...(usedKey ? { idempotency_key: usedKey, delivery: unknown ? 'unknown' : 'not_saved',
        ...(unknown ? { retry: 'Use the same idempotency key and identical content; a new key creates a separate message.' } : {}) } : {}),
    }, null, 2) + '\n');
    process.exitCode = info.code === 'USAGE_ERROR' || info.code === 'INVALID_INPUT' ? 2
      : ['TIMEOUT', 'CONNECTION_ERROR', 'INVALID_RESPONSE'].includes(info.code) ? 3 : 1;
  }
}
