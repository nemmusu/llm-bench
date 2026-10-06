import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './app';
import { resolveConnection } from './lib/connection';
import { createApiClient } from './lib/api';

/** Finds the core (Electron bridge or ?token= in browser mode) and mounts the app. */
export async function boot(doc: Document = document): Promise<void> {
  const conn = await resolveConnection();
  const api = createApiClient(conn);
  const root = doc.getElementById('root');
  if (!root) throw new Error('#root missing');
  createRoot(root).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>,
  );
}

void boot();
