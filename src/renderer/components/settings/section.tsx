import type { ReactNode } from 'react';
import { Card } from '../ui/card';

export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="grid grid-cols-1 gap-6 p-card @2xl/page:grid-cols-[240px_1fr]">
      <div className="flex flex-col gap-1">
        <h2 className="text-md font-semibold">{title}</h2>
        {hint && <p className="text-sm text-fg-3">{hint}</p>}
      </div>
      <div className="flex min-w-0 flex-col divide-y divide-border">{children}</div>
    </Card>
  );
}

export function Row({ label, hint, control, htmlFor }: { label: string; hint?: ReactNode; control: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
      {/* The text gives way first: a short control (a switch, a menu) stays on its right instead of dropping below a long hint. */}
      <div className="flex max-w-md min-w-0 flex-1 basis-60 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </label>
        ) : (
          <span className="text-sm font-medium">{label}</span>
        )}
        {hint && <span className="text-xs text-fg-3">{hint}</span>}
      </div>
      {control}
    </div>
  );
}
