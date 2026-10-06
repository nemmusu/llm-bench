import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '../fixtures';
import { answerSaveDialog, h1, launchSeeded, scan, skipWelcome, tempFile } from './bench-helpers';

test.describe.configure({ timeout: 120_000 });

test('history: filter, compare two runs, export the result and a selection, import, delete', async () => {
  const gb = await launchSeeded();
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Risultati' }).click();
    await expect(h1(page, 'Risultati')).toBeVisible();
    await expect(page.getByText('9 risultati')).toBeVisible();
    await expect(page.getByText('Altro PC')).toBeVisible();
    await scan(page, 'results list');

    // Only this PC: the RTX 3070 run from another computer disappears.
    await page.getByRole('switch', { name: 'Solo questo PC' }).click();
    await expect(page.getByText('8 risultati')).toBeVisible();
    await page.getByRole('switch', { name: 'Solo questo PC' }).click();
    await page.getByRole('textbox', { name: 'Cerca' }).fill('gemma');
    await expect(page.getByText('1 risultato')).toBeVisible();
    await page.getByRole('textbox', { name: 'Cerca' }).fill('nessun modello così');
    await expect(page.getByRole('heading', { name: 'Nessun risultato con questi filtri' })).toBeVisible();
    await page.getByRole('button', { name: 'Togli i filtri' }).click();
    await expect(page.getByText('9 risultati')).toBeVisible();
    await page.getByRole('combobox', { name: 'Stato' }).click();
    await page.getByRole('option', { name: 'Non riuscito' }).click();
    await expect(page.getByText('1 risultato')).toBeVisible();
    await page.getByRole('combobox', { name: 'Stato' }).click();
    await page.getByRole('option', { name: 'Tutti gli stati' }).click();

    // Compare: select two rows, then open the comparison.
    await expect(page.getByRole('button', { name: 'Confronta', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: /Seleziona Qwen3 30B A3B/ }).click();
    await page.getByRole('checkbox', { name: /Seleziona Gemma 4 31B/ }).click();
    await expect(page.getByText('9 risultati · 2 selezionati')).toBeVisible();
    await page.getByRole('button', { name: 'Confronta', exact: true }).click();
    await expect(h1(page, 'Confronta')).toBeVisible();
    const table = page.getByRole('table', { name: 'Confronta' });
    // A is the older run (Qwen3 30B A3B), B the newer one (Gemma 4 31B, slower).
    await expect(table.getByRole('row', { name: /Generazione/ })).toContainText('−');
    await expect(page.getByRole('heading', { name: 'Generazione per lunghezza del testo' })).toBeVisible();
    await page.getByRole('switch', { name: 'Solo le differenze' }).click();
    await expect(page.getByRole('table', { name: 'Cosa cambia tra i due' })).toContainText('Gemma 4 31B');
    await scan(page, 'compare');
    await page.getByRole('button', { name: 'Scambia A e B' }).click();
    await expect(table.getByRole('row', { name: /Generazione/ })).toContainText('+');

    // Export one result in every format, through the real "Save as" dialog.
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Risultati' }).click();
    await expect(h1(page, 'Risultati')).toBeVisible();
    await page.getByRole('link', { name: /Qwen3 30B A3B/ }).click();
    await expect(h1(page, /Qwen3 30B A3B/)).toBeVisible();
    const csv = tempFile('result.csv');
    await answerSaveDialog(gb, csv);
    await page.getByRole('button', { name: 'Esporta' }).click();
    await page.getByRole('menuitem', { name: /CSV per Excel \(italiano\)/ }).click();
    await expect(page.getByText(/Esportazione pronta \(CSV per Excel \(italiano\)\)/)).toBeVisible();
    const text = readFileSync(csv, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Sezione;Misura;');
    expect(text).toMatch(/Generazione;512;;\d+,\d+/);
    const saved: Record<string, string> = {};
    for (const [label, ext, check] of [
      [/CSV standard/, 'csv', 'Sezione,Misura'],
      [/JSON/, 'json', '"schema": 1'],
      [/Markdown/, 'md', '# Qwen3 30B A3B'],
      [/Pagina HTML/, 'html', '<!doctype html>'],
    ] as const) {
      const file = tempFile(`result.${ext}`);
      await answerSaveDialog(gb, file);
      await page.getByRole('button', { name: 'Esporta' }).click();
      await page.getByRole('menuitem', { name: label }).click();
      await expect.poll(() => readFileSync(file, 'utf8').length).toBeGreaterThan(100);
      saved[ext] = readFileSync(file, 'utf8');
      expect(saved[ext]).toContain(check);
    }
    expect(saved.html).not.toContain('<script');

    // Export two runs as a .gpubench bundle, delete one, import it back.
    await page.getByRole('link', { name: 'Tutti i risultati' }).click();
    await page.getByRole('checkbox', { name: /Seleziona Mistral Small/ }).click();
    await page.getByRole('checkbox', { name: /Seleziona gpt-oss 20B/ }).click();
    const bundle = tempFile('scelti.gpubench');
    await answerSaveDialog(gb, bundle);
    await page.getByRole('button', { name: 'Esporta (2)' }).click();
    await expect(page.getByText(/Esportati 2 risultati/)).toBeVisible();
    expect(JSON.parse(readFileSync(bundle, 'utf8')).runs).toHaveLength(2);

    await page.getByRole('button', { name: 'Elimina (2)' }).click();
    await expect(page.getByRole('alertdialog', { name: 'Eliminare 2 risultati?' })).toBeVisible();
    await page.getByRole('button', { name: 'Elimina', exact: true }).click();
    await expect(page.getByText('Eliminati 2 risultati')).toBeVisible();
    await expect(page.getByText('7 risultati')).toBeVisible();

    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Importa' }).click();
    await (await chooser).setFiles(bundle);
    await expect(page.getByText('Importati 2 risultati (0 già presenti)')).toBeVisible();
    await expect(page.getByText('9 risultati')).toBeVisible();

    // A file that is not an export says so.
    const wrong = tempFile('wrong.gpubench');
    writeFileSync(wrong, '{"hello": 1}');
    const chooser2 = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Importa' }).click();
    await (await chooser2).setFiles(wrong);
    await expect(page.getByText('Questo file non è un’esportazione di GPU Bench.')).toBeVisible();
  } finally {
    await gb.close();
  }
});

test('a failed run explains what happened and what to do', async () => {
  const gb = await launchSeeded({}, (f) => f.includes('01K6NA2S5D8F1G4H7J3K6L9ZXC'));
  try {
    const { page } = gb;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipWelcome(page);
    await page.getByRole('navigation', { name: 'Navigazione principale' }).getByRole('link', { name: 'Risultati' }).click();
    await page.getByRole('link', { name: /Llama 3\.3 70B/ }).click();
    await expect(page.getByRole('heading', { name: 'Memoria della scheda video insufficiente' })).toBeVisible();
    await expect(page.getByText('Il test si è fermato prima di misurare la velocità di scrittura.')).toBeVisible();
    await scan(page, 'failed result');
    await page.getByRole('button', { name: 'Apri il log' }).click();
    await expect(page.getByRole('region', { name: 'Log del server (estratto)' })).toContainText('out of memory');
    await page.getByRole('tab', { name: 'Panoramica' }).click();
    await page.getByRole('button', { name: 'Scegli un altro modello' }).click();
    await expect(h1(page, 'Benchmark')).toBeVisible();
  } finally {
    await gb.close();
  }
});
