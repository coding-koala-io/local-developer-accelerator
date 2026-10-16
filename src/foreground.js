import {spawn as defaultSpawn} from 'node:child_process';
import path from 'node:path';
export function initializeRuntime(code, root, port, {spawn = defaultSpawn} = {}) {
  const p = /^[A-Za-z]:[\\/]|^\\\\/.test(code) ? path.win32 : path;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [p.join(code, 'scripts', 'service-xml.js'), 'init'], {cwd: code, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    let error = ''; child.stdout.resume(); child.stderr.setEncoding('utf8'); child.stderr.on('data', s => {error += s;});
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Cannot initialize foreground tenants: ${error || 'module init failed'}. Check the release's service-xml.js.`)));
    child.stdin.on('error', reject); child.stdin.end(JSON.stringify({runtimeRoot: root, port}));
  });
}
