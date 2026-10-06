import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './app';
import { resolveConnection } from './lib/connection';
import { createApiClient } from './lib/api';

async function boot() {
  const conn = await resolveConnection();
  const api = createApiClient(conn);
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  createRoot(root).render(
    <StrictMode>
      <App api={api} />
    </StrictMode>,
  );
}

void boot();
