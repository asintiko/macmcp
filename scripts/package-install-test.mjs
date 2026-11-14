#!/usr/bin/env node
// Release check: build the npm package, install it the way a user would (globally, into a
// throwaway prefix) and use the installed `mcpclaude` command — version, help, tool list,
// doctor, and a real server answering a real MCP client. Run with `npm run test:package`.
//
// Everything happens in a temporary directory; nothing is installed on this machine and the
// user's own ~/.mcpclaude is not touched.
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

let failures = 0;
function check(condition, what, detail = '') {
  if (condition) {
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}${detail ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`);
  }
}

/** Files that must be in the package, and path prefixes that must not. */
const REQUIRED = [
  'package.json',
  'README.md',
  'dist/cli/main.js',
  'dist/tools/index.js',
  'native/helper/main.swift',
  'assets/guides/overview.md',
  'assets/guides/computer-use.md',
  'assets/guides/blender.md',
  'assets/guides/after-effects.md',
  'docs/README.md',
  'docs/TOOLS.md',
];
const FORBIDDEN = ['src/', 'tests/', 'scripts/', '.github/', 'node_modules/', 'coverage/'];

const work = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-package-')));
const prefix = path.join(work, 'prefix');
const home = path.join(work, 'home');
const project = path.join(work, 'project');
await mkdir(home);
await mkdir(project);
await writeFile(path.join(project, 'hello.txt'), 'hello from the package test\n');

/** The installed command, with its own settings directory and nothing inherited that could change the result. */
const bin = path.join(prefix, 'bin', 'mcpclaude');
const env = { ...process.env, MCPCLAUDE_HOME: home, NO_COLOR: '1' };
delete env['NGROK_AUTHTOKEN'];
const cli = async (...args) => {
  try {
    const { stdout, stderr } = await run(bin, args, { env, cwd: work, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
  }
};

let server;
try {
  console.log(`Packing ${pkg.name} ${pkg.version}…`);
  const packed = JSON.parse((await run(npm, ['pack', '--json', '--pack-destination', work], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout)[0];
  const tarball = path.join(work, packed.filename);
  const files = packed.files.map((file) => file.path);
  console.log(`  ${packed.filename}: ${files.length} files, ${Math.round(packed.size / 1024)} kB packed, ${Math.round(packed.unpackedSize / 1024)} kB unpacked`);
  for (const file of REQUIRED) check(files.includes(file), `the package contains ${file}`);
  for (const dir of FORBIDDEN) check(!files.some((file) => file.startsWith(dir)), `the package contains nothing from ${dir}`);

  console.log('Installing it globally into a temporary prefix…');
  await run(npm, ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball], { cwd: work, maxBuffer: 64 * 1024 * 1024 });

  console.log('Running the installed command…');
  const version = await cli('--version');
  check(version.code === 0 && version.stdout.trim() === pkg.version, `mcpclaude --version prints ${pkg.version}`, version.stdout + version.stderr);

  const help = await cli('--help');
  check(help.code === 0 && help.stdout.includes('Usage') && help.stdout.includes('mcpclaude doctor'), 'mcpclaude --help prints the usage', help.stdout + help.stderr);

  const listed = await cli('tools', '--format', 'json');
  let catalogue;
  try {
    catalogue = JSON.parse(listed.stdout);
  } catch {
    catalogue = undefined;
  }
  check(listed.code === 0 && catalogue?.version === pkg.version && catalogue.tools.length > 50, `mcpclaude tools lists the catalogue (${catalogue?.tools.length ?? 0} tools)`, listed.stderr);

  const reference = await cli('tools', '--format', 'markdown');
  const shipped = await readFile(path.join(prefix, 'lib', 'node_modules', pkg.name, 'docs', 'TOOLS.md'), 'utf8').catch(() => '');
  check(reference.code === 0 && reference.stdout === shipped, 'the tool reference in the package matches the installed tools');

  const bad = await cli('--no-such-option');
  check(bad.code === 2, 'an unknown option is a usage error (exit code 2)', bad.stdout + bad.stderr);

  const doctor = await cli('doctor', '--offline');
  check(doctor.code === 0 && doctor.stdout.includes('ngrok SDK') && !doctor.stdout.includes('✖'), 'mcpclaude doctor finds no blocking problem', doctor.stdout + doctor.stderr);
  console.log(doctor.stdout.trim().split('\n').map((line) => `        ${line}`).join('\n'));

  console.log('Starting the installed server and connecting an MCP client…');
  const token = 'package-test-token-0123456789';
  server = spawn(bin, ['--no-tunnel', '--dir', project, '--mode', 'project', '--token', token, '--yes'], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (chunk) => (output += chunk.toString()));
  server.stderr.on('data', (chunk) => (output += chunk.toString()));
  const exited = new Promise((resolve) => server.once('exit', (code, signal) => resolve({ code, signal })));

  const deadline = Date.now() + 120_000;
  while (!output.includes('Ready.') && server.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
  check(output.includes('Ready.') && port !== undefined, 'the server starts without questions when everything is given on the command line', output);

  if (port !== undefined && server.exitCode === null) {
    const client = new Client({ name: 'package-install-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const text = (result) => (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');

    const tools = await client.listTools();
    check(tools.tools.some((tool) => tool.name === 'run_command') && !tools.tools.some((tool) => tool.name === 'screenshot'), `the client sees the Project-Only tools (${tools.tools.length})`);

    const info = await client.callTool({ name: 'server_info', arguments: {} });
    check(info.structuredContent?.server?.version === pkg.version && info.structuredContent?.permission_mode === 'project', 'server_info reports the version and the permission level', text(info));

    const guide = await client.callTool({ name: 'usage_guide', arguments: { topic: 'overview' } });
    check(!guide.isError && text(guide).includes('mcpclaude'), 'usage_guide serves the guides shipped in the package', text(guide));

    const read = await client.callTool({ name: 'read_file', arguments: { path: 'hello.txt' } });
    check(!read.isError && text(read).includes('hello from the package test'), 'read_file reads a project file', text(read));

    const command = await client.callTool({ name: 'run_command', arguments: { command: 'cat hello.txt && echo ran > made-by-command.txt' } });
    const made = await readFile(path.join(project, 'made-by-command.txt'), 'utf8').catch(() => '');
    check(!command.isError && text(command).startsWith('Exit code 0') && made.trim() === 'ran', 'run_command runs a shell command in the project', text(command));

    const outside = await client.callTool({ name: 'read_file', arguments: { path: path.join(home, 'config.json') } });
    check(outside.isError === true && text(outside).includes('OUTSIDE_PROJECT'), 'a path outside the project is refused', text(outside));

    const refused = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    check(refused.status === 401, 'a request without the access token is rejected (401)', `HTTP ${refused.status}`);
    await client.close();
  }

  server.kill('SIGTERM');
  const end = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(undefined), 20_000))]);
  check(end !== undefined && end.code === 0, 'the server shuts down cleanly on SIGTERM', `${JSON.stringify(end)}\n${output}`);
  check(output.includes('Stopped.'), 'it says that it stopped', output);
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failures === 0 ? '\nPackage install test passed.' : `\nPackage install test FAILED (${failures} problem${failures === 1 ? '' : 's'}).`);
process.exit(failures === 0 ? 0 : 1);
