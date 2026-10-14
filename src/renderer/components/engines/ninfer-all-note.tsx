/**
 * A model only NInfer-all reads, chosen with NInfer (Benchmark, "Avvia un server"): NInfer-all runs it by
 * itself (the core does the same: core/engines/ninfer/choose.ts), and the page says so — "NInfer ·
 * versione NInfer-all (serve per questo modello)". Not built yet: the way to build it now (the start
 * would ask anyway).
 */
import { Cpu } from 'lucide-react';
import { useState } from 'react';
import type { CustomEngine } from '../../../contract/custom-engines';
import type { EngineKind } from '../../../contract/engines';
import { runsOnNinferAll, type NinferBuildModel } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { useNinferBuild } from '../../lib/queries-ninfer';
import { Callout } from '../ui/callout';
import { NinferAllGateDialog } from './ninfer-all-gate';

export interface NinferAllNeed {
  /** A launch of this model on this engine runs on NInfer-all. */
  needed: boolean;
  /** NInfer-all is built (and answers). */
  ready: boolean;
  /** The KV types its --help lists (the presets it can run), once built. */
  kvDtypes?: string[] | undefined;
}

export function useNinferAllNeed(kind: EngineKind, custom: CustomEngine | undefined, model: NinferBuildModel | undefined): NinferAllNeed {
  const needed = runsOnNinferAll(kind, custom, model);
  const all = useNinferBuild('all', needed);
  const ready = all?.state === 'ready' || all?.state === 'stale';
  return { needed, ready, ...(ready ? { kvDtypes: all.kvDtypes } : {}) };
}

/** "NInfer (WSL) · versione NInfer-all": the engine's label when NInfer-all runs the model. */
export function withNinferAll(label: string, need: NinferAllNeed, t: ReturnType<typeof useI18n>['t']): string {
  return need.needed ? t('ninfer.allNote.label', { engine: label }) : label;
}

/** "Questo modello funziona solo con NInfer-all" with "Scarica e compila NInfer-all" (its build, in a dialog). */
export function NinferAllCallout() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Callout tone="info" title={t('ninfer.allNote.title')} action={{ label: t('ninfer.allNote.build'), onClick: () => setOpen(true) }}>
        <p className="inline-flex items-start gap-1.5">
          <Cpu aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('ninfer.allNote.body')}
        </p>
      </Callout>
      <NinferAllGateDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
