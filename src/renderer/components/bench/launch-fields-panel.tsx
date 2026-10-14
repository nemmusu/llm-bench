/**
 * The launch settings of one engine, in its own words and with the flag each one becomes, for the
 * Benchmark's "Parametri avanzati" and "Avvia un server" → "Comandi personalizzati" (one component, so
 * both pages offer the same fields). Which fields an engine has is launch-fields.ts; an empty field
 * says what happens then ("Vuoto: …"): the engine's default, what the test needs, or the value of the
 * NInfer preset chosen above. A field a fork's --help lacks is disabled with the reason.
 */
import type { ReactNode } from 'react';
import type { MissingFlag } from '../../../contract/custom-engines';
import { type LaunchParams, type NinferParams, type NinferSpec } from '../../../contract/engines';
import { NINFER_DEFAULT_DRAFT_TOKENS, NINFER_DEFAULTS } from '../../../contract/ninfer';
import { useI18n, type MessageKey } from '../../i18n';
import { YarnChoice } from '../recipes/yarn-choice';
import { Field, Input } from '../ui/input';
import { Select, type SelectOption } from '../ui/select';
import { kvCacheOptions } from './kv-cache-options';
import { formFromParams, parseInteger, type ParamsField, type ParamsForm, type Tri } from './expert-form';
import { LAUNCH_FIELDS, type LaunchBase } from './launch-fields';
import type { NinferSupport } from './ninfer-support';

/** vLLM's and SGLang's own defaults for the share of GPU memory (core/engines/shared: vllm-args.ts, sglang.ts). */
export const MEMORY_DEFAULTS = { vllm: 0.9, sglang: 0.85 } as const;

export interface LaunchFieldsProps {
  base: LaunchBase;
  form: ParamsForm;
  invalid: readonly ParamsField[];
  onForm: (patch: Partial<ParamsForm>) => void;
  /** A benchmark (LLM Bench sizes what is left empty for the test) or a server. */
  use: 'test' | 'server';
  /** The flags the build's --help lacks (a fork's check): those fields are disabled. */
  missing?: readonly MissingFlag[] | undefined;
  /** NInfer: what the model and build take. */
  ninfer?: NinferSupport | undefined;
  /** llama.cpp: the -ctk values a fork lists (its check): its own types join the KV cache choices (kv-cache-options.ts). */
  kvCacheTypes?: readonly string[] | undefined;
  /** NInfer: the preset chosen above; its values apply to the fields left empty. */
  preset?: { name: string; params: Pick<LaunchParams, 'contextSize' | 'parallel'> & { ninfer: NinferParams } } | undefined;
  /** The context field's placeholder and hint when something else sets it (the model's recipe). */
  context?: { placeholder: string; hint?: ReactNode } | undefined;
  /** The model's trained context (YaRN). */
  trainedContext?: number | undefined;
}

/** What leaving a field empty means: in a test and for a server (often the same text), with its values. */
type Auto = { test: MessageKey; server: MessageKey; values?: Record<string, string | number> };

/** A field's words: its label, what it does, and what leaving it empty means. */
type Spec = { label: MessageKey; hint: MessageKey; placeholder?: string; auto: Auto };

const k = (name: string, leaf: string) => `benchmark.expert.f.${name}.${leaf}` as MessageKey;
const g = (leaf: string) => `benchmark.expert.f.${leaf}` as MessageKey;
/** The field's own "Vuoto: …" (the same for a test and a server). */
const own = (name: string): Auto => ({ test: k(name, 'auto'), server: k(name, 'auto') });
/** The field's own "Vuoto: …" for a test and for a server. */
const byUse = (name: string): Auto => ({ test: k(name, 'autoTest'), server: k(name, 'autoServer') });
const CONTEXT: Auto = { test: g('autoTest'), server: g('autoServer') };
const USERS: Auto = { test: g('autoUsersTest'), server: g('autoEngine') };

