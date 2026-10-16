/* THESIS: A local operations panel: two modules, their actual state, direct actions.
 * OWN-WORLD: Spec-pinned light system UI; white surfaces, slate text, green status.
 * STORY: Inspect health, open a module, or request a service operation with Windows approval.
 * FIRST VIEWPORT: Development notice, title, responsive module cards, action/result area.
 * FORM: Catalogue-driven cards required by SPEC-CLI-V1, with semantic controls and live status. */
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {catalog, suite, version} from './catalog.js';
import {doctor as runDoctor} from './doctor.js';
const running = r => r?.serviceState === 'running' || r?.state === 'running';
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export function renderHub(rows, {token, nonce = token, lastUpdateCheck} = {}) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LDA — Local Developer Accelerator</title>
<style nonce="${nonce}">
[hidden]{display:none!important}:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#172b35;background:#f2f5f6;font-size:16px;--accent:#176143;--line:#d4dde1}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:32px 24px}header{margin:0 0 32px}h1{font-size:clamp(1.5rem,4vw,2.2rem);line-height:1.2;margin:12px 0}h2{font-size:1.25rem;margin:0 0 8px}p{max-width:72ch;line-height:1.6}a{color:#125c83}a:hover{text-decoration-thickness:2px}.notice{background:#e5efea;color:#214835;padding:14px 24px;font-size:.9rem;line-height:1.5}.modules{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:24px}.module{background:#fff;border:1px solid var(--line);border-radius:12px;padding:24px}.compat{font-size:.9rem;color:#465d67;margin:0 0 20px}.state{font-weight:650;color:var(--accent)}dl{display:grid;grid-template-columns:100px 1fr;gap:10px;margin:20px 0}dt{color:#465d67}dd{margin:0;overflow-wrap:anywhere}button,.button{font:inherit;min-height:44px;padding:10px 14px;border:1px solid #98aab2;border-radius:6px;background:#fff;color:#203a46;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}button:hover,.button:hover{background:#eef3f5}button:disabled{opacity:.55;cursor:wait}button:focus-visible,a:focus-visible{outline:3px solid #1367a3;outline-offset:3px}.primary{background:var(--accent);border-color:var(--accent);color:white}.primary:hover{background:#124c35}.actions{display:flex;flex-wrap:wrap;gap:8px}.badge{font-size:.8rem;background:#fff1cc;color:#674700;padding:4px 7px;border-radius:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#172b35;color:#f2f6f7;padding:16px;border-radius:6px;max-height:320px;overflow:auto;font-size:.85rem;line-height:1.5}pre:empty{display:none}#feedback{min-height:1.6em;margin:24px 0 8px;font-weight:600}footer{margin-top:32px;border-top:1px solid var(--line);padding-top:24px;font-size:.9rem;color:#465d67}.footer-actions{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}footer nav{display:flex;flex-wrap:wrap;gap:16px}.brand{font-size:.9rem;color:#465d67} @media(max-width:480px){main{padding:24px 16px}.module{padding:20px}.notice{padding:12px 16px}}
</style><div class="notice">Development and research use only — never production. Independent project; not affiliated with or endorsed by Optimizely. Keep services on this machine.</div>
<main><header><span class="brand">by Coding Koala</span><h1>${suite}</h1><p>Manage the local services for your development site.</p></header><section class="modules" aria-label="Modules">${catalog.map(mod => {
    const r = rows.find(r => r.module === mod.key) || {state: 'not installed', port: mod.port};
    const actions = ['start', 'stop', 'restart', 'upgrade', 'install'];
    return `<article class="module" id="${mod.key}"><h2>${mod.product}</h2><p class="compat">Compatible with ${mod.compatibleWith}</p><span class="state" data-state>${escape(r.state)}</span> <span class="badge" data-update ${r.update ? '' : 'hidden'}>Update available</span><p data-legacy ${r.legacy ? '' : 'hidden'}>Legacy install — run <code>lda adopt ${mod.key}</code> to keep your data and port.</p><dl><dt>Version</dt><dd data-version>${escape(r.version || '—')}</dd><dt>Port</dt><dd data-port>${escape(r.port)}</dd><dt>Health</dt><dd data-health>${r.health?.ok ? `ok ${r.health.latency}ms` : r.installed ? 'down' : '—'}</dd><dt>Checked</dt><dd data-time>${escape(new Date().toLocaleTimeString())}</dd></dl><div class="actions"><a class="button primary" data-dashboard href="http://localhost:${Number(r.port)}/" target="_blank" rel="noopener">Open dashboard</a>${actions.map(a => `<button data-action="${a}" data-module="${mod.key}" ${(r.installed ? a === 'install' : a !== 'install') || r.legacy || (a === 'start' && running(r)) ? 'hidden' : ''}>${a[0].toUpperCase() + a.slice(1)}</button>`).join('')}<button data-action="logs" data-module="${mod.key}" aria-expanded="false">Logs</button></div><pre data-logs hidden aria-label="${mod.product} logs"></pre></article>`;
  }).join('')}</section><p id="feedback" role="status" aria-live="polite"></p><pre id="results" tabindex="0" aria-label="Operation results"></pre><footer>CLI ${version} · Last update check: <span id="last-check">${escape(lastUpdateCheck || 'not checked')}</span><div class="footer-actions"><button data-action="check-updates">Check for updates now</button><button data-action="doctor">Run doctor</button></div><nav aria-label="Legal"><a href="/about">About</a><a href="/privacy">Privacy</a><a href="/licence">Licence</a><a href="/legal">Legal notice</a></nav><p>No telemetry — nothing leaves this machine except update checks you ask for.</p><p>Installing or upgrading also downloads the requested release and may download WinSW. Optimizely® is a trademark of Optimizely North America Inc. No warranty.</p></footer></main>
