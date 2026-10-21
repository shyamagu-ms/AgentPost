import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { acquireLock, initialize, protect, writeConnection } from '../dist/data.js';
import { resolveConfig } from '../dist/config.js';
import { startServer } from '../dist/server.js';
import { Store } from '../dist/store.js';

const cli = resolve('dist', 'cli.js');
const a = 'backend@product-a';
const b = 'architect@product-a';
function run(args, { cwd, input, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd, env: { ...process.env, AGENT_POST_DATA_DIR: '', AGENT_POST_ADDRESS: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => stdout += data);
    child.stderr.setEncoding('utf8').on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', code => {
      try { resolve({ code, result: JSON.parse(code === 0 ? stdout : stderr), stdout, stderr }); }
      catch { reject(new Error(`CLI code=${code}\nstdout=${stdout}\nstderr=${stderr}`)); }
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-post-v2-'));
  const dataDir = join(root, 'Mail Data');
  let running;
  t.after(async () => {
    if (running) await running.close();
    rmSync(root, { recursive: true, force: true });
  });
  running = await startServer({ dataDir, port: 0 });
  return { root, dataDir, running, config: running.config };
}
async function api(f, method, path, body, actor = a, headers = {}) {
  const response = await fetch(f.config.baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${f.config.token}`, 'X-Agent-Address': actor,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, result: await response.json() };
}
function payload(extra = {}) {
  return { to: b, subject: 'API 設計の相談', body: '# 本文\n\n**日本語** と Markdown。\n', idempotency_key: randomUUID(), ...extra };
}

test('minimal API: directory, direct send, inbox, read/unread, reply and persistence', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  let message;
  await t.test('first start initializes an ordinary folder with no workspace/setup/config YAML', async () => {
    assert.equal((await api(f, 'GET', '/v1/health')).result.data.schema_version, 2);
    assert.ok(existsSync(join(f.dataDir, 'agent-post.sqlite')));
    assert.ok(existsSync(join(f.dataDir, 'connection.json')));
    assert.equal(existsSync(join(f.dataDir, '.local')), false);
    assert.equal(resolveConfig({ dataDir: f.dataDir }).baseUrl, f.config.baseUrl);
  });
  await t.test('address book is optional; unregistered recipients receive posts immediately', async () => {
    assert.deepEqual((await api(f, 'GET', '/v1/contacts')).result.data.items, []);
    const sent = await api(f, 'POST', '/v1/messages', payload({ to: b.toUpperCase() }), a.toUpperCase());
    assert.equal(sent.status, 201);
    assert.equal(sent.result.data.recipient_registered, false);
    message = sent.result.data.message;
    assert.equal(message.from, a);
    assert.equal(message.to, b);
    assert.equal(message.status, 'unread');
    assert.equal(message.reply_to, null);
    assert.equal(message.thread_id, message.id);
    assert.equal(Object.hasOwn(message, 'body'), false);
    assert.equal(Object.hasOwn(message, 'idempotency_key'), false);
    assert.deepEqual((await api(f, 'GET', '/v1/contacts')).result.data.items, []);
  });
  await t.test('contacts put/list/filter/page are server-side and separate from delivery', async () => {
    for (const contact of [
      { address: a, name: '実装担当', description: 'バックエンドと実装' },
      { address: b.toUpperCase(), name: '設計担当', description: 'API 設計とコンポーネント境界' },
    ]) {
      const put = await api(f, 'PUT', '/v1/contacts', contact);
      assert.equal(put.status, 200);
      assert.equal(put.result.data.address, contact.address.toLowerCase());
    }
    const all = (await api(f, 'GET', '/v1/contacts')).result.data;
    assert.equal(all.items.length, 2);
    const first = (await api(f, 'GET', '/v1/contacts?limit=1')).result.data;
    const second = (await api(f, 'GET', `/v1/contacts?limit=1&cursor=${first.next_cursor}`)).result.data;
    assert.deepEqual([...first.items, ...second.items], all.items);
    assert.equal(second.next_cursor, null);
    assert.equal((await api(f, 'GET', '/v1/contacts?q=API')).result.data.items[0].address, b);
    assert.equal((await api(f, 'GET', '/v1/contacts?q=' + encodeURIComponent('設計'))).result.data.items.length, 1);
    assert.equal((await api(f, 'GET', '/v1/contacts?q=not-found')).result.data.items.length, 0);
    await api(f, 'PUT', '/v1/contacts', { address: b, name: '設計担当（更新）', description: 'API と設計' });
    assert.equal((await api(f, 'GET', '/v1/contacts')).result.data.items.length, 2);
    assert.equal((await api(f, 'POST', '/v1/messages', payload())).result.data.recipient_registered, true);
  });
  await t.test('list is recipient-only and lightweight; read has no status side effect', async () => {
    const list = (await api(f, 'GET', '/v1/messages', undefined, b)).result.data;
    assert.equal(list.items.length, 2);
    assert.ok(list.items.every(item => !Object.hasOwn(item, 'body')));
    assert.equal((await api(f, 'GET', '/v1/messages')).result.data.items.length, 0);
    assert.equal((await api(f, 'GET', `/v1/messages/${message.id}`)).status, 404);
    const fetched = (await api(f, 'GET', `/v1/messages/${message.id}`, undefined, b)).result.data;
    assert.equal(fetched.body, payload().body);
    assert.equal(fetched.status, 'unread');
    assert.equal(fetched.read_at, null);
    assert.equal((await api(f, 'GET', '/v1/messages?status=read', undefined, b)).result.data.items.length, 0);
  });
  await t.test('only the recipient can change read/unread; transitions are repeatable', async () => {
    assert.equal((await api(f, 'PATCH', `/v1/messages/${message.id}/status`, { status: 'read' })).status, 404);
    const marked = (await api(f, 'PATCH', `/v1/messages/${message.id}/status`, { status: 'read' }, b)).result.data;
    assert.ok(marked.read_at);
    assert.equal(Object.hasOwn(marked, 'body'), false);
    const again = (await api(f, 'PATCH', `/v1/messages/${message.id}/status`, { status: 'read' }, b)).result.data;
    assert.equal(again.read_at, marked.read_at);
    assert.equal((await api(f, 'GET', '/v1/messages?status=read', undefined, b)).result.data.items.length, 1);
    assert.equal((await api(f, 'GET', '/v1/messages?status=all', undefined, b)).result.data.items.length, 2);
    assert.equal((await api(f, 'GET', '/v1/messages?status=unread', undefined, b)).result.data.items.length, 1);
    const reset = (await api(f, 'PATCH', `/v1/messages/${message.id}/status`, { status: 'unread' }, b)).result.data;
    assert.equal(reset.read_at, null);
    assert.equal(reset.status, 'unread');
    assert.equal((await api(f, 'PATCH', `/v1/messages/${message.id}/status`, { status: 'done' }, b)).status, 400);
  });
  await t.test('reply is a send with a parent; recipient and subject are inherited', async () => {
    const value = { reply_to: message.id, body: '回答です。API を分離します。', idempotency_key: 'reply' };
    assert.equal((await api(f, 'POST', '/v1/messages', value, 'other@product-a')).status, 404);
    const reply = (await api(f, 'POST', '/v1/messages', value, b)).result.data.message;
    assert.equal(reply.to, a);
    assert.equal(reply.from, b);
    assert.equal(reply.thread_id, message.thread_id);
    assert.equal(reply.reply_to, message.id);
    assert.equal(reply.subject, message.subject);
    assert.equal(reply.status, 'unread');
    const back = (await api(f, 'POST', '/v1/messages',
      { reply_to: reply.id, body: '実装しました。', idempotency_key: 'reply-back' }, a)).result.data.message;
    assert.equal(back.thread_id, message.thread_id);
    assert.equal(back.to, b);
    assert.equal((await api(f, 'POST', '/v1/messages', { ...value, to: 'other@product-a' }, b)).status, 400);
    assert.equal((await api(f, 'GET', `/v1/messages/${message.id}`, undefined, b)).result.data.status, 'unread');
  });
  await t.test('concurrent send/reply retries are idempotent; conflicting content is rejected', async () => {
    const value = payload({ idempotency_key: 'same-key' });
    const sent = await Promise.all(Array.from({ length: 8 }, () => api(f, 'POST', '/v1/messages', value)));
    assert.equal(new Set(sent.map(item => item.result.data.message.id)).size, 1);
    assert.equal(sent.filter(item => !item.result.data.replayed).length, 1);
    assert.equal((await api(f, 'POST', '/v1/messages', { ...value, body: 'changed' })).status, 409);
    const reply = { reply_to: message.id, body: '返信の再試行', idempotency_key: 'repeat-reply' };
    const first = await api(f, 'POST', '/v1/messages', reply, b);
    const second = await api(f, 'POST', '/v1/messages', reply, b);
    assert.equal(first.result.data.message.id, second.result.data.message.id);
    assert.equal(second.result.data.replayed, true);
    assert.equal((await api(f, 'POST', '/v1/messages', value, 'another@product-a')).status, 201);
  });
  await t.test('inbox pagination is bounded, stable and scoped to actor/filter', async () => {
    const expected = (await api(f, 'GET', '/v1/messages?status=all', undefined, b)).result.data.items;
    const actual = [];
    let next;
    do {
      const page = (await api(f, 'GET', `/v1/messages?status=all&limit=2${next ? '&cursor=' + next : ''}`, undefined, b)).result.data;
      actual.push(...page.items);
      if (page.next_cursor) {
        assert.equal((await api(f, 'GET', `/v1/messages?status=read&cursor=${page.next_cursor}`, undefined, b)).status, 400);
        assert.equal((await api(f, 'GET', `/v1/messages?status=all&cursor=${page.next_cursor}`, undefined, a)).status, 400);
      }
      next = page.next_cursor;
    } while (next);
    assert.deepEqual(actual, expected);
    for (const query of ['limit=0', 'limit=201', 'cursor=bad', 'status=done', 'to=other', 'status=read&status=unread']) {
      assert.equal((await api(f, 'GET', '/v1/messages?' + query, undefined, b)).status, 400, query);
    }
  });
  await t.test('exact UTF-8 byte limits and actual 50/200-item page sizes', async () => {
    const recipient = 'bulk@demo';
    const subject = 'あ'.repeat(170) + 'ab';
    const body = 'あ'.repeat(87381) + 'a';
    assert.equal(Buffer.byteLength(subject), 512);
    assert.equal(Buffer.byteLength(body), 256 * 1024);
    const sent = await api(f, 'POST', '/v1/messages', payload({ to: recipient, subject, body }));
    assert.equal(sent.status, 201);
    const fetched = await api(f, 'GET', `/v1/messages/${sent.result.data.message.id}`, undefined, recipient);
    assert.equal(fetched.result.data.body, body);
    for (const extra of [{ subject: subject + 'あ' }, { body: body + 'あ' }]) {
      assert.equal((await api(f, 'POST', '/v1/messages', payload(extra))).status, 400);
    }
    for (let index = 1; index < 202; index++) {
      assert.equal((await api(f, 'POST', '/v1/messages', payload({ to: recipient }))).status, 201);
    }
    assert.equal((await api(f, 'GET', '/v1/messages', undefined, recipient)).result.data.items.length, 50);
    const first = (await api(f, 'GET', '/v1/messages?limit=200', undefined, recipient)).result.data;
    assert.equal(first.items.length, 200);
    assert.ok(first.next_cursor);
    assert.ok(first.items.every(item => !Object.hasOwn(item, 'body')));
    const second = (await api(f, 'GET', `/v1/messages?limit=200&cursor=${first.next_cursor}`, undefined, recipient)).result.data;
    assert.equal(second.items.length, 2);
    assert.equal(second.next_cursor, null);
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 202);
  });
  await t.test('restart preserves messages, contacts, read status and token; lock prevents duplicate server', async () => {
    await api(f, 'PATCH', `/v1/messages/${message.id}/status`, { status: 'read' }, b);
    const connection = JSON.parse(readFileSync(join(f.dataDir, 'connection.json'), 'utf8'));
    await assert.rejects(startServer({ dataDir: f.dataDir, port: 0 }), error => error.code === 'SERVER_LOCKED');
    await f.running.close();
    const restarted = await startServer({ dataDir: f.dataDir, port: 0 });
    try {
      const fresh = { config: restarted.config };
      assert.equal(restarted.config.token, connection.token);
      assert.equal((await api(fresh, 'GET', '/v1/contacts')).result.data.items.length, 2);
      const fetched = (await api(fresh, 'GET', `/v1/messages/${message.id}`, undefined, b)).result.data;
      assert.equal(fetched.status, 'read');
      assert.equal(fetched.body, payload().body);
      assert.equal((await api(fresh, 'POST', '/v1/messages', payload({ idempotency_key: 'same-key' }))).result.data.replayed, true);
    } finally { await restarted.close(); }
    assert.equal(existsSync(join(f.dataDir, 'server.lock')), false);
  });
});

test('HTTP boundaries and strict input validation', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  assert.equal((await api(f, 'GET', '/v1/health', undefined, a, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await api(f, 'GET', '/v1/health', undefined, a, { Origin: f.config.baseUrl })).status, 403);
  assert.equal((await api(f, 'GET', '/v1/health', undefined, a, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const hostile = await new Promise((resolve, reject) => {
    const req = httpRequest(f.config.baseUrl + '/v1/health', { headers: {
      Host: 'evil.example', Authorization: `Bearer ${f.config.token}`,
    } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject);
    req.end();
  });
  assert.equal(hostile, 403);
  for (const actor of ['', 'backend', 'a@@b', 'a@b\nbad']) {
    if (actor.includes('\n')) continue;
    assert.equal((await api(f, 'GET', '/v1/messages', undefined, actor)).status, 400);
  }
  for (const extra of [
    { to: 'bad' }, { subject: '' }, { body: '' }, { body: '\0' }, { body: '\ud800' },
    { subject: 'a'.repeat(513) }, { body: 'a'.repeat(256 * 1024 + 1) },
    { from: 'spoof@address' }, { kind: 'question' }, { idempotency_key: '' },
    { reply_to: 'not-found' },
  ]) {
    const result = await api(f, 'POST', '/v1/messages', payload(extra));
    assert.ok([400, 404].includes(result.status), JSON.stringify(extra).slice(0, 80));
  }
  assert.equal((await api(f, 'POST', '/v1/messages?extra=1', payload())).status, 400);
  assert.equal((await api(f, 'GET', '/v1/health?extra=1')).status, 400);
  assert.equal((await api(f, 'GET', '/v1/workspaces')).status, 404);
  assert.equal((await api(f, 'POST', '/v1/messages', payload(), a, { 'Content-Type': 'text/plain' })).status, 415);
  for (const body of ['{', '[]', 'null', '"string"']) {
    const response = await fetch(f.config.baseUrl + '/v1/messages', {
      method: 'POST', headers: { Authorization: `Bearer ${f.config.token}`, 'X-Agent-Address': a, 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, 400);
  }
  const oversized = await api(f, 'POST', '/v1/messages', payload({ body: 'a'.repeat(1024 * 1024 + 1) }));
  assert.equal(oversized.status, 413);
  for (const value of [{ address: a, name: 'A' }, { address: 'bad', name: 'A', description: 'B' },
    { address: a, name: 'A', description: 'B', extra: true }]) {
    assert.equal((await api(f, 'PUT', '/v1/contacts', value)).status, 400);
  }
  assert.equal((await api(f, 'GET', '/v1/contacts?limit=201')).status, 400);
  assert.equal((await api(f, 'GET', '/v1/contacts?q=')).status, 400);
});

test('CLI works from separate consumer folders with no project configuration', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const consumerA = join(f.root, 'Consumer A'), consumerB = join(f.root, 'Consumer B');
  mkdirSync(consumerA); mkdirSync(consumerB);
  const args = ['--data-dir', f.dataDir];
  const call = async (commands, settings = {}) => {
    const result = await run([...args, ...commands], settings);
    assert.equal(result.code, 0, result.stderr);
    return result.result;
  };
  await call(['contacts', 'put', b, '--name', '設計担当', '--description', 'API 設計'], { cwd: consumerB });
  const contacts = await call(['contacts', 'list', '--q', 'API'], { cwd: consumerA });
  assert.equal(contacts.data.items[0].address, b);
  const sent = await call(['send', '--as', a, '--to', b, '--subject', '相談', '--body-stdin'],
    { cwd: consumerA, input: '# 日本語\n\n**Markdown**\n' });
  const id = sent.data.message.id;
  assert.ok(sent.idempotency_key);
  assert.equal(sent.data.recipient_registered, true);
  const listed = await call(['list', '--as', b], { cwd: consumerB });
  assert.equal(listed.data.items[0].id, id);
  assert.equal(Object.hasOwn(listed.data.items[0], 'body'), false);
  const read = await call(['read', id, '--as', b], { cwd: consumerB });
  assert.equal(read.data.body, '# 日本語\n\n**Markdown**\n');
  assert.equal(read.data.status, 'unread');
  const marked = await call(['read', id, '--as', b, '--mark-read']);
  assert.equal(marked.data.status, 'read');
  assert.ok(marked.data.read_at);
  assert.equal(marked.data.body, read.data.body);
  assert.equal((await call(['list', '--as', b])).data.items.length, 0);
  assert.equal((await call(['list', '--as', b, '--status', 'read'])).data.items.length, 1);
  const bodyFile = join(f.root, 'reply.md');
  writeFileSync(bodyFile, '設計判断の返信です。\n', 'utf8');
  const reply = await call(['reply', id, '--as', b, '--body-file', bodyFile]);
  assert.equal(reply.data.message.to, a);
  assert.equal(reply.data.message.reply_to, id);
  const inboxA = await run(['list'], { cwd: consumerA, env: { AGENT_POST_DATA_DIR: f.dataDir, AGENT_POST_ADDRESS: a } });
  assert.equal(inboxA.code, 0, inboxA.stderr);
  assert.equal(inboxA.result.data.items[0].id, reply.data.message.id);
  await call(['status', id, '--as', b, '--set', 'unread']);
  assert.equal((await call(['list', '--as', b, '--status', 'unread'])).data.items.length, 1);
  const secondReply = await call(['send', '--as', b, '--reply-to', id, '--body', '短い返信']);
  assert.equal(secondReply.data.message.thread_id, id);
  const direct = await call(['send', '--as', a, '--to', 'future@product-a', '--subject', '先に置く', '--body', '直接送信']);
  assert.equal(direct.data.recipient_registered, false);
  const wrong = await run([...args, 'read', id, '--as', a]);
  assert.equal(wrong.code, 1);
  assert.equal(wrong.result.error.code, 'MESSAGE_NOT_FOUND');
  for (const invalid of [
    ['list'], ['list', '--as', 'backend'],
    ['send', '--as', a, '--to', b, '--subject', 'missing body'],
    ['send', '--as', a, '--to', b, '--subject', 'multiple', '--body', 'one', '--body-stdin'],
  ]) assert.notEqual((await run([...args, ...invalid])).code, 0);
  const badFile = join(f.root, 'invalid-utf8');
  writeFileSync(badFile, Buffer.from([0xff, 0xfe]));
  assert.equal((await run([...args, 'send', '--as', a, '--to', b, '--subject', 'bad', '--body-file', badFile])).result.error.code, 'INVALID_INPUT');
  assert.equal((await run(['health'])).result.error.code, 'CONFIG_ERROR');
});

test('initialization refuses unrelated/legacy data and preserves credentials on restart', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-post-init-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unrelated = join(root, 'existing');
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, 'important.txt'), 'keep');
  assert.throws(() => initialize(unrelated), error => error.code === 'INVALID_DATA_DIR');
  assert.equal(readFileSync(join(unrelated, 'important.txt'), 'utf8'), 'keep');
  const legacy = join(root, 'legacy');
  mkdirSync(legacy);
  const db = new Database(join(legacy, 'agent-post.sqlite'));
  db.exec('CREATE TABLE old_messages (body TEXT); INSERT INTO old_messages VALUES (\'keep\'); PRAGMA user_version = 1;');
  db.close();
  const before = readFileSync(join(legacy, 'agent-post.sqlite'));
  await assert.rejects(startServer({ dataDir: legacy, port: 0 }), error => error.code === 'INVALID_DATA_DIR');
  assert.throws(() => new Store(legacy), error => error.code === 'SCHEMA_VERSION');
  assert.deepEqual(readFileSync(join(legacy, 'agent-post.sqlite')), before);
  const home = join(root, 'new');
  const first = initialize(home);
  assert.deepEqual(initialize(home), first);
  protect(home);
  assert.deepEqual(initialize(home), first);
  writeFileSync(join(home, 'connection.json'), '{"format":"old"}');
  assert.throws(() => initialize(home), error => error.code === 'CONFIG_ERROR');
  for (const port of [-1, 65536, NaN, 1.5]) {
    await assert.rejects(startServer({ dataDir: join(root, 'invalid-port'), port }), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(existsSync(join(root, 'invalid-port')), false);
});

test('port conflicts release locks without changing the advertised endpoint', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const other = join(f.root, 'Other Mail');
  initialize(other);
  const before = readFileSync(join(other, 'connection.json'), 'utf8');
  await assert.rejects(startServer({ dataDir: other, port: Number(new URL(f.config.baseUrl).port) }), error => error.code === 'EADDRINUSE');
  assert.equal(existsSync(join(other, 'server.lock')), false);
  assert.equal(readFileSync(join(other, 'connection.json'), 'utf8'), before);
  const running = await startServer({ dataDir: other, port: 0 });
  await running.close();
});

async function serverChild(t, dataDir, { lockOnly = false, cliMode = false } = {}) {
  const module = pathToFileURL(resolve('dist', lockOnly ? 'data.js' : 'server.js')).href;
  const script = cliMode ? `
    process.argv = [process.execPath, 'serve', '--data-dir', ${JSON.stringify(dataDir)}, '--port', '0'];
    process.on('message', () => {
      process.disconnect();
      process.emit('SIGHUP');
    });
    await import(${JSON.stringify(pathToFileURL(cli).href)});
    process.send({ ok: true });
  ` : `
    import { ${lockOnly ? 'acquireLock' : 'startServer'} } from ${JSON.stringify(module)};
    try {
      const running = ${lockOnly ? `acquireLock(${JSON.stringify(dataDir)})` : `await startServer({ dataDir: ${JSON.stringify(dataDir)}, port: 0 })`};
      process.on('message', async () => {
        ${lockOnly ? 'running()' : 'await running.close()'};
        process.disconnect();
      });
      process.send({ ok: true, ${lockOnly ? '' : 'config: running.config,'} pid: process.pid });
    } catch (error) {
      process.send({ ok: false, code: error.code, message: error.message });
      process.disconnect();
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const result = await Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(([code, signal]) => { throw new Error(`Server child exited before readiness: ${code ?? signal}`); }),
  ]);
  return { child, result, exited };
}

test('forced termination leaves metadata but the next server recovers and preserves data', { timeout: 30000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-post-crash-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = await serverChild(t, dataDir);
  assert.equal(first.result.ok, true, first.result.message);
  const sent = await api(first.result, 'POST', '/v1/messages', payload());
  assert.equal(sent.status, 201);
  first.child.kill('SIGKILL');
  await first.exited;
  assert.ok(existsSync(join(dataDir, 'server.lock')));
  assert.throws(() => process.kill(first.result.pid, 0), error => error.code === 'ESRCH');
  const restarted = await startServer({ dataDir, port: 0 });
  try {
    assert.equal(restarted.config.token, first.result.config.token);
    assert.equal((await api(restarted, 'GET', '/v1/health')).result.data.healthy, true);
    assert.equal((await api(restarted, 'GET', `/v1/messages/${sent.result.data.message.id}`, undefined, b)).result.data.body, payload().body);
    const events = readFileSync(join(dataDir, 'server.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(events.some(event => event.event === 'stale_lock_recovered' && event.pid === first.result.pid));
  } finally { await restarted.close(); }
  assert.equal(existsSync(join(dataDir, 'server.lock')), false);
});

test('concurrent stale-lock recovery admits exactly one owner even if metadata is missing', { timeout: 30000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-post-lock-race-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const first = await serverChild(t, dataDir, { lockOnly: true });
  assert.equal(first.result.ok, true, first.result.message);
  first.child.kill('SIGKILL');
  await first.exited;
  const contenders = await Promise.all(Array.from({ length: 4 }, () => serverChild(t, dataDir, { lockOnly: true })));
  const winners = contenders.filter(({ result }) => result.ok);
  assert.equal(winners.length, 1);
  assert.ok(contenders.filter(({ result }) => !result.ok).every(({ result }) => result.code === 'SERVER_LOCKED'));
  const path = join(dataDir, 'server.lock');
  const contents = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(contents).pid, winners[0].result.pid);
  rmSync(path);
  assert.throws(() => acquireLock(dataDir), error => error.code === 'SERVER_LOCKED');
  writeFileSync(path, contents);
  winners[0].child.send('stop');
  await winners[0].exited;
  const release = acquireLock(dataDir);
  release();
  release();
});

test('CLI SIGHUP handler closes the server and releases both locks', { timeout: 30000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-post-hangup-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const running = await serverChild(t, dataDir, { cliMode: true });
  assert.equal(running.result.ok, true);
  assert.ok(existsSync(join(dataDir, 'server.lock')));
  running.child.send('hangup');
  assert.deepEqual(await running.exited, [0, null]);
  assert.equal(existsSync(join(dataDir, 'server.lock')), false);
  const release = acquireLock(dataDir);
  release();
  const events = readFileSync(join(dataDir, 'server.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).event, 'stopped');
});

test('ambiguous lock owners are never automatically removed', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-post-lock-safety-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, 'server.lock');
  await t.test('a live PID including a legacy lock is refused', () => {
    const contents = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
    writeFileSync(path, contents);
    assert.throws(() => acquireLock(dataDir), error => error.code === 'SERVER_LOCKED' && error.message.includes('still exists'));
    assert.equal(readFileSync(path, 'utf8'), contents);
  });
  await t.test('malformed metadata and invalid PIDs are refused', () => {
    for (const contents of ['', '{', 'null', '[]', '{}', '{"pid":0}', '{"pid":-1}', '{"pid":1.5}', '{"pid":"123"}', '{"pid":2147483648}']) {
      writeFileSync(path, contents);
      assert.throws(() => acquireLock(dataDir), error => error.code === 'SERVER_LOCKED');
      assert.equal(readFileSync(path, 'utf8'), contents);
    }
  });
  await t.test('permission errors and unexpected probe failures are refused', t => {
    const contents = JSON.stringify({ pid: process.pid });
    for (const code of ['EPERM', 'EACCES', 'EINVAL']) {
      writeFileSync(path, contents);
      const probe = t.mock.method(process, 'kill', (pid, signal) => {
        assert.equal(pid, process.pid);
        assert.equal(signal, 0);
        throw Object.assign(new Error('Cannot probe PID'), { code });
      });
      try {
        assert.throws(() => acquireLock(dataDir), error => error.code === 'SERVER_LOCKED' && error.message.includes('Cannot verify'));
        assert.equal(readFileSync(path, 'utf8'), contents);
      } finally { probe.mock.restore(); }
    }
  });
  rmSync(path);
  const release = acquireLock(dataDir);
  release();
});

test('CLI send failures retain retry key and never masquerade as an empty inbox', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const port = Number(new URL(f.config.baseUrl).port);
  await f.running.close();
  const commands = ['--data-dir', f.dataDir, 'send', '--as', a, '--to', b, '--subject', 'retry', '--body', 'test', '--idempotency-key', 'retry-key'];
  const offline = await run(commands);
  assert.equal(offline.code, 3);
  assert.equal(offline.result.delivery, 'unknown');
  assert.equal(offline.result.idempotency_key, 'retry-key');
  const inbox = await run(['--data-dir', f.dataDir, 'list', '--as', b]);
  assert.equal(inbox.code, 3);
  assert.equal(inbox.result.ok, false);
  const mock = createHttpServer((req, res) => {
    req.resume();
    if (req.headers['x-test']) return;
    res.end('not JSON');
  });
  await new Promise(resolve => mock.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => mock.close(resolve)));
  const malformed = await run(commands);
  assert.equal(malformed.code, 3);
  assert.equal(malformed.result.error.code, 'INVALID_RESPONSE');
  assert.equal(malformed.result.delivery, 'unknown');
  mock.removeAllListeners('request');
  mock.on('request', req => req.resume());
  const timeout = await run([...commands, '--timeout', '100']);
  assert.equal(timeout.code, 3);
  assert.equal(timeout.result.error.code, 'TIMEOUT');
  assert.equal(timeout.result.delivery, 'unknown');
});

test('retry after a committed send with a dropped response returns the same post', { timeout: 30000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-post-dropped-response-'));
  const connection = initialize(dataDir);
  const store = new Store(dataDir);
  let dropResponse = true;
  const proxy = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const result = store.send(req.headers['x-agent-address'], JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (dropResponse) {
        dropResponse = false;
        res.destroy();
      } else {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: result }));
      }
    });
  });
  t.after(async () => {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  writeConnection(dataDir, { ...connection, base_url: `http://127.0.0.1:${proxy.address().port}` });
  const args = ['--data-dir', dataDir, 'send', '--as', a, '--to', b, '--subject', 'retry',
    '--body', 'saved before connection loss', '--idempotency-key', 'committed-key'];
  const failed = await run(args);
  assert.equal(failed.code, 3);
  assert.equal(failed.result.delivery, 'unknown');
  assert.equal(failed.result.idempotency_key, 'committed-key');
  const before = store.list(b, new URLSearchParams()).items;
  assert.equal(before.length, 1);
  const retried = await run(args);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(retried.result.data.replayed, true);
  assert.equal(retried.result.data.message.id, before[0].id);
  assert.equal(store.list(b, new URLSearchParams()).items.length, 1);
});
