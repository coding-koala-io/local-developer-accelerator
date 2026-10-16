import {suite, version} from './catalog.js';
export function firstRunNotice(dataRoot) {
  return `${suite} - development and research use only. Never use in production.\n- Local stand-ins; not a replacement for Optimizely services. Behaviour differs.\n- Runs on this machine only. Do not expose it to a network.\n- Stores copies of your CMS content (including drafts) in ${dataRoot}.\n- No telemetry. Provided as is, without warranty. Licence: BSL 1.1. Privacy: PRIVACY.md\n- Not affiliated with or endorsed by Optimizely.`;
}
export const trayNotice = data => `${suite} ${version}\nFor development and research only - not for production.\nNo telemetry. Data stays on this computer: ${data}\nProvided as is, without warranty.\nIndependent project; not affiliated with or endorsed by Optimizely.\nOptimizely® is a trademark of Optimizely North America Inc.\nLicence | Privacy | Open data folder`;
export async function ensureNotice({config, paths, accept = false, env = process.env, tty = false, nonInteractive = false, prompt, print = console.log}) {
  const c = await config.read(), major = Number(version.split('.')[0]);
  if (c.noticeAcceptedMajor === major) return;
  print(firstRunNotice(paths.data));
  if (!accept && env.LDA_ACCEPT_NOTICE !== '1' && !(tty && !nonInteractive && !env.CI && /^y$/i.test(await prompt('Continue? [y/N] ')))) throw new Error('Notice not accepted. Read lda about, then pass --accept-notice (or LDA_ACCEPT_NOTICE=1) to continue.');
  c.noticeAcceptedMajor = major; await config.save(c);
}
