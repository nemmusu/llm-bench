# Benchmark prompt corpus

`corpus.txt` is the text of a public-domain novel, used to build exact-length benchmark prompts
(tokenized once per model, then sliced at a different offset for every repetition).

- **Title**: Frankenstein; or, the Modern Prometheus (1818 text)
- **Author**: Mary Wollstonecraft (Godwin) Shelley (1797–1851)
- **Source**: Project Gutenberg eBook #84, https://www.gutenberg.org/ebooks/84
  (plain text fetched from the PG mirror `https://gutenberg.pglaf.org/cache/epub/84/pg84.txt`, edition updated 2026-02-10)
- **Status**: public domain (published 1818; author died 1851).
- **Processing**: the Project Gutenberg header and footer (license and trademark boilerplate) were removed, as the
  Project Gutenberg license allows for redistribution of the bare public-domain text; line endings were converted to
  LF and the BOM removed. Nothing else was changed. Size: ~421 KB, UTF-8.

Changing this file changes every prompt: bump `METRICS_FORMULA_VERSION` when replacing it.