/** Each engine's words for its fields (`memory`: its GPU memory share, as the user reads numbers). */
function specsOf(base: LaunchBase, memory: string): Partial<Record<ParamsField, Spec>> {
  const fx = (name: string, auto: Auto = own(name)): Spec => ({ label: k(name, 'label'), hint: k(name, 'hint'), auto });
  switch (base) {
    case 'llamacpp':
      return {
        contextSize: fx('ctxShared', CONTEXT),
        gpuLayers: fx('gpuLayers'),
        flashAttention: fx('flashAttention'),
        kvCacheType: fx('kvLlama'),
        batchSize: { ...fx('batchLlama'), placeholder: '2048' },
        ubatchSize: { ...fx('ubatch'), placeholder: '512' },
        threads: fx('threads'),
        parallel: fx('slots', USERS),
      };
    case 'vllm':
    case 'sglang':
      return {
        maxModelLen: fx('ctxRequest', CONTEXT),
        gpuMemoryUtilization: fx(base === 'vllm' ? 'memVllm' : 'memSglang', { test: g('autoValue'), server: g('autoValue'), values: { value: memory } }),
        parallel: fx('requests', USERS),
        kvCacheType: fx(base === 'vllm' ? 'kvVllm' : 'kvSglang'),
        batchSize: fx(base === 'vllm' ? 'batchVllm' : 'batchSglang'),
        dtype: { ...fx('dtype'), placeholder: 'auto' },
        quantization: fx('quantization'),
      };
    case 'ninfer':
      return {
        contextSize: fx('ctxNinfer', CONTEXT),
        parallel: fx('users', { test: g('autoUsersTest'), server: g('autoValue'), values: { value: NINFER_DEFAULTS.maxConcurrency } }),
        ninferKvCapacity: fx('kvPool', { test: g('autoPoolTest'), server: g('autoPoolServer') }),
        ninferKvDtype: fx('kvDtype', byUse('kvDtype')),
        ninferSpec: fx('spec', byUse('spec')),
        ninferDraftTokens: fx('draft'),
        ninferLmHeadDraft: fx('lmHead'),
        ninferPrefixReuse: fx('reuse', { test: g('autoReuseTest'), server: g('autoReuseServer') }),
        ninferDeviceStateSlots: fx('deviceSlots'),
        ninferHostStateSlots: fx('hostSlots'),
        ninferHostKvMib: fx('hostKv'),
        ninferPreserveThinking: fx('preserveThinking'),
      };
    // TensorRT-LLM: its shared fields in vLLM's words until its own panel (the UI's work) words them.
    case 'trtllm':
      return {
        maxModelLen: fx('ctxRequest', CONTEXT),
        parallel: fx('requests', USERS),
        kvCacheType: fx('kvVllm'),
        batchSize: fx('batchVllm'),
      };
  }
}

/** Shown elsewhere: the YaRN choice under the grid, image input and reasoning as the page's switches (model-switches.tsx). */
const SWITCH_FIELDS: ReadonlySet<ParamsField> = new Set<ParamsField>(['yarnTarget', 'vision', 'reasoning', 'ninferVision', 'ninferThinking']);

/** NInfer's fields in three groups (each its own small heading). */
const NINFER_GROUPS: readonly { title: MessageKey; fields: readonly ParamsField[] }[] = [
  { title: 'benchmark.expert.f.groupMemory', fields: ['contextSize', 'parallel', 'ninferKvCapacity', 'ninferKvDtype'] },
  { title: 'benchmark.expert.f.groupSpeed', fields: ['ninferSpec', 'ninferDraftTokens', 'ninferLmHeadDraft'] },
  { title: 'benchmark.expert.f.groupChat', fields: ['ninferPrefixReuse', 'ninferDeviceStateSlots', 'ninferHostStateSlots', 'ninferHostKvMib', 'ninferPreserveThinking'] },
];

/** The select's value for the KV cache as the engine reads it (llama.cpp takes fp8 as q8_0; vLLM / SGLang any 8/4-bit as fp8). */
export function kvShown(base: LaunchBase, kv: string): string {
  if (kv === 'default' || kv === 'auto') return 'default';
  if (base === 'llamacpp') return kv === 'fp8' ? 'q8_0' : kv;
  return kv === 'q8_0' || kv === 'q4_0' || kv === 'fp8' ? 'fp8' : 'default';
}

