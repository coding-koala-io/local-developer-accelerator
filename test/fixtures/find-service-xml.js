// Minimal Local Find release contract for exercising the Windows helper offline.
import assert from 'node:assert/strict';
import {appendFileSync, mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

const {nodePath, repoRoot, runtimeRoot, port, ...extra} = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
assert.deepEqual(extra, {});
for (const dir of [nodePath, repoRoot, runtimeRoot]) assert.ok(path.isAbsolute(dir), dir);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
const dataDir = path.join(runtimeRoot, 'data');

switch (process.argv[2]) {
  case 'init':
    mkdirSync(dataDir, {recursive: true});
    // Observable proof of every init invocation, including reinstall. No tenant file is needed.
    appendFileSync(path.join(dataDir, 'init.log'), 'init\n');
    break;
  case 'xml': {
    const escape = value => String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[char]);
    const server = path.join(repoRoot, 'src', 'server.js');
    const env = {PORT: port, HOST: '127.0.0.1', DATA_ROOT: dataDir, DATA_DIR: dataDir};
    process.stdout.write(`
<service>
  <id>LdaFind</id>
  <name>LDA Local Find</name>
  <description>Fixture description</description>
  <executable>${escape(nodePath)}</executable>
  <arguments>&quot;${escape(server)}&quot;</arguments>
  <workingdirectory>${escape(repoRoot)}</workingdirectory>
  ${Object.entries(env).map(([name, value]) => `<env name="${name}" value="${escape(value)}" />`).join('\n  ')}
  <logpath>${escape(path.join(runtimeRoot, 'service', 'logs'))}</logpath>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
</service>`);
    break;
  }
  default:
    throw new Error('Expected init or xml');
}
