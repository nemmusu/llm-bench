import { useNavigate } from '@tanstack/react-router';
import { Boxes, Copy, FlaskConical, GitBranch, Pencil, Play, Plus, Terminal, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CUSTOM_ENGINE_TEMPLATES, customEngineConfigOf, type CustomEngine, type CustomEngineBase, type CustomEngineInfo, type CustomEngineTemplate } from '../../../contract/custom-engines';
import { useI18n, type MessageKey } from '../../i18n';
import { useCustomEngines, useDeleteCustomEngine, useDuplicateCustomEngine } from '../../lib/queries-engines';
import { useSettings } from '../../lib/settings';
import { ErrorCallout } from '../library/error-callout';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { ConfirmDialog } from '../ui/dialog';
import { Skeleton } from '../ui/skeleton';
import { CheckView, customEngineWhere, kindText } from './custom-engine-check';
import { CustomEngineDialog } from './custom-engine-dialog';
import { PullButton } from './docker-card';
import { EngineCard } from './engine-card';

const ICONS: Record<CustomEngineBase, ReactNode> = {
  llamacpp: <GitBranch />,
  vllm: <Boxes />,
  sglang: <FlaskConical />,
  'openai-server': <Terminal />,
};

export interface CustomEnginesSectionProps {
  /** Open "Aggiungi motore" from this built-in template (/engines?customTemplate=…). */
  template?: CustomEngineTemplate | undefined;
  /** The model that asked for it, as text. */
  forModel?: string | undefined;
  /** The deep link was used: the page forgets it (closing the dialog never reopens it). */
  onTemplateDone?: () => void;
}

/** What the dialog shows: a new engine (from the deep link: its template and the model that asked), or a saved one. */
type Editing = { kind: 'new'; template?: CustomEngineTemplate | undefined; fromLink?: boolean } | { kind: 'edit'; engine: CustomEngine };

/** "Motori personalizzati": forks and other programs, each a card like the built-in engines. */
export function CustomEnginesSection({ template, forModel, onTemplateDone }: CustomEnginesSectionProps) {
  const { t } = useI18n();
  const list = useCustomEngines();
  const [editing, setEditing] = useState<Editing | undefined>(template ? { kind: 'new', template, fromLink: true } : undefined);
  const engines = list.data ?? [];

  return (
    <section aria-labelledby="custom-engines-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="custom-engines-title" className="text-lg font-semibold tracking-[-0.01em]">
            {t('engines.custom.title')}
          </h2>
          <p className="max-w-3xl text-sm text-fg-2">{t('engines.custom.subtitle')}</p>
        </div>
        <Button variant="primary" onClick={() => setEditing({ kind: 'new' })}>
          <Plus aria-hidden />
          {t('engines.custom.add')}
        </Button>
      </div>
      {list.isError && <ErrorCallout error={list.error} />}
      {list.isPending ? (
        <Skeleton className="h-32" />
      ) : engines.length === 0 ? (
        <Card className="flex flex-col items-start gap-3 border-dashed p-card">
          <div className="flex flex-col gap-1">
            <p className="text-md font-semibold">{t('engines.custom.emptyTitle')}</p>
            <p className="text-sm text-fg-2">{t('engines.custom.emptyBody')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {CUSTOM_ENGINE_TEMPLATES.map((tpl) => (
              <Button key={tpl.id} size="sm" onClick={() => setEditing({ kind: 'new', template: tpl })}>
                <GitBranch aria-hidden />
                {t(`engines.custom.templates.${tpl.id}.short` as MessageKey)}
              </Button>
            ))}
          </div>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {engines.map((info) => (
            <CustomEngineCard key={info.engine.id} info={info} onEdit={() => setEditing({ kind: 'edit', engine: info.engine })} />
          ))}
        </div>
      )}
      <CustomEngineDialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (open) return;
          setEditing(undefined);
          onTemplateDone?.();
        }}
        editing={editing?.kind === 'edit' ? editing.engine : undefined}
        template={editing?.kind === 'new' ? editing.template : undefined}
        // The model's name arrives with the library list: read at every render, not when the dialog opened.
        forModel={editing?.kind === 'new' && editing.fromLink ? forModel : undefined}
      />
    </section>
  );
}