export function LaunchFields(p: LaunchFieldsProps) {
  const f = useI18n();
  const { t, integer, number } = f;
  const specs = specsOf(p.base, p.base === 'vllm' || p.base === 'sglang' ? number(MEMORY_DEFAULTS[p.base], 2) : '');
  const flags = LAUNCH_FIELDS[p.base];
  const bad = (field: ParamsField) => p.invalid.includes(field);
  const yarnOn = p.form.yarnTarget.trim() !== '';
  // The preset's values, as the form would hold them (the fields left empty take these).
  const fallback = p.preset ? formFromParams({ ...p.preset.params, extraArgs: [], env: {} }) : undefined;
  const fromPreset = (field: ParamsField): string | undefined => {
    const v = fallback?.[field];
    return v === undefined || v === '' || v === 'default' ? undefined : v;
  };
  const triText = (v: string) => (v === 'on' ? t('common.yes') : t('common.no'));
  const specText = (v: string) => (v === 'off' ? t('benchmark.expert.f.spec.off') : t(`benchmark.expert.f.spec.${v as Exclude<NinferSpec, 'off'>}`));
  const valueText = (field: ParamsField, v: string): string => {
    if (field === 'ninferSpec') return specText(v);
    if (field.startsWith('ninfer') && (v === 'on' || v === 'off')) return triText(v);
    const n = parseInteger(v);
    return n === null ? v : integer(n);
  };
  const missingFlag = (setting: string) => p.missing?.find((m) => m.setting === setting)?.flag;

  /** What an empty field means here: the preset's value (its placeholder says which), else the field's own words. */
  const autoHint = (field: ParamsField, spec: Spec): string =>
    fromPreset(field) !== undefined ? t('benchmark.expert.f.fromPreset', { name: p.preset!.name }) : t(p.use === 'test' ? spec.auto.test : spec.auto.server, spec.auto.values);

  // NInfer: the prediction settings mean something only with a prediction, the cache slots only with reuse.
  // Left empty in a test, LLM Bench predicts tokens with the model's own head (core/engines/ninfer/defaults.ts); a server does not.
  const effSpec = p.form.ninferSpec !== 'default' ? p.form.ninferSpec : (fromPreset('ninferSpec') ?? (p.use === 'test' ? 'auto' : 'off'));
  const effReuse: Tri = p.form.ninferPrefixReuse !== 'default' ? p.form.ninferPrefixReuse : p.use === 'test' ? 'default' : 'on';

  const hintOf = (field: ParamsField, spec: Spec, flag: string, why?: string): ReactNode => {
    if (bad(field)) return <span className="text-danger-text">{t(field === 'parallel' && p.base === 'ninfer' ? 'benchmark.expert.f.users.invalid' : field === 'ninferDraftTokens' ? 'benchmark.expert.f.draft.invalid' : 'benchmark.expert.invalid')}</span>;
    const own = field === 'contextSize' || field === 'maxModelLen' ? p.context?.hint : undefined;
    return (
      <>
        {why ?? own ?? `${t(spec.hint)} ${autoHint(field, spec)}`} <code className="font-mono text-[0.6875rem] whitespace-nowrap text-fg-3">{flag}</code>
      </>
    );
  };

  const control = (field: ParamsField): ReactNode => {
    // Every field of the grid has its words and its flag (launch-fields.ts).
    const spec = specs[field]!;
    const flag = flags.find((x) => x.field === field)!;
    const lacking = missingFlag(flag.setting);
    let disabledWhy: string | undefined = lacking ? t('benchmark.expert.missingFlag', { flag: lacking }) : undefined;
    if (!disabledWhy && (field === 'ninferDraftTokens' || field === 'ninferLmHeadDraft') && effSpec === 'off') disabledWhy = t('benchmark.expert.f.draft.needsSpec');
    if (!disabledWhy && field === 'ninferLmHeadDraft' && p.ninfer && !p.ninfer.lmHead) disabledWhy = t('benchmark.expert.f.lmHead.missing');
    if (!disabledWhy && (field === 'ninferDeviceStateSlots' || field === 'ninferHostStateSlots' || field === 'ninferHostKvMib') && effReuse === 'off') disabledWhy = t('benchmark.expert.f.deviceSlots.needsReuse');
    const ctxField = field === 'contextSize' || field === 'maxModelLen';
    const disabled = disabledWhy !== undefined || (ctxField && yarnOn);
    const label = t(spec.label);
    const hint = hintOf(field, spec, flag.flag, disabledWhy);
    const preset = fromPreset(field);
    const autoLabel = preset !== undefined ? t('benchmark.expert.f.presetOption', { value: valueText(field, preset) }) : t('common.auto');

    const select = <V extends string>(value: V, options: readonly SelectOption<V>[]) => (
      <Field key={field} label={label} hint={hint}>
        {({ id, describedBy }) => (
          <Select<V>
            id={id}
            // Every field has a hint, so it is always described.
            aria-describedby={describedBy!}
            value={value}
            disabled={disabled}
            onValueChange={(v) => p.onForm({ [field]: v })}
            options={options}
          />
        )}
      </Field>
    );

    switch (field) {
      case 'flashAttention':
        return select(p.form.flashAttention === 'auto' ? 'default' : p.form.flashAttention, [
          { value: 'default', label: t('common.auto') },
          { value: 'on', label: t('common.on') },
          { value: 'off', label: t('common.off') },
        ]);
      case 'kvCacheType':
        return select(
          kvShown(p.base, p.form.kvCacheType),
          p.base === 'llamacpp'
            ? kvCacheOptions(p.kvCacheTypes, kvShown(p.base, p.form.kvCacheType), f)
            : [
                { value: 'default', label: t('common.auto') },
                { value: 'fp8', label: p.base === 'sglang' ? 'fp8 (e5m2)' : 'fp8' },
              ],
        );
      case 'ninferKvDtype': {
        const types = p.ninfer?.kvDtypes ?? [];
        const current = p.form.ninferKvDtype;
        // A value the build does not list stays visible (and the plan says it is refused) rather than vanishing.
        const values = current && !types.includes(current) ? [...types, current] : types;
        return select(current || 'default', [{ value: 'default', label: autoLabel }, ...values.map((v) => ({ value: v, label: v }))]);
      }
      case 'ninferSpec': {
        const heads = p.ninfer?.specs ?? ['mtp', 'dflash', 'dflash2'];
        const current = p.form.ninferSpec;
        const values = current !== 'default' && current !== 'off' && !heads.includes(current) ? [...heads, current] : heads;
        return select<string>(current, [
          { value: 'default', label: autoLabel },
          { value: 'off', label: specText('off') },
          ...values.map((v) => ({ value: v, label: specText(v) })),
        ]);
      }
      case 'ninferLmHeadDraft':
      case 'ninferPrefixReuse':
      case 'ninferPreserveThinking':
        return select<Tri>(p.form[field], [
          { value: 'default', label: autoLabel },
          { value: 'on', label: t('common.yes') },
          { value: 'off', label: t('common.no') },
        ]);
      default: {
        const value = p.form[field] as string;
        const placeholder =
          ctxField && yarnOn
            ? `${integer(Number(p.form.yarnTarget))} · YaRN`
            : ctxField && p.context
              ? p.context.placeholder
              : preset !== undefined
                ? valueText(field, preset)
                : field === 'gpuLayers'
                  ? t('benchmark.expert.nglAll')
                  : field === 'gpuMemoryUtilization'
                    ? number(MEMORY_DEFAULTS[p.base as 'vllm' | 'sglang'], 2)
                    : field === 'ninferDraftTokens'
                      ? String(effSpec === 'off' || effSpec === 'auto' ? NINFER_DEFAULT_DRAFT_TOKENS.mtp : NINFER_DEFAULT_DRAFT_TOKENS[effSpec as Exclude<NinferSpec, 'off'>])
                      : (spec.placeholder ?? t('common.auto'));
        const mono = field === 'dtype' || field === 'quantization';
        return (
          <Field key={field} label={label} hint={hint}>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={bad(field) || undefined}
                value={ctxField && yarnOn ? '' : value}
                placeholder={placeholder}
                onChange={(e) => p.onForm({ [field]: e.target.value })}
                className={mono ? 'font-mono text-xs' : 'tabular-nums'}
                inputMode={field === 'gpuMemoryUtilization' ? 'decimal' : mono || field === 'ninferKvCapacity' ? 'text' : 'numeric'}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
        );
      }
    }
  };

  // As many columns as the panel's own width holds (it is narrower beside a side card, wider on its own).
  const grid = 'grid gap-4 @lg:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-4';
  const hasYarn = flags.some((x) => x.field === 'yarnTarget');
  const yarnLacking = missingFlag('ropeScaling');
  return (
    <div className="@container flex flex-col gap-5">
      {p.base === 'ninfer' ? (
        NINFER_GROUPS.map((g) => (
          <div key={g.title} className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-fg-2">{t(g.title)}</h3>
            <div className={grid}>{g.fields.map(control)}</div>
          </div>
        ))
      ) : (
        <div className={grid}>{flags.map((x) => (SWITCH_FIELDS.has(x.field) ? null : control(x.field)))}</div>
      )}
      {hasYarn &&
        (yarnLacking ? (
          <p className="text-xs text-fg-3">{t('benchmark.expert.f.yarnMissing', { flag: yarnLacking })}</p>
        ) : (
          <div className="max-w-2xl">
            <YarnChoice value={p.form.yarnTarget} onChange={(yarnTarget) => p.onForm({ yarnTarget, yarnOriginal: '' })} trained={parseInteger(p.form.yarnOriginal) ?? p.trainedContext} allowOff invalid={bad('yarnTarget')} title />
          </div>
        ))}
    </div>
  );
}
