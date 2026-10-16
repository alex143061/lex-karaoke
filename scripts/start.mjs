import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

if (!existsSync('.next/BUILD_ID')) {
  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
  if (build.status !== 0) process.exit(build.status || 1);
}

const server = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', 'server.ts'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));