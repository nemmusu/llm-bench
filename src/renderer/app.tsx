import { useEffect, useState } from 'react';
import type { ApiClient } from './lib/api';
import { I18nProvider, useI18n } from './i18n';

/** Temporary shell: replaced by the design-system shell (sidebar, title bar, routes). */
function Placeholder({ api }: { api: ApiClient }) {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    void api.get<{ version: string }>('/api/health').then((h) => setVersion(h.version));
  }, [api]);
  return (
    <main className="grid h-full place-items-center">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">{t('app.name')}</h1>
        <p>{t('app.tagline')}</p>
        {version && <p aria-label="version">v{version}</p>}
      </div>
    </main>
  );
}

export function App({ api }: { api: ApiClient }) {
  return (
    <I18nProvider lang="it">
      <Placeholder api={api} />
    </I18nProvider>
  );
}
