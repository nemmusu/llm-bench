import { ExternalLink } from 'lucide-react';
import type { EngineUpdateCheck } from '../../../contract/engine-updates';
import { NINFER_UPGRADE_DOC } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { CodeBlock } from '../ui/code-block';

/**
 * NInfer's part of "Aggiorna": the library models in an older container version than this build reads,
 * each with NInfer's own upgrade command to copy (it writes a new file next to the old one) and its guide.
 */
export function NinferArtifacts({ check, where }: { check: EngineUpdateCheck; where: string }) {
  const { t } = useI18n();
  const n = check.ninfer;
  if (!n || n.artifacts.length === 0) return null;
  return (
    <Callout tone="warning" title={t('ninfer.artifacts.title')}>
      <div className="flex flex-col gap-2">
        <p>{t('ninfer.artifacts.body', { needs: n.containerVersion, where })}</p>
        {n.artifacts.map((a) => (
          <div key={a.id} className="flex flex-col gap-1">
            <p className="font-medium text-fg">{t('ninfer.artifacts.item', { name: a.name, version: a.version })}</p>
            {a.command ? (
              <CodeBlock single commands={{ bash: a.command, powershell: a.command }} defaultShell="bash" label={t('ninfer.artifacts.command')} />
            ) : (
              <p className="text-fg-2">{t('ninfer.artifacts.noTool')}</p>
            )}
          </div>
        ))}
        <Button size="sm" variant="link" className="self-start" onClick={() => void window.gpubench?.openExternal(NINFER_UPGRADE_DOC)}>
          <ExternalLink aria-hidden />
          {t('ninfer.artifacts.doc')}
        </Button>
      </div>
    </Callout>
  );
}
