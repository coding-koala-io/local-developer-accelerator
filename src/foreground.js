import {spawn as defaultSpawn} from 'node:child_process';
import path from 'node:path';
// Observe children immediately so failed spawns and early exits stop the group.
export function superviseForeground(children, {signals = process, timeout = 15000} = {}) {
  return new Promise((resolve, reject) => {
    const live = new Set(), listeners = new Map();
    let stopping = false, timer, failure, exitCode = 0;
    const finish = () => {
      if (live.size) return;
      clearTimeout(timer);
      signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
      for (const [child, handlers] of listeners) {
        child.removeListener('exit', handlers.exit); child.removeListener('error', handlers.error);
      }
      if (failure) reject(failure); else resolve(exitCode);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      timer = setTimeout(() => {for (const child of live) child.kill('SIGKILL');}, timeout);
      timer.unref?.();
      for (const child of live) child.kill('SIGTERM');
      finish();
    };
    for (const child of children) {
      if (child.exitCode != null || child.signalCode != null) {
        exitCode ||= child.exitCode || 1;
        continue;
      }
      live.add(child);
      const handlers = {
        exit(code, signal) {
          live.delete(child);
          if (!stopping) exitCode ||= code || 1;
          else if (code) exitCode ||= code;
          if (signal === 'SIGKILL') exitCode ||= 1;
          stop(); finish();
        },
        error(error) {live.delete(child); failure ||= error; stop(); finish();},
      };
      listeners.set(child, handlers);
      child.once('exit', handlers.exit); child.once('error', handlers.error);
    }
    signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
    if (exitCode) stop();
    finish();
  });
}
export function initializeRuntime(code, root, port, {spawn = defaultSpawn} = {}) {
  const p = /^[A-Za-z]:[\\/]|^\\\\/.test(code) ? path.win32 : path;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [p.join(code, 'scripts', 'service-xml.js'), 'init'], {cwd: code, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    let error = ''; child.stdout.resume(); child.stderr.setEncoding('utf8'); child.stderr.on('data', s => {error += s;});
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Cannot initialize foreground tenants: ${error || 'module init failed'}. Check the release's service-xml.js.`)));
    child.stdin.on('error', reject); child.stdin.end(JSON.stringify({runtimeRoot: root, port}));
  });
}
