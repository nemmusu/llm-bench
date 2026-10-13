import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { saveServerDraft, type ServerDraft } from './server-flow';

/**
 * Opens "Avvia un server" with these choices already made: every start of a server, from any page
 * ("Avvia solo il server", "Avvia il server così", "Avvia server", a preset's "Modifica"), goes there.
 */
export function useOpenServerFlow(): (draft: ServerDraft) => void {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (draft) => {
    saveServerDraft(qc, draft);
    void navigate({ to: '/servers/new' });
  };
}
