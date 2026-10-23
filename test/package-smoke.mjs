import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const exec = promisify(execFile);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run via npm run test:package');
const root = mkdtempSync(join(tmpdir(), 'agent-post-package-'));
const dataDir = join(root, 'Mail Data');
let child;
let childClosed;
async function node(args, cwd = process.cwd()) {
  return exec(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}
try {
  const packed = JSON.parse((await node([npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', root])).stdout)[0];
  assert.ok(packed.files.some(file => file.path === '.github/skills/agent-post/SKILL.md'));
  assert.ok(packed.files.every(file => !file.path.includes('.local/') && !file.path.includes('/node_modules/')
    && !file.path.endsWith('connection.json') && !file.path.endsWith('home.js') && !file.path.endsWith('.sqlite')));
  const archive = join(root, packed.filename);
  const projects = [join(root, 'Consumer A'), join(root, 'Consumer B')];
  await Promise.all(projects.map(async (cwd, index) => {
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: `agent-post-consumer-${index}`, private: true }));
    await node([npmCli, 'install', '--save-dev', '--no-audit', '--no-fund', archive], cwd);
  }));
  const sourceSkill = readFileSync(new URL('../.github/skills/agent-post/SKILL.md', import.meta.url), 'utf8');
  for (const cwd of projects) {
    const relative = join('.github', 'skills', 'agent-post', 'SKILL.md');
    const installedSkill = join(cwd, 'node_modules', 'agent-post-local', relative);
    const projectSkill = join(cwd, relative);
    mkdirSync(dirname(projectSkill), { recursive: true });
    copyFileSync(installedSkill, projectSkill);
    assert.equal(readFileSync(projectSkill, 'utf8'), sourceSkill);
  }
  const installedCli = join(projects[0], 'node_modules', 'agent-post-local', 'dist', 'cli.js');
  child = spawn(process.execPath, [installedCli, 'serve', '--data-dir', dataDir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  childClosed = once(child, 'close');
  const ready = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => reject(new Error(`Server readiness timeout: ${stderr}`)), 20000);
    child.stderr.on('data', data => stderr += data);
    child.stdout.on('data', data => {
      stdout += data;
      if (stdout.includes('"running": true')) {
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  assert.ok(ready.data.base_url.startsWith('http://127.0.0.1:'));
  assert.equal(JSON.stringify(ready).includes('"token"'), false);
  async function cli(cwd, args) {
    return JSON.parse((await node([npmCli, 'exec', '--no', '--', 'agent-post', '--data-dir', dataDir, ...args], cwd)).stdout);
  }
  assert.equal((await cli(projects[1], ['health'])).data.healthy, true);
  await cli(projects[1], ['contacts', 'put', 'architect@demo', '--name', '設計担当', '--description', 'API 設計']);
  assert.equal((await cli(projects[0], ['contacts', 'list', '--q', 'API'])).data.items[0].address, 'architect@demo');
  const bodyFile = join(root, 'body.md');
  writeFileSync(bodyFile, '# 日本語\n\n**Markdown** の保持。\n');
  const sent = await cli(projects[0], ['send', '--as', 'backend@demo', '--to', 'architect@demo', '--subject', '配布版の確認', '--body-file', bodyFile]);
  const listed = await cli(projects[1], ['list', '--as', 'architect@demo']);
  assert.equal(listed.data.items[0].id, sent.data.message.id);
  assert.equal(Object.hasOwn(listed.data.items[0], 'body'), false);
  const read = await cli(projects[1], ['read', sent.data.message.id, '--as', 'architect@demo', '--mark-read']);
  assert.equal(read.data.body, '# 日本語\n\n**Markdown** の保持。\n');
  assert.equal(read.data.status, 'read');
  const reply = await cli(projects[1], ['reply', sent.data.message.id, '--as', 'architect@demo', '--body', '確認しました。']);
  assert.equal((await cli(projects[0], ['list', '--as', 'backend@demo'])).data.items[0].id, reply.data.message.id);
  if (process.platform === 'win32') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const script = `$OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); `
      + `'パイプの日本語' | & node ${quote(installedCli)} --data-dir ${quote(dataDir)} send --as backend@demo --to architect@demo --subject 'パイプ' --body-stdin`;
    const ps = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
    const piped = JSON.parse(ps.stdout);
    assert.equal((await cli(projects[1], ['read', piped.data.message.id, '--as', 'architect@demo'])).data.body, 'パイプの日本語\r\n');
  }
  console.log('Package smoke passed: installed server, two consumers without config files, contacts, inbox, reply, UTF-8, runtime data excluded.');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (childClosed) await childClosed;
  rmSync(root, { recursive: true, force: true });
}
