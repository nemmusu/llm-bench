/**
 * A NInfer variant (a custom engine of base 'ninfer': NInfer-all, a fork of the user's) in "Aggiungi
 * motore": the WSL distro it runs in (Windows), then either "Scarica e compila" (LLM Bench clones its
 * repository and builds it, then saves the engine by itself) or "Ce l'ho già" (where its ninfer-serve is).
 */
import { Download } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { customEngineTemplate, GIT_URL } from '../../../contract/custom-engines';
import { NINFER_DEFAULT_DIR, ninferServeOf, type NinferKind } from '../../../contract/ninfer';
import { useI18n } from '../../i18n';
import { useNinferDistros } from '../../lib/queries-ninfer';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/input';
import { Select } from '../ui/select';
import { Skeleton } from '../ui/skeleton';
import { sourceOfForm, type CustomEngineForm, type FieldProblem, type FormField } from './custom-engine-form';
import { NinferBuildDialog, repoText } from './ninfer-build-dialog';

/** The folder a variant is built in: its template's own (~/ninfer-all), else ~/<its name as a folder>. */
export function variantDir(form: Pick<CustomEngineForm, 'name' | 'templateId'>): string {
  const own = customEngineTemplate(form.templateId)?.dir;
  if (own) return own;
  const slug = form.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `~/${slug}` : NINFER_DEFAULT_DIR;
}

/** The default WSL distro of this PC (the one a new variant runs in), while the form has none. */
export function useDefaultDistro(kind: NinferKind | null | undefined): string | undefined {
  const distros = useNinferDistros(kind === 'ninfer-wsl');
  const list = distros.data?.distros ?? [];
  return (list.find((d) => d.default) ?? list[0])?.name;
}

export interface NinferVariantWhereProps {
  form: CustomEngineForm;
  set: (patch: Partial<CustomEngineForm>) => void;
  /** The NInfer kind of this PC (ninfer-wsl: a distro is chosen). */
  kind: NinferKind;
  /** A field's hint, or what is wrong with it once shown. */
  hint: (f: FormField, normal: ReactNode) => ReactNode;
  problem: (f: FormField) => FieldProblem | undefined;
  /** The engine being edited (a build updates it). */
  editingId?: string | undefined;
  /** The build finished: the engine (named so) is saved, the dialog can close. */
  onBuilt: (name: string) => void;
}

export function NinferVariantWhere({ form, set, kind, hint, problem, editingId, onBuilt }: NinferVariantWhereProps) {
  const { t } = useI18n();
  const wsl = kind === 'ninfer-wsl';
  const distros = useNinferDistros(wsl);
  const [building, setBuilding] = useState(false);
  const source = sourceOfForm(form);
  const name = form.name.trim() || 'NInfer';
  const where = wsl ? t('ninfer.build.whereWsl', { distro: form.distro || '–' }) : t('ninfer.build.whereLinux');
  const repoOk = source !== undefined && GIT_URL.test(source.url);
  const dir = variantDir(form);
  // Built where the user says it is (its checkout), else in its own folder.
  const buildDir = form.path.trim() ? (ninferServeOf(form.path).repo ?? dir) : dir;
  return (
    <div className="flex flex-col gap-4">
      {wsl && (
        <Field label={t('ninfer.distro.label')} hint={t('ninfer.distro.hint')}>
          {({ id, describedBy }) =>
            distros.isPending ? (
              <Skeleton className="h-9" />
            ) : (
              <Select<string>
                id={id}
                aria-describedby={describedBy}
                value={form.distro}
                onValueChange={(distro) => set({ distro })}
                options={(distros.data?.distros ?? []).map((d) => ({ value: d.name, label: d.name, text: d.name, ...(d.default ? { description: t('ninfer.distro.default') } : {}) }))}
              />
            )
          }
        </Field>
      )}
      <section className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label={t('ninfer.variant.buildHere', { name })}>
        <p className="text-sm text-fg-2">{t('ninfer.variant.buildHint', { repo: source ? repoText(source.url) : '–', where })}</p>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field label={t('ninfer.build.repoLabel')} hint={problem('repoUrl') ? <span className="text-danger-text">{t('ninfer.build.repoInvalid')}</span> : t('ninfer.build.repoHint', { name })}>
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} aria-invalid={problem('repoUrl') ? true : undefined} value={form.repoUrl} onChange={(e) => set({ repoUrl: e.target.value })} className="font-mono text-xs" spellCheck={false} />
            )}
          </Field>
          <Field label={t('ninfer.build.branchLabel')} hint={t('ninfer.build.branchHint')}>
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={form.branch} onChange={(e) => set({ branch: e.target.value })} className="font-mono text-xs" spellCheck={false} />}
          </Field>
        </div>
        <Button variant="primary" className="self-start" disabled={!repoOk || (wsl && !form.distro)} onClick={() => setBuilding(true)}>
          <Download aria-hidden />
          {t('ninfer.variant.buildHere', { name })}
        </Button>
      </section>
      <Field label={t('ninfer.variant.where')} hint={hint('path', t('ninfer.variant.whereHint', { dir }))}>
        {({ id, describedBy }) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            aria-invalid={problem('path') ? true : undefined}
            value={form.path}
            placeholder={dir}
            onChange={(e) => set({ path: e.target.value })}
            className="font-mono text-xs"
            spellCheck={false}
          />
        )}
      </Field>
      <NinferBuildDialog
        open={building}
        onOpenChange={setBuilding}
        kind={kind}
        distro={wsl ? form.distro : undefined}
        dir={buildDir}
        // Enabled only with a valid repository.
        variant={{ name, ...(editingId ? { id: editingId } : {}), ...(form.templateId ? { template: form.templateId } : {}), source: source as NonNullable<typeof source> }}
        onBuilt={() => onBuilt(name)}
      />
    </div>
  );
}
