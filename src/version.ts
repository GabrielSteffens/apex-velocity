declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;
declare const __BUILD_TIME__: string;

/** Build identification, injected by vite.config.ts at build time. */
export const VERSION = {
  version: __APP_VERSION__,
  commit: __GIT_COMMIT__,
  buildTime: __BUILD_TIME__,
  dev: import.meta.env.DEV,
};

/** e.g. "v0.2.0 · f1af690 · 28/09/2026 15:42" (a trailing "+" on the commit = uncommitted local changes). */
export function versionLabel(): string {
  const d = new Date(VERSION.buildTime);
  const when = d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `v${VERSION.version} · ${VERSION.commit} · ${when}${VERSION.dev ? ' · DEV' : ''}`;
}
