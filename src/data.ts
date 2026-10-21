import { appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, chmodSync, unlinkSync, realpathSync, renameSync } from 'node:fs';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readConnection, type Connection } from './config.js';
import { PostError } from './contract.js';

export function protect(path: string): void {
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; `
      + `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); try { `
      + `$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; `
      + `$acl=New-Object System.Security.AccessControl.DirectorySecurity; `
      + `$acl.SetAccessRuleProtection($true,$false); `
      + `$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); `
      + `$acl.AddAccessRule($rule); $directory=New-Object System.IO.DirectoryInfo -ArgumentList '${path.replaceAll("'", "''")}'; $directory.SetAccessControl($acl) `
      + `} catch { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `PowerShell exited with status ${String(result.status)}`;
      throw new PostError('PERMISSION_ERROR', `Cannot restrict local data directory ACL: ${detail}`, 500);
    }
  } else chmodSync(path, 0o700);
}

export function initialize(home: string): Connection {
  const file = join(home, 'connection.json');
  if (existsSync(file)) {
    const connection = readConnection(file);
    protect(home);
    return connection;
  }
  if (existsSync(home) && readdirSync(home).length) {
    throw new PostError('INVALID_DATA_DIR', 'First start requires a new or empty folder. Legacy or unrelated files are never overwritten.');
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  protect(home);
  const connection: Connection = { format: 'agent-post/2', base_url: 'http://127.0.0.1:43127', token: randomBytes(32).toString('hex') };
  writeFileSync(file, JSON.stringify(connection, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return connection;
}

export function writeConnection(home: string, connection: Connection): void {
  const temporary = join(home, `connection-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(connection, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, join(home, 'connection.json'));
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function acquireLock(home: string): () => void {
  const directory = realpathSync(home);
  const path = join(directory, 'server.lock');
  // A separate SQLite transaction provides an OS-released lock without blocking the mailbox DB.
  const guard = new Database(join(directory, 'server.lock.sqlite'), { timeout: 0 });
  try {
    guard.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    guard.close();
    if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') {
      throw new PostError('SERVER_LOCKED', 'Another server holds the data directory lock. Stop that server first.', 409);
    }
    throw error;
  }
  try {
    if (existsSync(path)) {
      const contents = readFileSync(path, 'utf8');
      let owner: unknown;
      try { owner = JSON.parse(contents); }
      catch {
        throw new PostError('SERVER_LOCKED', `Cannot parse ${path}. Verify that no server uses this data directory before removing only that file.`, 409);
      }
      if (typeof owner !== 'object' || owner === null || !('pid' in owner)
        || typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647) {
        throw new PostError('SERVER_LOCKED', `Invalid PID in ${path}. Verify that no server uses this data directory before removing only that file.`, 409);
      }
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw new PostError('SERVER_LOCKED', `Cannot verify PID ${owner.pid} in ${path}; the lock was not removed. Stop the server or verify the process manually.`, 409);
        }
        appendFileSync(join(directory, 'server.jsonl'), JSON.stringify({
          at: new Date().toISOString(), event: 'stale_lock_recovered', pid: owner.pid,
        }) + '\n', { mode: 0o600 });
        unlinkSync(path);
      }
      if (existsSync(path)) {
        throw new PostError('SERVER_LOCKED', `PID ${owner.pid} in ${path} still exists. Stop the server first; a reused PID must be checked manually.`, 409);
      }
    }
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n'); }
    catch (error) { unlinkSync(path); throw error; }
    finally { closeSync(descriptor); }
  } catch (error) {
    guard.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { unlinkSync(path); }
    finally { guard.close(); }
  };
}
