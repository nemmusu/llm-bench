/**
 * "I tuoi preset" on the Server page: each saved preset with its model, engine, configuration in
 * words, port and network, "Avvia all'apertura di LLM Bench", and Avvia / Modifica / Elimina.
 */
import { Globe, Pencil, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { CustomEngineInfo } from '../../../contract/custom-engines';
import type { ServerPreset } from '../../../contract/servers';
import { useI18n } from '../../i18n';
import { apiErrorData } from '../../lib/queries-runs';
import { usePresetMutations } from '../../lib/queries-servers';
import { useConfigLabel } from '../presets/config-label';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { ConfirmDialog } from '../ui/dialog';
import { Switch } from '../ui/switch';
import { engineNameOf } from './engine-name';

export interface PresetsListProps {
  presets: readonly ServerPreset[];
  /** Presets whose server is on (by preset id). */
  running: ReadonlySet<string>;
  customs: readonly CustomEngineInfo[];
  onStart: (p: ServerPreset) => void;
  onEdit: (p: ServerPreset) => void;
}

function PresetRow({ p, running, customs, onStart, onEdit, onRemove }: { p: ServerPreset; running: boolean; customs: readonly CustomEngineInfo[]; onStart: () => void; onEdit: () => void; onRemove: () => void }) {
  const f = useI18n();
  const { t } = f;
  const configLabel = useConfigLabel();
  const { update } = usePresetMutations();
  const toggle = (autoStart: boolean) =>
    update.mutate(
      { id: p.id, patch: { autoStart } },
      {
        onSuccess: () => toast.success(t(autoStart ? 'servers.presets.autoStartOn' : 'servers.presets.autoStartOff', { name: p.name })),
        onError: (e) => toast.error(t(`errors.${apiErrorData(e).code}.title`)),
      },
    );
  const switchId = `autostart-${p.id}`;
  return (
    <li className="flex flex-col gap-3 px-card py-4 @3xl/page:flex-row @3xl/page:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-md font-semibold text-fg" title={p.name}>
            {p.name}
          </h3>
          {running && (
            <Badge tone="success" size="sm" dot>
              {t('servers.presets.running')}
            </Badge>
          )}
          <Badge tone="neutral" size="sm">
            {p.port !== undefined ? t('servers.presets.port', { port: p.port }) : t('servers.presets.portAuto')}
          </Badge>
          {p.network === 'lan' && (
            <Badge tone="info" size="sm">
              <Globe aria-hidden />
              {t('servers.card.lan')}
            </Badge>
          )}
        </div>
        <p className="truncate text-sm text-fg-2" title={`${p.modelLabel} · ${engineNameOf(p.engine, customs, f)}`}>
          {p.modelLabel} · {engineNameOf(p.engine, customs, f)}
        </p>
        <p className="text-xs text-fg-3">
          {configLabel(p.params, p.engine.kind).text}
          {p.source && ` · ${t(`servers.presets.source.${p.source.kind}`)}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Switch id={switchId} checked={p.autoStart} onCheckedChange={toggle} aria-label={t('servers.presets.autoStartNamed', { name: p.name })} />
          <label htmlFor={switchId} className="text-sm text-fg-2">
            {t('servers.presets.autoStart')}
          </label>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="primary" disabled={running} onClick={onStart} aria-label={t('servers.presets.startNamed', { name: p.name })}>
            <Play aria-hidden className="fill-current" />
            {t('servers.presets.start')}
          </Button>
          <IconButton size="sm" label={t('servers.presets.editNamed', { name: p.name })} icon={<Pencil />} onClick={onEdit} />
          <IconButton size="sm" label={t('servers.presets.removeNamed', { name: p.name })} icon={<Trash2 />} onClick={onRemove} />
        </div>
      </div>
    </li>
  );
}

export function PresetsList({ presets, running, customs, onStart, onEdit }: PresetsListProps) {
  const { t } = useI18n();
  const { remove } = usePresetMutations();
  const [target, setTarget] = useState<ServerPreset | undefined>(undefined);
  return (
    <>
      <ul className="divide-y divide-border" aria-label={t('servers.presets.title')}>
        {presets.map((p) => (
          <PresetRow key={p.id} p={p} running={running.has(p.id)} customs={customs} onStart={() => onStart(p)} onEdit={() => onEdit(p)} onRemove={() => setTarget(p)} />
        ))}
      </ul>
      <ConfirmDialog
        open={target !== undefined}
        // Only ever asked to close (Annulla, Escape, or after the confirmation).
        onOpenChange={() => setTarget(undefined)}
        title={t('servers.presets.removeTitle', { name: target?.name ?? '' })}
        description={t('servers.presets.removeBody')}
        confirmLabel={t('servers.presets.remove')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          const p = target!;
          remove.mutate(p.id, {
            onSuccess: () => toast.success(t('servers.presets.removed', { name: p.name })),
            onError: (e) => toast.error(t(`errors.${apiErrorData(e).code}.title`)),
          });
          setTarget(undefined);
        }}
      />
    </>
  );
}
