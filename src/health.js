// ok = HTTP 2xx and (product absent OR product === expected). Older (legacy) module builds
// answer /health without a product field; they are reported healthy with legacy: true.
export async function checkHealth(port, {fetcher = fetch, timeout = 1000, expectedProduct, now = Date.now} = {}) {
  const start = now();
  try {
    const res = await fetcher(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(timeout), redirect: 'error'});
    const raw = await res.json(), latency = now() - start;
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const legacy = body.product === undefined || body.product === null || body.product === '';
    const matches = legacy || !expectedProduct || body.product === expectedProduct;
    const ok = res.ok && res.status >= 200 && res.status < 300 && matches;
    return {...body, ok, legacy, latency, message: !matches ? `Expected product ${expectedProduct}; received ${body.product}` : !ok ? `HTTP ${res.status}` : undefined};
  } catch (e) { return {ok: false, latency: now() - start, message: e.message}; }
}