/** One saved engine: what it is, where, whether it runs and what it lacks, and what to do with it. */
function CustomEngineCard({ info, onEdit }: { info: CustomEngineInfo; onEdit: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { update } = useSettings();
  const duplicate = useDuplicateCustomEngine();
  const remove = useDeleteCustomEngine();
  const [confirm, setConfirm] = useState(false);
  const e = info.engine;
  const { status } = info.check;
  const required = info.check.missing.some((m) => m.effect === 'required');
  const lacking = info.check.missing.length > 0;
  // An image not pulled yet (or a file not found) is something to do, not a failure.
  const missingEngine = status.problems[0] === 'ENGINE_NOT_INSTALLED';
  const tone = required || (!status.available && !missingEngine) ? 'danger' : missingEngine || lacking ? 'warning' : 'success';
  const statusText = missingEngine ? t('engines.status.notInstalled') : !status.available ? t('engines.status.broken') : required ? t('engines.custom.check.requiredTitle') : t('engines.status.ready');
  const rules = [...(e.match?.names ?? []), ...(e.match?.quants ?? [])];

  return (
    <EngineCard
      icon={ICONS[e.base]}
      title={e.name}
      description={t(`engines.custom.bases.${e.base}`)}
      // A program of the user's own runs as itself: the badge names the engine a fork is built on.
      badge={
        e.base === 'openai-server' ? undefined : (
          <Badge size="sm" tone="neutral">
            {t('engines.custom.runsAs', { kind: kindText(t, info.kind) })}
          </Badge>
        )
      }
      status={{ tone, text: statusText }}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={!status.available || required}
            onClick={() => {
              update({ lastEngine: customEngineConfigOf(e) });
              void navigate({ to: '/' });
            }}
          >
            <Play aria-hidden />
            {t('engines.custom.useInBenchmark')}
          </Button>
          <Button size="sm" onClick={onEdit}>
            <Pencil aria-hidden />
            {t('engines.custom.edit')}
          </Button>
          <Button
            size="sm"
            disabled={duplicate.isPending}
            onClick={() => duplicate.mutate({ id: e.id, name: t('engines.custom.copyName', { name: e.name }).slice(0, 60) })}
          >
            <Copy aria-hidden />
            {t('engines.custom.duplicate')}
          </Button>
          <Button size="sm" variant="danger-outline" onClick={() => setConfirm(true)}>
            <Trash2 aria-hidden />
            {t('engines.custom.delete')}
          </Button>
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title={t('engines.custom.deleteTitle', { name: e.name })}
            description={t('engines.custom.deleteBody')}
            confirmLabel={t('engines.custom.deleteConfirm')}
            cancelLabel={t('common.cancel')}
            onConfirm={() => remove.mutate(e.id, { onSuccess: () => toast.success(t('engines.custom.deleted')) })}
          />
        </>
      }
    >
      <p className="truncate rounded-md bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-fg-2" title={customEngineWhere(e)}>
        {customEngineWhere(e)}
      </p>
      <CheckView check={info.check} baseLabel={t(`engines.custom.bases.${e.base}`)} run={e.run} />
      {e.run.mode === 'docker' && info.check.status.problems[0] === 'ENGINE_NOT_INSTALLED' && (
        <PullButton engine={info.kind as 'llamacpp-docker' | 'vllm-docker' | 'sglang-docker'} image={e.run.image} label={t('engines.custom.pullImage')} />
      )}
      {rules.length > 0 && <p className="text-sm text-fg-2">{t('engines.custom.usedFor', { rules: rules.join(', ') })}</p>}
      {e.notes && <p className="text-sm whitespace-pre-line text-fg-3">{e.notes}</p>}
      {duplicate.isError && <ErrorCallout error={duplicate.error} />}
      {remove.isError && <ErrorCallout error={remove.error} />}
    </EngineCard>
  );
}
