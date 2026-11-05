// Health replies contain no credentials; don't print the response body to logs.
try {
  await Promise.all([[8082, 'graph'], [8083, 'assets']].map(async ([port, product]) => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(3000), redirect: 'error'});
    if (!response.ok || (await response.json()).product !== product) throw new Error('Service is unhealthy');
  }));
} catch {process.exitCode = 1;}
