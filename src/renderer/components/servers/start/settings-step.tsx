/**
 * Step 3 of "Avvia un server": where the settings come from.
 *  - "Le migliori dai tuoi test": LLM Bench's choice (the latest "Trova le impostazioni migliori", else
 *    the context that fits), the test a page handed over, and the Configurazioni of this model here
 *    with their numbers ("54,6 tok/s a 32K");
 *  - "I tuoi preset": the presets of this model, and an engine's built-in ones (NInfer);
 *  - "Comandi personalizzati": the common parameters, extra arguments and environment.
 */
import { Bookmark, FlaskConical, Sparkles, Terminal } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import type { ServerPlan } from '../../../../contract/api';
import type { CommandRun } from '../../../../contract/custom-engines';
import { engineBaseOf, type EngineKind } from '../../../../contract/engines';
import type { ServerPreset } from '../../../../contract/servers';
import { useI18n } from '../../../i18n';
import { cn } from '../../../lib/cn';
import type { ParamsField, ParamsForm } from '../../bench/expert-form';
import type { PresetProvenance } from '../../bench/run-context';
import { CommandSettingsFields } from '../../engines/command-settings';
import { configLabelOf, useConfigLabel } from '../../presets/config-label';
import { provenanceText, shortDate, tokensShort } from '../../presets/format';
import { Callout } from '../../ui/callout';
import { Field, Input, Textarea } from '../../ui/input';
import { Select } from '../../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs';
import { depthLabel, kvName } from '../../tune/tune-format';
import type { TestedConfig } from '../server-flow';

export type SettingsTab = 'best' | 'presets' | 'custom';

export interface SettingsStepProps {
  engineKind: EngineKind;
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
  /** "Le migliori dai tuoi test": 'auto', 'draft' or a configuration id. */
  best: string;
  onBest: (v: string) => void;
  /** What LLM Bench would choose (the plan of the request without settings). */
  autoTuned: ServerPlan['tuned'] | undefined;
  provenance: PresetProvenance | undefined;
  configs: readonly TestedConfig[];
  /** The chosen configuration's test is still being read. */
  loadingConfig: boolean;
  presets: readonly ServerPreset[];
  /** An engine's own presets, above the user's (NInfer's picker for a .ninfer model). */
  builtins?: ReactNode;
  /** The chosen preset of the user's. */
  preset: string | undefined;
  onPreset: (id: string) => void;
  othersCount: number;
  form: ParamsForm;
  invalid: readonly ParamsField[];
  onForm: (patch: Partial<ParamsForm>) => void;
  /** The plan's 'flag_unsupported' warning: the flags a fork does not take. */
  unsupported: { engine: string; flags: string } | undefined;
  /** "Comandi per questo modello" (the recipes): rendered under the tabs when the model has one. */
  recipeSlot?: ReactNode;
  /** A program with an OpenAI API is chosen: its commands (the settings they take are the only fields). */
  command?: CommandRun | undefined;
}

function Choice({ value, title, detail, icon, badge }: { value: string; title: ReactNode; detail?: ReactNode; icon: ReactNode; badge?: ReactNode }) {
  return (
    <RadioGroup.Item
      value={value}
      className={cn(
        'group flex w-full items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-border-strong focus-ring',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft/40 data-[state=checked]:ring-1 data-[state=checked]:ring-accent',
      )}
    >
      <span aria-hidden className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-border-strong group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent-solid">
        <span className="size-1.5 rounded-full bg-white opacity-0 group-data-[state=checked]:opacity-100" />
      </span>
      <span aria-hidden className="mt-0.5 text-fg-3 group-data-[state=checked]:text-accent-text [&_svg]:size-4">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
          {title}
          {badge}
        </span>
        {detail && <span className="text-sm text-fg-2">{detail}</span>}
      </span>
    </RadioGroup.Item>
  );
}

