<p align="center"><img src="resources/icons/icon-256.png" width="88" alt="Icona di LLM Bench"></p>

<h1 align="center">LLM Bench</h1>

<p align="center"><b>Quanto è veloce la tua scheda video NVIDIA con l'intelligenza artificiale?</b><br>
Misura i modelli linguistici (LLM) sul tuo PC, trova le impostazioni migliori e ti risponde in parole semplici.</p>

<p align="center">
  <a href="https://github.com/nemmusu/llm-bench/releases/latest"><img src="https://img.shields.io/badge/scarica-ultima%20versione-6E56CF?style=for-the-badge" alt="Scarica l'ultima versione"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white" alt="Windows 10 e 11">
  <img src="https://img.shields.io/badge/Linux-.deb%20%7C%20AppImage-FCC624?logo=linux&logoColor=black" alt="Linux: .deb e AppImage">
  <img src="https://img.shields.io/badge/NVIDIA-GPU-76B900?logo=nvidia&logoColor=white" alt="Schede video NVIDIA">
  <img src="https://img.shields.io/badge/motori-llama.cpp%20%7C%20vLLM%20%7C%20SGLang%20%7C%20NInfer-555" alt="Motori: llama.cpp, vLLM, SGLang, NInfer">
  <img src="https://img.shields.io/badge/lingua-English%20%7C%20Italiano-555" alt="Inglese e italiano">
</p>

<p align="center"><a href="README.md">English</a> · Italiano · <a href="docs/GUIDA.md">Guida completa</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/it/benchmark-dark.png">
  <img src="docs/screenshots/it/benchmark.png" alt="La pagina Benchmark di LLM Bench: motore, modello e durata già scelti, la scheda video dal vivo e gli ultimi risultati">
</picture>

## Cosa fa

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>⚡ Lo vedi lavorare</h3>
      Token al secondo mentre il modello scrive e legge, memoria video, temperatura e consumo, dal vivo.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/it/test-running-dark.png"><img src="docs/screenshots/it/test-running.png" alt="Un test in corso con velocità, memoria video e consumo dal vivo"></picture>
    </td>
    <td width="50%" valign="top">
      <h3>🎯 Le impostazioni migliori, trovate per te</h3>
      Il contesto più grande che entra nella tua scheda, e la configurazione più veloce con quel contesto pieno.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/it/tune-ranking-dark.png"><img src="docs/screenshots/it/tune-ranking.png" alt="La classifica delle configurazioni, ognuna misurata al proprio contesto massimo"></picture>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>📦 Modelli che entrano nella tua scheda</h3>
      Cerchi su Hugging Face e scarichi la versione giusta: LLM Bench ti dice prima se entra.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/it/model-versions-dark.png"><img src="docs/screenshots/it/model-versions.png" alt="Le versioni di un modello con dimensione e se entrano nella scheda video"></picture>
    </td>
    <td width="50%" valign="top">
      <h3>⚖️ Confronti fianco a fianco</h3>
      Fino a quattro test o modelli, sempre a parità di contesto, con il vincitore detto a parole.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/it/compare-dark.png"><img src="docs/screenshots/it/compare.png" alt="Quattro modelli a confronto: chi scrive e chi legge più veloce"></picture>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🔌 Un server locale con un clic</h3>
      Un indirizzo compatibile con OpenAI per chat, editor e assistenti, acceso anche a finestra chiusa.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/it/server-dark.png"><img src="docs/screenshots/it/server.png" alt="Un server acceso con il suo indirizzo compatibile con OpenAI e un esempio di richiesta"></picture>
    </td>
    <td width="50%" valign="top">
      <h3>💬 Risultati in parole semplici</h3>
      Un punteggio, una frase che lo spiega e un <b>?</b> accanto a ogni numero. Niente gergo.
      <br><br>
      <picture><source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/it/result-dark.png"><img src="docs/screenshots/it/result.png" alt="Un risultato: il punteggio, la velocità spiegata a parole e i numeri principali"></picture>
    </td>
  </tr>
</table>

Funziona con **llama.cpp**, **vLLM**, **SGLang**, **NInfer** e le loro versioni modificate: LLM Bench li installa e li aggiorna con un pulsante, e chiede sempre prima di scaricare qualcosa.

## Scarica

Prendi il file per il tuo sistema dall'**[ultima versione](https://github.com/nemmusu/llm-bench/releases/latest)**:

| Sistema | File |
|---|---|
| Windows 10 / 11 | `LLM-Bench-Setup-x.y.z.exe` (installazione) oppure `LLM-Bench-x.y.z-portable.exe` |
| Ubuntu, Debian | `llm-bench-x.y.z-amd64.deb` |
| Altri Linux | il file `.AppImage` |

Ti serve solo una scheda video NVIDIA con il suo driver. Alcuni motori usano anche Docker o WSL 2: LLM Bench ti dice quando e ti aiuta a prepararli.

## Inizia in 3 passi

1. **Apri LLM Bench.** Controlla il PC e ti propone un motore, un modello che entra e un test veloce.
2. **Premi «Avvia benchmark».**
3. **Leggi il risultato.** Poi prova **Trova le impostazioni migliori** con il tuo modello preferito.

## Per saperne di più

- 📖 **[Guida completa](docs/GUIDA.md)**: installazione, ogni schermata, motori, problemi comuni · [English](docs/GUIDE.md)
- 🛠️ **[Per sviluppatori](docs/DEVELOPMENT.md)** (in inglese): compilazione, test, architettura
