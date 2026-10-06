/**
 * Italian strings: the source of truth. en.ts must have exactly the same keys (enforced by the
 * `Messages` type). Placeholders use {name}. Keep wording simple: the app targets non-experts.
 */
export const it = {
  app: {
    name: 'GPU Bench',
    tagline: 'Misura quanto è veloce la tua scheda video con l’intelligenza artificiale',
    loading: 'Avvio in corso…',
    coreUnreachable: 'Il motore interno non risponde. Riprovo…',
  },
  nav: {
    benchmark: 'Benchmark',
    results: 'Risultati',
    models: 'Modelli',
    engines: 'Motori',
    monitor: 'Monitor GPU',
    settings: 'Impostazioni',
  },
} as const;

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
export type Messages = Widen<typeof it>;