function BestTab(p: SettingsStepProps) {
  const f = useI18n();
  const { t, number } = f;
  const tuned = p.autoTuned;
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup.Root value={p.best} onValueChange={p.onBest} aria-label={t('servers.flow.best.label')} className="flex flex-col gap-2">
        <Choice
          value="auto"
          icon={<Sparkles />}
          title={t('servers.flow.best.auto')}
          detail={tuned ? t('servers.flow.best.autoTuned', { date: shortDate(tuned.createdAt, f.locale), ctx: depthLabel(tuned.contextSize, f), kv: kvName(tuned.kvCacheType, f) }) : t('servers.flow.best.autoFit')}
        />
        {p.provenance && <Choice value="draft" icon={<FlaskConical />} title={t('servers.flow.best.draft', { date: shortDate(p.provenance.date, f.locale) })} detail={provenanceText(p.provenance, f)} />}
        {p.configs.map(({ entry, headline }) => {
          const label = configLabelOf(entry.engineKind, entry.params, f, { tags: entry.tags }).text;
          const latest = shortDate(entry.latest, f.locale);
          return (
            <Choice
              key={entry.id}
              value={`config:${entry.id}`}
              icon={<FlaskConical />}
              title={headline?.decodeTps !== undefined ? t('servers.flow.best.speed', { tps: number(headline.decodeTps, 1), depth: tokensShort(headline.depth, f) }) : t('servers.flow.best.noSpeed')}
              detail={
                <>
                  {label}
                  <span className="block text-xs text-fg-3">{entry.sources.length === 1 ? t('servers.flow.best.testsOne', { date: latest }) : t('servers.flow.best.tests', { n: entry.sources.length, date: latest })}</span>
                </>
              }
            />
          );
        })}
      </RadioGroup.Root>
      {p.loadingConfig && <p className="text-sm text-fg-3">{t('servers.flow.best.loadingRun')}</p>}
      {p.configs.length === 0 && (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-fg-2">
          <span className="block font-medium text-fg">{t('servers.flow.best.none')}</span>
          {t('servers.flow.best.noneBody')}
        </p>
      )}
    </div>
  );
}

function PresetsTab(p: SettingsStepProps) {
  const { t } = useI18n();
  const configLabel = useConfigLabel();
  return (
    <div className="flex flex-col gap-3">
      {p.builtins}
      {p.presets.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-fg-2">
          <span className="block font-medium text-fg">{t('servers.flow.presetsTab.none')}</span>
          {t('servers.flow.presetsTab.noneBody')}
        </p>
      ) : (
        <RadioGroup.Root value={p.preset ?? ''} onValueChange={p.onPreset} aria-label={t('servers.flow.presetsTab.label')} className="flex flex-col gap-2">
          {p.presets.map((x) => (
            <Choice
              key={x.id}
              value={x.id}
              icon={<Bookmark />}
              title={x.name}
              detail={`${configLabel(x.params, x.engine.kind).text} · ${x.port !== undefined ? t('servers.presets.port', { port: x.port }) : t('servers.presets.portAuto')}`}
            />
          ))}
        </RadioGroup.Root>
      )}
      {p.othersCount > 0 && <p className="text-xs text-fg-3">{t('servers.flow.presetsTab.others')}</p>}
    </div>
  );
}

