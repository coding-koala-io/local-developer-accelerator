import React, {useEffect, useState, useRef} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {catalog, suite, version} from '../catalog.js';
import isUnicodeSupported from 'is-unicode-supported';
const h = React.createElement;
export function App({engine, refreshMs = 2000, fullRefreshMs = 30000}) {
  const [rows, setRows] = useState([]), [index, setIndex] = useState(0), [message, setMessage] = useState('Loading…'), [busy, setBusy] = useState(false), [help, setHelp] = useState(false), [tail, setTail] = useState(false), [logs, setLogs] = useState(''), [all, setAll] = useState(false);
  const {exit} = useApp(), selected = rows[index], mod = catalog[index];
  const confirmation = useRef(null), [question, setQuestion] = useState('');
  const rich = !('NO_COLOR' in process.env), unicode = rich && isUnicodeSupported();
  const sep = unicode ? ' · ' : ' | ', display = text => unicode ? text : text.replace(/[—–]/g, '-').replaceAll('…', '...').replaceAll('·', '|').replaceAll('↑/↓', 'Up/Down');
  const ask = text => new Promise(resolve => {confirmation.current = resolve; setQuestion(text);});
  useEffect(() => () => {confirmation.current?.(false);}, []);
  useEffect(() => {
    // Health only every refreshMs; the full service/XML query at most every fullRefreshMs (and after actions).
    let alive = true, refreshing = false, lastFull = 0;
    const refresh = async () => {
      if (refreshing) return; refreshing = true;
      try {
        const full = !engine.quickStatus || Date.now() - lastFull >= fullRefreshMs;
        const r = full ? await engine.status() : await engine.quickStatus(); if (full) lastFull = Date.now();
        if (alive) {setRows(r); setMessage(m => m === 'Loading…' ? 'Ready' : m);}
      } catch (e) {if (alive) setMessage(e.message);} finally {refreshing = false;}
    };
    refresh(); const timer = setInterval(refresh, refreshMs), unsub = engine.subscribe?.(m => {if (alive) setMessage(typeof m === 'string' ? m : `Downloading ${m.file}: ${m.received} bytes`);});
    return () => {alive = false; clearInterval(timer); unsub?.();};
  }, [engine, refreshMs, fullRefreshMs]);
  useEffect(() => {
    if (!tail) return; let alive = true;
    const refresh = async () => {try {const value = await engine.logs(mod.key, {lines: 12}); if (alive) setLogs(value);} catch (e) {if (alive) setLogs(e.message);}};
    refresh(); const timer = setInterval(refresh, 1000); return () => {alive = false; clearInterval(timer);};
  }, [engine, tail, mod]);
  useInput((input, key) => {
    if (confirmation.current) {if (['y', 'n', 'q'].includes(input.toLowerCase())) {const resolve = confirmation.current; confirmation.current = null; setQuestion(''); resolve(input.toLowerCase() === 'y');} return;}
    if (input === 'q') {exit(); return;}
    if (busy) return;
    if (key.upArrow) {setIndex(i => Math.max(0, i - 1)); setTail(false); return;}
    if (key.downArrow) {setIndex(i => Math.min(catalog.length - 1, i + 1)); setTail(false); return;}
    if (input === '?') {setHelp(x => !x); return;}
    if (input === 'l') {setTail(x => !x); return;}
    if (input === 'a') {setAll(x => !x); return;}
    if (!['o', 's', 'r', 'i', 'u'].includes(input) || !selected) return;
    const execute = async () => {
      setBusy(true);
      try {
        if (input === 'o') await engine.open(mod.key);
        else {
          const action = input === 's' ? selected.serviceState === 'running' || selected.state === 'running' ? 'stop' : 'start' : input === 'r' ? 'restart' : input === 'i' ? 'install' : 'upgrade';
          if (input === 'u') {setMessage('Checking for updates…'); const checked = await engine.status({checkUpdates: true}); setRows(checked); if (!all && !checked[index]?.update) {setMessage('No update available'); return;}}
          setMessage('Waiting for Windows approval…');
          const keys = all ? catalog.filter(m => action === 'install' ? !rows.find(r => r.module === m.key)?.installed : rows.find(r => r.module === m.key)?.installed).map(m => m.key) : [mod.key];
          if (!keys.length) {setMessage('No modules selected for this action.'); return;}
          const result = await engine.act(action, keys, {confirm: ask});
          setMessage(result.ok ? `${unicode ? '✔' : '[OK]'} Completed` : `${unicode ? '✖' : '[FAIL]'} ${result.log?.join('; ') || 'Operation failed'}`);
          setRows(await engine.status());
        }
      } catch (e) {setMessage(e.exitCode === 2 ? e.message : `${unicode ? '✖' : '[FAIL]'} ${e.message}`);} finally {setBusy(false);}
    }; void execute();
  });
  return h(Box, {flexDirection: 'column'}, h(Text, {bold: true}, `${suite}${sep}lda ${version}`), h(Text, {dimColor: rich}, display('Development use only — not for production · by Coding Koala')),
    h(Box, {marginTop: 1, flexDirection: 'row'}, h(Box, {flexDirection: 'column', width: 32, marginRight: 2}, ...catalog.map((m, i) => {const r = rows.find(r => r.module === m.key); return h(Text, {key: m.key, inverse: i === index}, `${i === index ? '>' : ' '} ${unicode ? r?.health?.ok ? '●' : r?.installed ? '○' : '·' : '*'} ${m.runtimeFolder}  ${r?.version || '-'}${r?.update ? unicode ? ' ↑' : ' (update)' : ''}`);})),
      h(Box, {flexDirection: 'column'}, h(Text, {bold: true}, mod.product), h(Text, null, display(`State: ${selected?.state || 'loading'}${selected?.legacy ? ' — run lda adopt' : ''}`)), h(Text, null, `Port: ${selected?.port || mod.port}   Version: ${selected?.version || '-'}`), h(Text, null, `Health: ${selected?.health?.ok ? `ok ${selected.health.latency}ms` : 'down'}${selected?.health?.uptime !== undefined ? `   Uptime: ${selected.health.uptime}s` : ''}`), h(Text, null, selected?.dashboard || ''), h(Text, null, display(`o open · ${selected?.serviceState === 'running' || selected?.state === 'running' ? 's stop' : 's start'} · r restart`)), h(Text, null, display(`${!selected?.installed ? 'i install · ' : selected?.update ? 'u upgrade · ' : 'u check updates · '}l logs · a act on all · q quit · ? help`)))),
    help && h(Text, null, display('↑/↓ select module. a toggles all-module actions. Windows approval is required for service changes. Back up data before upgrading.')),
    tail && h(Box, {marginTop: 1}, h(Text, null, logs || 'Waiting for logs…')),
    question && h(Text, {bold: true}, question),
    h(Box, {marginTop: 1}, h(Text, {color: busy && rich ? 'yellow' : undefined}, display(`${all ? '[ALL] ' : ''}${message}`))));
}
