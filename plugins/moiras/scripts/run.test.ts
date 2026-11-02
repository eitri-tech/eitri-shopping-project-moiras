import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { checkNodeVersion } from './run.mjs';

const launcher = join(import.meta.dirname, 'run.mjs');
const clis = ['config', 'github', 'knowledge', 'learn-github', 'memory'];
const message = (found: string) => `O Moiras precisa do Node 22.18 ou mais novo (encontrado v${found}).`;

function launch(args: string[], options: { node?: string; input?: string } = {}) {
  return spawnSync(options.node ?? process.execPath, [launcher, ...args], {
    encoding: 'utf8',
    input: options.input ?? '',
    env: process.env,
  });
}

describe('checkNodeVersion', () => {
  it('rejects Node versions below 22.18', () => {
    assert.equal(checkNodeVersion('20.20.2'), message('20.20.2'));
    assert.equal(checkNodeVersion('22.17.9'), message('22.17.9'));
    assert.equal(checkNodeVersion('21.9.0'), message('21.9.0'));
    assert.equal(checkNodeVersion('18.20.0'), message('18.20.0'));
  });

  it('accepts 22.18.0 and newer', () => {
    assert.equal(checkNodeVersion('22.18.0'), null);
    assert.equal(checkNodeVersion('22.18.1'), null);
    assert.equal(checkNodeVersion('24.0.0'), null);
    assert.equal(checkNodeVersion('25.1.0'), null);
  });

  it('rejects a prerelease of 22.18.0, which semver sorts below 22.18.0', () => {
    assert.equal(checkNodeVersion('22.18.0-pre'), message('22.18.0-pre'));
  });

  it('accepts a prerelease of a newer patch', () => {
    assert.equal(checkNodeVersion('22.18.1-rc.1'), null);
  });

  it('says the version is unknown when it is not a version string', () => {
    const unknown = 'O Moiras precisa do Node 22.18 ou mais novo (versão não identificada).';
    assert.equal(checkNodeVersion(null as unknown as string), unknown);
    assert.equal(checkNodeVersion(''), unknown);
    assert.equal(checkNodeVersion('v22.18.0; rm -rf /'), unknown);
  });
});

describe('launcher', () => {
  it('does not stop on the running Node, which the suite already requires to be 22.18 or newer', () => {
    const result = launch(['config']);
    assert.doesNotMatch(result.stderr, /precisa do Node/);
    assert.equal(result.status, 2); // usage of config, not the version error
  });

  it('defaults to the running Node version', () => {
    assert.equal(checkNodeVersion(), null);
  });

  it('answers the same as the direct run when no arguments are given', () => {
    for (const name of clis) {
      const direct = spawnSync(process.execPath, [join(import.meta.dirname, `${name}.ts`)], { encoding: 'utf8', input: '' });
      const viaLauncher = launch([name]);
      assert.equal(viaLauncher.status, direct.status, name);
      assert.equal(viaLauncher.stdout, direct.stdout, name);
      assert.equal(viaLauncher.stderr, direct.stderr, name);
    }
  });

  it('passes arguments and stdin through to the script', () => {
    const input = '{"key":"jira:PROJ-1","content":{"a":1}}';
    const direct = spawnSync(process.execPath, [join(import.meta.dirname, 'memory.ts'), 'hash'], { encoding: 'utf8', input });
    const viaLauncher = launch(['memory', 'hash'], { input });
    assert.equal(viaLauncher.status, 0);
    assert.equal(viaLauncher.stdout, direct.stdout);
    assert.match(viaLauncher.stdout, /^sha256:[0-9a-f]{64}\n$/);
  });

  it('refuses names outside the list, path traversal and library modules', () => {
    for (const name of ['../config', 'config.ts', '/etc/passwd', 'gitignore', 'run', 'nope', '']) {
      const result = launch([name]);
      assert.equal(result.status, 2, name);
      assert.equal(result.stdout, '', name);
      assert.match(result.stderr, /^uso: /, name);
      assert.doesNotMatch(result.stderr, /ERR_|Error|\.\.|passwd/, name);
    }
  });

  it('prints a usage line in Portuguese with no argument', () => {
    const result = launch([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^uso: /);
  });
});

const oldNode = process.env.MOIRAS_TEST_NODE_OLD;

describe('launcher with an old Node binary (MOIRAS_TEST_NODE_OLD)', { skip: oldNode ? false : 'defina MOIRAS_TEST_NODE_OLD com o caminho de um Node < 22.18' }, () => {
  const found = oldNode ? spawnSync(oldNode, ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim() : '';

  for (const name of clis) {
    it(`${name} stops with the version message, not the raw loader error`, () => {
      const result = launch([name, 'check'], { node: oldNode });
      assert.equal(result.status, 2);
      assert.equal(result.stderr, `${message(found)}\n`);
      assert.doesNotMatch(result.stderr, /ERR_UNKNOWN_FILE_EXTENSION/);
    });
  }
});