/** The parameters each engine takes, as in the Benchmark page's expert mode. */
function CustomTab(p: SettingsStepProps) {
  const { t } = useI18n();
  const base = engineBaseOf(p.engineKind);
  const bad = (k: ParamsField) => p.invalid.includes(k);
  const num = (field: 'contextSize' | 'gpuLayers' | 'batchSize' | 'ubatchSize' | 'threads' | 'parallel' | 'maxModelLen' | 'gpuMemoryUtilization', label: string, placeholder: string) => (
    <Field label={label} hint={bad(field) ? <span className="text-danger-text">{t('benchmark.expert.invalid')}</span> : undefined}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={bad(field) || undefined}
          value={p.form[field]}
          placeholder={placeholder}
          inputMode="numeric"
          onChange={(e) => p.onForm({ [field]: e.target.value })}
          className="tabular-nums"
          autoComplete="off"
        />
      )}
    </Field>
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-fg-2">{t('servers.flow.custom.intro')}</p>
      {p.unsupported && (
        <Callout tone="warning" title={t('servers.flow.custom.flagsTitle', { engine: p.unsupported.engine })}>
          {t('servers.flow.custom.flagsBody', { flags: p.unsupported.flags })}
        </Callout>
      )}
      {base === 'llamacpp' && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {num('contextSize', t('benchmark.expert.ctx'), t('common.auto'))}
          {num('gpuLayers', t('benchmark.expert.ngl'), t('benchmark.expert.nglAll'))}
          <Field label={t('benchmark.expert.flashAttention')}>
            {({ id }) => (
              <Select<ParamsForm['flashAttention']>
                id={id}
                value={p.form.flashAttention}
                onValueChange={(v) => p.onForm({ flashAttention: v })}
                options={[
                  { value: 'default', label: t('common.auto') },
                  { value: 'on', label: t('common.on') },
                  { value: 'off', label: t('common.off') },
                ]}
              />
            )}
          </Field>
          <Field label={t('benchmark.expert.kvCache')}>
            {({ id }) => (
              <Select<ParamsForm['kvCacheType']>
                id={id}
                value={p.form.kvCacheType}
                onValueChange={(v) => p.onForm({ kvCacheType: v })}
                options={[
                  { value: 'default', label: t('common.auto') },
                  { value: 'f16', label: 'f16' },
                  { value: 'q8_0', label: 'q8_0' },
                  { value: 'q4_0', label: 'q4_0' },
                ]}
              />
            )}
          </Field>
          {num('batchSize', t('benchmark.expert.batch'), '2048')}
          {num('ubatchSize', t('benchmark.expert.ubatch'), '512')}
          {num('threads', t('benchmark.expert.threads'), t('common.auto'))}
          {num('parallel', t('benchmark.expert.parallel'), t('common.auto'))}
        </div>
      )}
      {(base === 'vllm' || base === 'sglang') && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {num('maxModelLen', t('benchmark.expert.maxModelLen'), t('common.auto'))}
          {num('gpuMemoryUtilization', t('benchmark.expert.gpuMemory'), '0,90')}
          {num('parallel', t('benchmark.expert.maxSeqs'), t('common.auto'))}
        </div>
      )}
      {/* A program with an OpenAI API: only the settings its commands take. */}
      {p.command && <CommandSettingsFields run={p.command} form={p.form} invalid={p.invalid} onForm={p.onForm} />}
      {base === 'ninfer' && (
        <div className="grid grid-cols-2 gap-4">
          {num('contextSize', t('benchmark.expert.ctx'), t('common.auto'))}
          {num('parallel', t('benchmark.expert.parallel'), t('common.auto'))}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label={t('servers.flow.custom.extraArgs')} hint={t('servers.flow.custom.extraArgsHint')}>
          {({ id, describedBy }) => (
            <Textarea id={id} aria-describedby={describedBy} value={p.form.extraArgs} placeholder="--metrics" onChange={(e) => p.onForm({ extraArgs: e.target.value })} className="font-mono text-xs" spellCheck={false} />
          )}
        </Field>
        <Field label={t('servers.flow.custom.env')} hint={bad('env') ? <span className="text-danger-text">{t('benchmark.expert.envInvalid')}</span> : t('servers.flow.custom.envHint')}>
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={bad('env') || undefined}
              value={p.form.env}
              placeholder="CUDA_VISIBLE_DEVICES=0"
              onChange={(e) => p.onForm({ env: e.target.value })}
              className="font-mono text-xs"
              spellCheck={false}
            />
          )}
        </Field>
      </div>
    </div>
  );
}

export function SettingsStep(p: SettingsStepProps) {
  const { t } = useI18n();
  return (
    <Tabs value={p.tab} onValueChange={(v) => p.onTab(v as SettingsTab)}>
      <TabsList aria-label={t('servers.flow.tabs.label')} className="flex-wrap">
        <TabsTrigger value="best">
          <FlaskConical aria-hidden />
          {t('servers.flow.tabs.best')}
        </TabsTrigger>
        <TabsTrigger value="presets">
          <Bookmark aria-hidden />
          {t('servers.flow.tabs.presets')}
        </TabsTrigger>
        <TabsTrigger value="custom">
          <Terminal aria-hidden />
          {t('servers.flow.tabs.custom')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="best" className="pt-4">
        <BestTab {...p} />
      </TabsContent>
      <TabsContent value="presets" className="pt-4">
        <PresetsTab {...p} />
      </TabsContent>
      <TabsContent value="custom" className="pt-4">
        <CustomTab {...p} />
      </TabsContent>
      {p.recipeSlot}
    </Tabs>
  );
}
