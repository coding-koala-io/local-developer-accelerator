export async function launchTui(engine, {showBranding} = {}) {
  const [{render}, {default: React}, {App}] = await Promise.all([import('ink'), import('react'), import('./app.js')]);
  const app = render(React.createElement(App, {engine, showBranding})); await app.waitUntilExit();
}
