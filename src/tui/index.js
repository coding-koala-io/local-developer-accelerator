export async function launchTui(engine) {
  const [{render}, {default: React}, {App}] = await Promise.all([import('ink'), import('react'), import('./app.js')]);
  const app = render(React.createElement(App, {engine})); await app.waitUntilExit();
}
