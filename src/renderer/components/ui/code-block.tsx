import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/cn';
import { IconButton } from './button';
import { SegmentedControl } from './segmented-control';

export type Shell = 'powershell' | 'bash';

export interface CodeBlockProps {
  commands: Record<Shell, string>;
  /** Defaults to PowerShell on Windows and bash elsewhere. */
  defaultShell?: Shell;
  /** Accessible name of the code region, e.g. "Command preview". */
  label: string;
  className?: string;
  /** Hide the shell toggle (single-format snippets). */
  single?: boolean;
  /** What the copy button copies, when it differs from what is shown (a secret shown hidden). */
  copyCommands?: Record<Shell, string>;
}

export function defaultShellFor(platform: string | undefined): Shell {
  return platform === 'win32' ? 'powershell' : 'bash';
}

type TokenKind = 'cmd' | 'flag' | 'string' | 'cont' | 'text';

/** Light tokenizer for display only: program, --flags, quoted strings, line continuations. */
export function tokenize(command: string): { text: string; kind: TokenKind }[] {
  const out: { text: string; kind: TokenKind }[] = [];
  let first = true;
  // Quoted strings stay whole even when they contain spaces (e.g. "…\GPU Bench\…").
  for (const part of command.match(/'[^']*'|"[^"]*"|\s+|[^\s'"]+|['"]/g) ?? []) {
    if (/^\s+$/.test(part)) {
      out.push({ text: part, kind: 'text' });
      continue;
    }
    let kind: TokenKind = 'text';
    if (first) kind = 'cmd';
    else if (part === '`' || part === '\\') kind = 'cont';
    else if (/^--?[A-Za-z]/.test(part)) kind = 'flag';
    else if (/^["']/.test(part)) kind = 'string';
    first = false;
    out.push({ text: part, kind });
  }
  return out;
}

const tokenClass: Record<TokenKind, string> = {
  cmd: 'text-fg font-semibold',
  flag: 'text-accent-text',
  string: 'text-success-text',
  cont: 'text-fg-3',
  text: 'text-fg-2',
};

/** Monospace command with a PowerShell/bash toggle and a copy button. */
export function CodeBlock({ commands, defaultShell, label, className, single, copyCommands }: CodeBlockProps) {
  const { t } = useI18n();
  const [shell, setShell] = useState<Shell>(defaultShell ?? defaultShellFor(window.gpubench?.platform ?? 'win32'));
  const [copied, setCopied] = useState(false);
  const text = commands[shell];

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyCommands?.[shell] ?? text);
      setCopied(true);
      toast.success(t('codeblock.copied'));
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-surface-2', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        {single ? (
          <span className="px-1 text-xs font-medium text-fg-3">{label}</span>
        ) : (
          <SegmentedControl
            size="sm"
            label={t('codeblock.shell')}
            value={shell}
            onValueChange={setShell}
            options={[
              { value: 'powershell', label: t('codeblock.powershell') },
              { value: 'bash', label: t('codeblock.bash') },
            ]}
          />
        )}
        <IconButton
          label={copied ? t('codeblock.copied') : t('codeblock.copyCommand')}
          icon={copied ? <Check className="text-success-text" /> : <Copy />}
          size="sm"
          onClick={() => void copy()}
        />
      </div>
      <pre
        role="region"
        aria-label={label}
        tabIndex={0}
        className="max-h-72 overflow-auto px-4 py-3 font-mono text-[12.5px] leading-[21px] whitespace-pre-wrap break-all focus-ring"
      >
        <code>
          {tokenize(text).map((tok, i) => (
            <span key={i} className={tokenClass[tok.kind]}>
              {tok.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