<script nonce="${nonce}">
const csrf=${JSON.stringify(token)},feedback=document.querySelector('#feedback'),results=document.querySelector('#results');let busy=false;const tails=new Set();
async function refresh(full=true){try{const response=await fetch(full?'/api/status':'/api/health');if(!response.ok)throw Error('Status unavailable');const rows=await response.json();for(const r of rows){const running=r.serviceState==='running'||r.state==='running';const el=document.getElementById(r.module);el.querySelector('[data-state]').textContent=r.state;el.querySelector('[data-version]').textContent=r.version||'—';el.querySelector('[data-port]').textContent=r.port;el.querySelector('[data-health]').textContent=r.health?.ok?'ok '+r.health.latency+'ms':r.installed?'down':'—';el.querySelector('[data-time]').textContent=new Date().toLocaleTimeString();el.querySelector('[data-update]').hidden=!r.update;el.querySelector('[data-dashboard]').href=r.dashboard;el.querySelector('[data-legacy]').hidden=!r.legacy;for(const b of el.querySelectorAll('button[data-action]')){if(b.dataset.action!=='logs')b.hidden=!!r.legacy||(r.installed?b.dataset.action==='install':b.dataset.action!=='install')||(b.dataset.action==='start'&&running);}}}catch(e){feedback.textContent=e.message+'; refresh this page to retry.';}}
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-action]');if(!b||busy)return;const action=b.dataset.action,module=b.dataset.module;if(action==='logs'){const p=document.getElementById(module).querySelector('[data-logs]');p.hidden=!p.hidden;b.setAttribute('aria-expanded',String(!p.hidden));if(p.hidden)tails.delete(module);else{tails.add(module);await tail(module);}return;}if(action==='upgrade'&&!confirm('Back up the module runtime folder before upgrading. A data version change may prevent rollback. Continue?'))return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);feedback.textContent=['install','start','stop','restart','upgrade'].includes(action)?'Waiting for Windows approval…':'Working…';try{const response=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-LDA-CSRF':csrf},body:JSON.stringify({module,confirmed:action==='upgrade'})});const data=await response.json();if(!response.ok||data.ok===false)throw Error(data.message||data.log?.join('\\n')||'Operation failed; run lda doctor.');feedback.textContent='Completed';results.textContent=JSON.stringify(data,null,2);if(action==='check-updates')document.querySelector('#last-check').textContent=new Date().toLocaleString();await refresh();}catch(e){feedback.textContent=e.message;}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}});
async function tail(module){try{const r=await fetch('/api/logs?module='+encodeURIComponent(module));const data=await r.json();document.getElementById(module).querySelector('[data-logs]').textContent=data.logs||data.message;}catch{feedback.textContent='Logs unavailable. Use lda logs '+module;}}
setInterval(()=>refresh(false),3000);setInterval(()=>refresh(true),30000);setInterval(()=>tails.forEach(tail),1000);
</script></html>`;
}
export async function startHub({engine, port = 8080, doctor = runDoctor} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Hub port must be from 1 to 65535.');
  const token = randomBytes(32).toString('hex'), nonce = randomBytes(24).toString('hex'); let active = false;
  const server = http.createServer(async (req, res) => {
    const actualPort = server.address().port, hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    const json = (status, value) => {res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value));};
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`))) return json(403, {ok: false, message: 'Invalid Host or Origin.'});
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET') {
        if (url.pathname === '/') {res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); return res.end(renderHub(await engine.status(), {token, nonce, lastUpdateCheck: engine.lastUpdateCheck}));}
        if (url.pathname === '/api/status') return json(200, await engine.status());
        if (url.pathname === '/api/health') return json(200, await (engine.quickStatus || engine.status)());
        if (url.pathname === '/api/logs') return json(200, {logs: await engine.logs(url.searchParams.get('module'), {lines: 50})});
        const pages = {about: 'LEGAL-NOTICE.md', privacy: 'PRIVACY.md', licence: 'LICENSE.md', legal: 'LEGAL-NOTICE.md'};
        const file = pages[url.pathname.slice(1)];
        if (file) {res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'}); return res.end(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));}
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return json(404, {ok: false, message: 'Not found.'});
      if (!req.headers.origin || req.headers['x-lda-csrf'] !== token || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(403, {ok: false, message: 'CSRF token, local Origin and JSON required.'});
      let raw = '', size = 0; for await (const c of req) {size += c.length; if (size > 16384) return json(413, {ok: false, message: 'Request too large.'}); raw += c;}
      const body = JSON.parse(raw || '{}'), action = url.pathname.slice(5);
      if (active) return json(409, {ok: false, message: 'An operation is running. Wait for it to finish.'});
      active = true;
      try {
        if (action === 'check-updates') {const rows = await engine.status({checkUpdates: true, fresh: true}); await engine.writeTray(rows); return json(200, {ok: true, modules: rows});}
        if (action === 'doctor') return json(200, {ok: true, checks: await doctor(engine)});
        if (!['start', 'stop', 'restart', 'install', 'upgrade'].includes(action) || !catalog.some(m => m.key === body.module)) return json(400, {ok: false, message: 'Unknown action or module.'});
        return json(200, await engine.act(action, [body.module], {yes: body.confirmed === true}));
      } finally {active = false;}
    } catch (e) {json(e instanceof SyntaxError ? 400 : 500, {ok: false, message: e.message});}
  });
  await new Promise((resolve, reject) => {server.once('error', e => reject(new Error(`Hub port ${port} unavailable (${e.code}). Use lda hub --port <free-port>.`))); server.listen(port, '127.0.0.1', resolve);});
  return {server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()))};
}
