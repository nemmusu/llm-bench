# GPU Bench

Misura le prestazioni della tua GPU NVIDIA con l'inferenza LLM: caricamento a freddo e a caldo, token/s in lettura e in generazione, primo token, latenza tra token, più utenti insieme, VRAM e consumi. Funziona con **llama.cpp** (nativo o Docker) e **vLLM** (Docker, o nativo su Linux), su **Windows e Linux**.

- Pensato per chi non è esperto: installa da solo motori e modelli, spiega i numeri a parole, ogni problema ha un pulsante che lo risolve.
- Completo per chi è esperto: tutti i parametri di avvio, comando esatto copiabile, confronto tra risultati, esportazione.
- Ogni benchmark viene salvato con il comando usato: quando cerchi un modello vedi subito se l'hai già provato e quanto andava.

Guida per l'utente: [docs/GUIDA.md](docs/GUIDA.md).

## Sviluppo

```
npm install
npm run build      # main, preload, core (esbuild) + interfaccia (Vite)
npm start          # apre l'app Electron
npm run validate   # lint, typecheck, confini architetturali, test unitari/integrazione, E2E, copertura 100%
npm run dist       # installer Windows (NSIS + portable) o pacchetti Linux (.deb + AppImage)
```

Architettura:

- `src/main`: guscio Electron (finestra, dialoghi, segreti cifrati).
- `src/core`: server HTTP locale (127.0.0.1, token per sessione) in un utility process: motori, modelli, download, benchmark, telemetria GPU, Docker.
- `src/renderer`: interfaccia React (design system proprio, it/en).
- `src/contract`: schemi condivisi (zod) e tipi delle risposte.

Test:

- `test/unit`, `test/integration`: Vitest, con servizi finti deterministici (`test/fakes`: motore LLM, nvidia-smi, Docker, GitHub, Hugging Face).
- `test/e2e`: Playwright sulla vera app Electron, scritti come li userebbe una persona (ruoli ed etichette visibili), con controllo di accessibilità axe.
- `scripts/coverage.mjs`: unisce la copertura di unit ed E2E; il gate è il 100% su ogni file.
