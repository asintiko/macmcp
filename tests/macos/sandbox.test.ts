import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProgram } from '../../src/core/exec.js';
import type { ShellName } from '../../src/core/processes.js';
import { Runtime } from '../../src/core/runtime.js';

/**
 * Real enforcement of the Project-Only sandbox. Runs only on macOS (GitHub macOS runners in
 * CI): each case executes an actual command under the generated Seatbelt profile.
 */
describe.runIf(process.platform === 'darwin')('Seatbelt sandbox enforcement (macOS)', () => {
  let root: string;
  let project: string;
  let outside: string;
  let homeSecret: string;
  let runtime: Runtime;

  const sh = async (command: string, shell?: ShellName): Promise<{ code: number | null; out: string }> => {
    const plan = runtime.shellPlan(command, shell);
    expect(plan.sandboxed).toBe(true);
    const result = await runProgram(plan.file, plan.args, { cwd: project, env: runtime.commandEnv(), timeoutMs: 120_000 });
    return { code: result.code, out: `${result.stdout}${result.stderr}`.trim() };
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'mcpclaude-sbx-')));
    project = path.join(root, 'project');
    outside = path.join(root, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside-secret');
    homeSecret = path.join(homedir(), `.mcpclaude-sandbox-test-${process.pid}.txt`);
    await writeFile(homeSecret, 'home-secret');
    runtime = new Runtime({ stateDir: path.join(root, 'state'), authMode: 'token', auditToDisk: false });
    await runtime.configure({ mode: 'project', projectDir: project });
  });

  afterAll(async () => {
    await rm(homeSecret, { force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('loads the generated profile', () => {
    expect(runtime.sandboxStatus()).toEqual({
      active: true,
      kind: 'seatbelt',
      detail: 'Commands run under macOS Seatbelt, confined to the project directory.',
    });
  });

  it.each<ShellName>(['zsh', 'bash', 'sh'])('runs commands with %s', async (shell) => {
    expect(await sh('echo "hello $((6 * 7))"', shell)).toEqual({ code: 0, out: 'hello 42' });
  });

  it('runs common command-line tools', async () => {
    const result = await sh('ls / >/dev/null && date >/dev/null && uname -s && whoami >/dev/null && sw_vers -productName');
    expect(result.code).toBe(0);
    expect(result.out).toContain('Darwin');
  });

  it('reads and writes inside the project', async () => {
    expect(await sh('mkdir -p a/b && echo data > a/b/f.txt && cat a/b/f.txt && mv a/b/f.txt g.txt && rm -r a && ls')).toEqual({ code: 0, out: 'data\ng.txt' });
    expect(await readFile(path.join(project, 'g.txt'), 'utf8')).toBe('data\n');
  });

  it('cannot read files outside the project', async () => {
    for (const [target, content] of [
      [path.join(outside, 'secret.txt'), 'outside-secret'],
      [homeSecret, 'home-secret'],
    ] as const) {
      const result = await sh(`cat '${target}'`);
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/Operation not permitted/i);
      expect(result.out).not.toContain(content);
    }
  });

  it('cannot list the home directory or other user data', async () => {
    for (const dir of ['~', '~/Documents', '~/Library', '/Volumes', '/private/tmp']) {
      const result = await sh(`ls ${dir}`);
      expect(result.code, `ls ${dir}: ${result.out}`).not.toBe(0);
    }
  });

  it('cannot write outside the project', async () => {
    for (const target of [path.join(outside, 'new.txt'), path.join(homedir(), `mcpclaude-escape-${process.pid}.txt`), `/tmp/mcpclaude-escape-${process.pid}.txt`]) {
      const result = await sh(`echo x > '${target}'`);
      expect(result.code, result.out).not.toBe(0);
      await expect(readFile(target)).rejects.toThrow();
    }
  });

  it('cannot escape through a symlink', async () => {
    const result = await sh(`ln -s '${outside}' link && cat link/secret.txt; echo x > link/planted.txt`);
    expect(result.out).not.toContain('outside-secret');
    await expect(readFile(path.join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('cannot remove or rename the project root', async () => {
    expect((await sh(`mv '${project}' '${project}-moved'`)).code).not.toBe(0);
    expect((await sh(`cd / && rmdir '${project}' 2>/dev/null; rm -rf '${project}'`)).code).not.toBe(0);
    await expect(realpath(project)).resolves.toBe(project);
  });

  it('provides a private, writable temporary directory', async () => {
    const scratch = path.join(root, 'state', 'sandbox', 'tmp');
    const result = await sh('f=$(mktemp) && echo tmp > "$f" && cat "$f" && rm "$f" && echo "$TMPDIR"');
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('tmp\n');
    expect(result.out).toContain(scratch);
    // mktemp in its common spellings lands in the private directory, not the shared one.
    for (const form of ['mktemp', 'mktemp -d', 'mktemp -t build', 'mktemp -dt build', 'mktemp -q', `mktemp "$TMPDIR/custom.XXXXXX"`]) {
      const made = await sh(`p=$(${form}) && echo "$p" && rm -rf "$p"`);
      expect(made.code, `${form}: ${made.out}`).toBe(0);
      expect(made.out, form).toContain(scratch);
    }
  });

  it('builds and runs native code', async () => {
    const c = await sh(`printf '#include <stdio.h>\\nint main(void){puts("c-ok");return 0;}\\n' > hello.c && cc hello.c -o hello && ./hello`);
    expect(c, c.out).toEqual({ code: 0, out: 'c-ok' });
    const make = await sh(`printf 'all:\\n\\t@echo make-ok\\n' > Makefile && make`);
    expect(make, make.out).toEqual({ code: 0, out: 'make-ok' });
  });

  it('runs the usual scripting and archive tools', async () => {
    const result = await sh(
      [
        'ruby -e "puts 6*7"',
        'perl -e "print 6*7, qq(\\n)"',
        'echo hi > t.txt && tar czf t.tgz t.txt && tar tzf t.tgz',
        'zip -q t.zip t.txt && unzip -l t.zip | grep -c t.txt',
        'sed -i "" s/hi/ho/ t.txt && cat t.txt',
        'find . -name "t.*" | sort | head -3 | wc -l | tr -d " "',
        'awk "BEGIN{print 6*7}"',
      ].join(' && '),
    );
    expect(result.code, result.out).toBe(0);
    expect(result.out.split('\n')).toEqual(['42', '42', 't.txt', '1', 'ho', '3', '42']);
  });

  it('runs Node.js, confined like everything else', async () => {
    expect(await sh('node -e "console.log(require(\'os\').platform(), 6*7)"')).toEqual({ code: 0, out: 'darwin 42' });
    const script = `const fs=require('fs');fs.writeFileSync('n.txt','ok');try{console.log(fs.readFileSync('${path.join(outside, 'secret.txt')}','utf8'))}catch(e){console.log(e.code)}`;
    expect(await sh(`node -e "${script}" && cat n.txt`)).toEqual({ code: 0, out: 'EPERM\nok' });
  });

  it('runs git', async () => {
    const result = await sh('git init -q repo && cd repo && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m first && git log --oneline | wc -l');
    expect(result.code, result.out).toBe(0);
    expect(result.out.trim()).toBe('1');
  });

  it('runs Python', async () => {
    expect(await sh('python3 -c "import tempfile,os; d=tempfile.mkdtemp(); print(6*7, os.path.isdir(d))"')).toEqual({ code: 0, out: '42 True' });
  });

  it('reaches the network (DNS, TLS) and can serve on localhost', async () => {
    const curl = await sh('curl -sS -o /dev/null -w "%{http_code}" --max-time 30 https://registry.npmjs.org/-/ping');
    expect(curl, curl.out).toEqual({ code: 0, out: '200' });
    const server = `const h=require('http');const s=h.createServer((q,r)=>r.end('served'));s.listen(0,'127.0.0.1',()=>{h.get('http://127.0.0.1:'+s.address().port,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{console.log(b);s.close()})})})`;
    expect(await sh(`node -e "${server}"`)).toEqual({ code: 0, out: 'served' });
  });

  it('installs an npm package using the redirected cache', async () => {
    const result = await sh('mkdir -p pkg && cd pkg && npm init -y >/dev/null && npm install --no-audit --no-fund is-number@7.0.0 2>&1 | tail -3 && node -e "console.log(require(\'is-number\')(5))"');
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('true');
  }, 180_000);

  it('cannot drive other applications or the desktop', async () => {
    const attempts = [
      `osascript -e 'tell application "Finder" to get name of home'`,
      'open -a TextEdit',
      'screencapture -x "$TMPDIR/shot.png"',
      'pbpaste',
      'defaults read com.apple.finder',
      'launchctl submit -l com.example.mcpclaude.escape -- /usr/bin/true',
    ];
    for (const attempt of attempts) {
      const result = await sh(attempt);
      expect(result.code, `${attempt}: ${result.out}`).not.toBe(0);
    }
  });

  it('cannot signal processes outside the sandbox', async () => {
    const result = await sh(`kill -0 ${process.pid}`);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/not permitted/i);
  });

  it('does not expose the ssh agent or mcpclaude secrets to commands', async () => {
    const env = runtime.commandEnv();
    expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    const result = await sh('echo "agent=[${SSH_AUTH_SOCK:-}] cache=[$npm_config_cache]"');
    expect(result.out).toContain('agent=[]');
    expect(result.out).toContain(path.join(root, 'state', 'sandbox', 'cache', 'npm'));
  });
});
