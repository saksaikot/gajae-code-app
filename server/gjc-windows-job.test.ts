import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  createWindowsJobLaunch,
  GJC_WINDOWS_JOB_GUARD_ACK,
  GJC_WINDOWS_JOB_GUARD_READY,
  quoteWindowsArgument,
} from './gjc-windows-job.js';
import { killWorkerTree } from './gjc-worker-client.js';

test('quotes Windows argv values without losing quotes or trailing slashes', () => {
  assert.equal(quoteWindowsArgument('plain'), 'plain');
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('with space'), '"with space"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(
    quoteWindowsArgument('C:\\path with space\\'),
    '"C:\\path with space\\\\"',
  );
});

test('builds a guard that atomically creates the worker inside a Windows job', () => {
  const launch = createWindowsJobLaunch(
    'C:\\Program Files\\node.exe',
    ['C:\\work dir\\gjc-worker.js'],
    { SystemRoot: 'C:\\Windows', KEEP_ME: 'yes' },
    'C:\\work dir',
  );

  assert.equal(
    launch.command,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.deepEqual(launch.args.slice(0, -1), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
  ]);
  assert.ok(launch.args.join(' ').length < 30_000);
  const loader = Buffer.from(launch.args.at(-1)!, 'base64').toString('utf16le');
  const compressed = loader.match(/FromBase64String\('([^']+)'\)/u)?.[1];
  assert.ok(compressed);
  const script = gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8');
  assert.match(script, /EXTENDED_STARTUPINFO_PRESENT/);
  assert.match(script, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(script, /PROC_THREAD_ATTRIBUTE_JOB_LIST/);
  assert.match(script, /InitializeProcThreadAttributeList/);
  assert.match(script, /UpdateProcThreadAttribute/);
  assert.match(script, /WaitForMultipleObjects/);
  assert.match(script, /ReadFile/);
  assert.doesNotMatch(script, /Console\]::In/);
  assert.match(script, new RegExp(GJC_WINDOWS_JOB_GUARD_READY));
  assert.match(script, new RegExp(GJC_WINDOWS_JOB_GUARD_ACK));
  assert.ok(
    script.indexOf('$ownerHandle = [GajaeWindowsJobGuard]::OpenOwner')
      < script.indexOf(`[Console]::Out.WriteLine('${GJC_WINDOWS_JOB_GUARD_READY}')`),
  );
  assert.ok(
    script.indexOf(`ReadAcknowledgement('${GJC_WINDOWS_JOB_GUARD_ACK}')`)
      < script.indexOf('$exitCode = [GajaeWindowsJobGuard]::Run'),
  );
  assert.equal(launch.env.KEEP_ME, 'yes');
  assert.equal(
    launch.env.GAJAE_INTERNAL_JOB_OWNER_PROCESS,
    String(process.pid),
  );
  assert.equal(
    launch.env.GAJAE_INTERNAL_JOB_COMMAND_LINE,
    '"C:\\Program Files\\node.exe" "C:\\work dir\\gjc-worker.js"',
  );
});

const GRANDCHILD_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "console.log('grandchild:' + grandchild.pid);",
  'setInterval(() => {}, 1000);',
].join('\n');

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

test('a real job guard with a sleeping grandchild is reaped and the grandchild is gone', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const launch = createWindowsJobLaunch(process.execPath, ['-e', GRANDCHILD_SCRIPT], process.env, process.cwd());
  const guard = spawn(launch.command, launch.args, { env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  try {
    let output = '';
    let hasAcknowledged = false;
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      guard.once('error', reject);
      guard.once('close', () => reject(new Error(`guard closed early: ${output}`)));
      guard.stdout.setEncoding('utf8');
      guard.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (!hasAcknowledged && output.includes(GJC_WINDOWS_JOB_GUARD_READY)) {
          hasAcknowledged = true;
          guard.stdin.write(`${GJC_WINDOWS_JOB_GUARD_ACK}\n`);
        }
        const match = /grandchild:(\d+)/u.exec(output);
        if (match) resolve(Number(match[1]));
      });
    });
    assert.equal(isProcessAlive(grandchildPid), true);

    await killWorkerTree(guard, 'win32');

    for (let attempt = 0; attempt < 100 && isProcessAlive(grandchildPid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(isProcessAlive(grandchildPid), false);
  } finally {
    guard.kill();
  }
});
