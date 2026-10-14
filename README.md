<p align="center"><img src="resources/icons/icon-256.png" width="88" alt=""></p>

<h1 align="center">LLM Bench</h1>

<p align="center"><b>Quanto è veloce la tua scheda video NVIDIA con l'intelligenza artificiale?</b><br>
LLM Bench la mette alla prova con i modelli linguistici sul tuo PC e ti risponde in parole semplici.</p>

<p align="center"><a href="docs/GUIDA.md">Guida completa</a> · <a href="README.en.md">English</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/benchmark-dark.png">
  <img src="docs/screenshots/benchmark.png" alt="La pagina Benchmark di LLM Bench: motore, modello e durata già scelti, il pulsante Avvia benchmark, la scheda video dal vivo e gli ultimi risultati">
</picture>

Un **modello linguistico** (LLM) è il "cervello" di programmi come ChatGPT. Molti si possono scaricare e far girare sul proprio PC: LLM Bench ti dice quanto bene ci riesce la tua scheda video. Funziona su **Windows e Linux**, in italiano o in inglese.

Non serve sapere nulla di tecnico: LLM Bench installa da solo quello che manca e ti chiede sempre conferma prima di scaricare qualcosa.

## Cosa fa

- **Misura la tua scheda video** con i modelli che vuoi: quanto ci mette a caricarli, quanto velocemente leggono e scrivono, quanto aspetti la prima parola, come regge quando più persone li usano insieme, quanta memoria video e quanta corrente consuma.
- **Ti spiega i numeri a parole**, per esempio: «Scrive circa 177 parole al secondo: molto più veloce di quanto tu riesca a leggere».
- **Trova le impostazioni migliori** da solo: prova le combinazioni e ti dice quale va più veloce e quanto testo regge la tua scheda.
- **Confronta** test e modelli fianco a fianco, sempre a parità di condizioni.
- **Trova e scarica i modelli** da Hugging Face e ti dice prima se **entrano nella tua scheda**.
- **Tiene acceso un modello** per i tuoi programmi (chat, editor, assistenti), anche a finestra chiusa, dall'area di notifica.
- **Usa più motori** (i programmi che fanno girare i modelli): llama.cpp, vLLM, SGLang, NInfer e le versioni modificate. Li installa e li aggiorna con un pulsante.

## Cosa ti serve

- Una **scheda video NVIDIA** con il suo **driver**. Se il driver manca o è troppo vecchio, LLM Bench te lo dice e apre la pagina giusta per scaricarlo.
- **Windows 10 o 11** (64 bit) oppure **Linux** (Ubuntu, Debian e derivate; l'AppImage funziona anche su altre distribuzioni).
- Un po' di spazio su disco per i modelli: da pochi GB per i più piccoli a qualche decina per i più grandi.

Nient'altro: il motore llama.cpp lo scarica e lo prepara LLM Bench al primo test.

Facoltativo, solo per alcuni motori:

- **Docker** per vLLM e SGLang (e per llama.cpp in un contenitore). Su Windows è Docker Desktop: se manca, LLM Bench lo installa e lo accende per te.
- **WSL 2** con una distribuzione Linux (per esempio Ubuntu 24.04) per usare NInfer su Windows.

## Installazione

> **Dove trovo i file di installazione?** Quando ci saranno le versioni pubblicate, le troverai nella pagina **Releases** di questo repository. Per ora si creano dal codice con `npm run dist`: vedi [Per sviluppatori](#per-sviluppatori).

### Windows

1. Apri **`LLM-Bench-Setup-x.y.z.exe`** (x.y.z è il numero di versione).
2. Scegli la lingua, lascia la cartella proposta e premi **Installa**. Windows ti chiede una volta il permesso di amministratore: LLM Bench si installa in *Programmi*, per tutti gli utenti del PC.
3. Alla fine LLM Bench si apre da solo. Lo ritrovi sul desktop e nel menu Start.

> Se Windows mostra «Windows ha protetto il PC», clicca **Ulteriori informazioni** → **Esegui comunque**. Succede con i programmi nuovi, non ancora diffusi.

**Disinstallare.** Come ogni programma: Impostazioni di Windows → **App** → **App installate** → **LLM Bench** → **Disinstalla**. I tuoi risultati e le impostazioni restano in `%APPDATA%\LLM Bench`, i modelli nella cartella `LLM Bench\models` della tua cartella utente: cancellali tu se non ti servono più.

Preferisci non installare niente? C'è anche la versione **portable**, `LLM-Bench-x.y.z-portable.exe`: si apre con un doppio clic.

### Linux

- **Pacchetto .deb** (Ubuntu, Debian e derivate; consigliato): aprilo con il gestore dei pacchetti, oppure da terminale:

  ```bash
  sudo apt install ./llm-bench-x.y.z-amd64.deb
  ```

  LLM Bench compare tra le applicazioni. Per toglierlo: `sudo apt remove llm-bench`.
- **AppImage** (qualunque distribuzione): rendila eseguibile e aprila.

  ```bash
  chmod +x llm-bench-x.y.z-x86_64.AppImage
  ./llm-bench-x.y.z-x86_64.AppImage
  ```

> **Da GPU Bench a LLM Bench.** Fino alla versione 0.3 il programma si chiamava GPU Bench. Al primo avvio LLM Bench prende i tuoi risultati, le impostazioni e i motori; i modelli restano dove sono ([dettagli nella guida](docs/GUIDA.md#da-gpu-bench-a-llm-bench)).

## Il primo test in 3 passi

**1. Apri LLM Bench.** La prima volta controlla il PC (driver, scheda video, spazio libero) e ti propone da dove partire: il motore llama.cpp, un modello adatto alla tua scheda e un test *Rapido* di un paio di minuti. Se manca qualcosa, accanto c'è un pulsante che lo sistema.

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/primo-avvio-dark.png">
  <img src="docs/screenshots/primo-avvio.png" width="560" alt="Il primo avvio: la configurazione consigliata per la scheda, con motore, modello e durata">
</picture></p>

**2. Premi «Avvia benchmark».** Se prima serve scaricare qualcosa, LLM Bench ti dice cosa e quanto pesa e aspetta il tuo sì. Durante il test vedi a che punto è, la velocità, la memoria video, la temperatura e i watt. Puoi annullare quando vuoi.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/test-in-corso-dark.png">
  <img src="docs/screenshots/test-in-corso.png" alt="Un test in corso: le fasi, la velocità di scrittura e di lettura, la memoria video, la temperatura e i watt dal vivo">
</picture>

**3. Leggi il risultato.** In cima trovi il punteggio e una frase che lo spiega; sotto, ogni numero con il suo significato (il **?** accanto a ogni voce lo spiega). I riquadri colorati ti dicono se qualcosa può aver falsato la misura e come rimediare.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/risultato-dark.png">
  <img src="docs/screenshots/risultato.png" alt="Un risultato: il Punteggio LLM Bench, la velocità spiegata a parole, gli avvisi e le misure principali">
</picture>

Quanto dura un test lo scegli tu:

| Durata | Quanto ci vuole | Cosa misura |
|---|---|---|
| **Rapido** | circa 2 minuti | Un caricamento e un testo di prova: per farti un'idea |
| **Standard** | circa 6 minuti | Caricamento a freddo e a caldo, testi corti e lunghi, più utenti insieme. Sul modello di riferimento dà il Punteggio LLM Bench |
| **Completo** | 15–30 minuti | Tutto, ripetuto più volte, per la massima precisione |
| **Trova le impostazioni migliori** | te lo dice prima | Vedi [più sotto](#trovare-le-impostazioni-migliori) |

## Capire i risultati

| Numero | Cosa vuol dire |
|---|---|
| **Generazione** (tok/s) | Quanto velocemente il modello **scrive**. Un *token* è un pezzo di parola: 100 token sono circa 70 parole |
| **Lettura prompt** (tok/s) | Quanto velocemente **legge** il testo che gli dai: la domanda, un documento, il codice. Conta molto con i testi lunghi |
| **Primo token** (ms) | Quanto aspetti prima che compaia la prima parola. Sotto i 200 ms sembra istantaneo |
| **Caricamento a freddo / a caldo** | Quanto ci mette ad aprire il modello: dal disco la prima volta, oppure quando il PC lo tiene già in memoria |
| **VRAM di picco** | Quanta memoria della scheda video ha usato al massimo |
| **Più utenti** | Quanto scrive in tutto, e per ciascuno, quando più persone lo usano insieme |
| **Efficienza** (tok/J) | Quanto lavoro fa per ogni unità di energia: più è alto, meno consuma |
| **Punteggio LLM Bench** | Un numero solo per confrontare le schede: 1.000 è una RTX 5090 con llama.cpp sul modello di riferimento. Si calcola con il test Standard su quel modello |

**Ogni velocità dice con quanto testo è stata misurata.** Un modello rallenta quando ha già molto testo davanti (il *contesto*): per questo LLM Bench non scrive mai un numero da solo. Trovi sempre «scrittura con 32.768 token già nel contesto» oppure «lettura di un prompt da 512 token»; nelle tabelle, la lunghezza è sotto il numero. Due velocità si confrontano solo alla stessa lunghezza, e il Confronta lo fa per te.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/risultati-dark.png">
  <img src="docs/screenshots/risultati.png" alt="La pagina Risultati: ogni test con le sue velocità di scrittura e lettura, ciascuna con la lunghezza a cui è stata misurata">
</picture>

Nella pagina **Risultati** ritrovi tutti i test, con filtri per modello, scheda e motore. La vista **Configurazioni** li raggruppa per modo di avvio, dal più veloce. Ogni risultato si esporta in CSV (anche per Excel in italiano), JSON, Markdown o HTML, e con **Usa questo preset** riparti con le stesse impostazioni.

Gli avvisi più comuni:

- **Altri programmi stavano usando la GPU**: un gioco, un altro modello o una macchina virtuale occupavano la scheda; i numeri possono essere un po' più bassi.
- **Il modello non è entrato tutto nella memoria della scheda**: su Windows il resto finisce nella RAM del PC e tutto va 10–15 volte più piano. LLM Bench te lo dice prima di partire, durante il test e nel risultato, con i pulsanti per rimediare (cache più piccola, meno contesto, *Trova le impostazioni migliori*).

## Trovare le impostazioni migliori

Scegli la durata **Trova le impostazioni migliori**: LLM Bench ti dice prima quanto ci vorrà per quel modello sulla tua scheda (da pochi minuti a più di mezz'ora per i modelli grandi). Poi avvia il modello più volte e prova da solo:

- la **cache KV**, la memoria dove il modello tiene il testo già letto: le versioni compresse occupano meno e lasciano spazio a più testo;
- il **contesto più grande** che entra tutto nella memoria della scheda;
- le impostazioni che cambiano la velocità.

Alla fine ti mostra la combinazione consigliata, quanto va veloce a ogni lunghezza di testo e il comando esatto. **Usa questo preset** la porta nel Benchmark o in un server.

## Confrontare i modelli

Premi **Confronta** accanto a un test, oppure **Confronta modelli** nella pagina Risultati e scegline da 2 a 4: per ognuno LLM Bench prende la configurazione più veloce misurata sulla tua scheda. In cima una frase ti dice chi scrive e chi legge più in fretta, e di quanto. Sotto, ogni misura ha il migliore evidenziato e gli altri detti a parole («2,2 volte più lento», «−16 %»).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/confronta-dark.png">
  <img src="docs/screenshots/confronta.png" alt="Il confronto di quattro modelli: chi va più veloce, a parità di contesto, e ogni misura con il migliore evidenziato">
</picture>

Le velocità sono confrontate sempre alla **stessa lunghezza di contesto** (la scegli in **Confronta a**); dove un test non l'ha misurata c'è scritto «non misurato», mai una stima. L'indirizzo della pagina contiene il confronto, quindi puoi riaprirlo o condividerlo, e la **Scheda da condividere** lo riassume in una pagina.

## Trovare e scaricare modelli

Nella pagina **Modelli** trovi quelli che hai già sul PC (anche quelli di LM Studio, Ollama e Hugging Face), i consigliati per la tua scheda e la ricerca su Hugging Face, con il filtro **Entra nella mia GPU**.

Ogni modello ha più **versioni**: più compresse occupano meno memoria, meno compresse sono un po' più precise. LLM Bench sceglie da solo la migliore che entra nella tua scheda (**Consigliata**) e accanto a ognuna ti dice se ci sta:

| Giudizio | Cosa vuol dire |
|---|---|
| **Entra perfettamente** | Usa meno del 60 % della memoria della scheda: resta spazio anche per testi lunghi |
| **Entra bene** | Usa meno dell'85 % |
| **Al limite** | Usa quasi tutta la memoria: chiudi gli altri programmi prima del test |
| **Entra in parte** | Una parte resta nella memoria del PC: funziona, ma più lentamente |
| **Non entra** | È troppo grande per questa scheda |

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/modello-versioni-dark.png">
  <img src="docs/screenshots/modello-versioni.png" width="720" alt="La pagina di un modello: ogni versione con la sua dimensione e il giudizio Al limite, Entra bene o Non entra; quella consigliata è già scelta">
</picture></p>

Il download si mette in pausa e riprende da solo se la connessione cade, e quello che hai già non si riscarica mai. Se un modello cambia su Hugging Face, LLM Bench te lo dice e lo aggiorna con **Aggiorna**, scaricando solo i file cambiati. Per i modelli con licenza da accettare (Llama, Gemma…) ti chiede una volta il token di Hugging Face e lo salva cifrato.

## Tenere acceso un server

Vuoi usare un modello nei tuoi programmi, senza test? Apri **Server** e premi **Avvia un server**: scegli il modello, il motore e le impostazioni (le migliori dei tuoi test, un tuo preset o le tue), e LLM Bench ti mostra cosa avvierà prima di farlo. Ogni server acceso ha l'**indirizzo** e il **nome del modello** da copiare, compatibili con le API di OpenAI, ed esempi pronti per il terminale, per Python e per programmi come Open WebUI, Continue o Chatbox.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/server-dark.png">
  <img src="docs/screenshots/server.png" alt="La pagina Server: un server acceso con il suo indirizzo, il nome del modello da copiare ed esempi d'uso">
</picture>

**Dall'area di notifica.** Se chiudi la finestra con un server acceso, LLM Bench resta vicino all'orologio e il server continua a funzionare. Dal menu copi l'indirizzo, fermi o riavvii un server, avvii un **preset** o esci.

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/area-di-notifica-dark.png">
  <img src="docs/screenshots/area-di-notifica.png" width="300" alt="Il menu nell'area di notifica: il server acceso, Copia indirizzo, Ferma, Riavvia, Avvia preset, lo stato di Docker">
</picture></p>

**Preset.** Con **Salva come preset** ricordi modello, motore, impostazioni e porta: lo riavvii con un clic. Se lo segni **Avvia all'apertura di LLM Bench** parte da solo; in Impostazioni puoi anche far partire LLM Bench all'accesso al PC.

Di solito il server risponde solo al tuo PC. Con **Rendi raggiungibile dalla rete locale** lo usano anche gli altri dispositivi di casa o dell'ufficio, con una chiave che LLM Bench genera per te.

## Motori

I motori sono i programmi che fanno girare i modelli. Ne basta uno: se non sai quale scegliere, lascia **llama.cpp**.

| Motore | A cosa serve | Cosa ti serve |
|---|---|---|
| **llama.cpp** | Il più semplice: legge i modelli GGUF, i più diffusi | Niente: LLM Bench lo scarica da solo (anche in Docker, se vuoi) |
| **vLLM** | Pensato per servire molti utenti insieme | Docker; su Linux anche installato sul PC |
| **SGLang** | Veloce con molti utenti e con testi che si ripetono | Docker; su Linux anche installato sul PC |
| **NInfer** e **NInfer-all** | Fatti apposta per alcuni modelli Qwen su una RTX 5090. NInfer-all legge anche i modelli GGUF-NInfer | Una RTX 5090; su Windows WSL 2. LLM Bench lo scarica e lo compila per te |
| **Motori personalizzati** | Una versione modificata (fork) di llama.cpp, vLLM, SGLang o NInfer, o un tuo programma con API OpenAI | Dove si trova: LLM Bench lo prova prima di usarlo |

Ogni motore ha la sua scheda nella pagina **Motori**, con lo stato, le versioni e i pulsanti per installare, scegliere la versione e **aggiornare**: quando c'è una versione nuova vedi «Aggiornamento disponibile» e il pulsante **Aggiorna**. Prima di aggiornare LLM Bench ti mostra i comandi esatti che eseguirà; la versione di prima resta sul PC finché la nuova non funziona.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/motori-dark.png">
  <img src="docs/screenshots/motori.png" alt="La pagina Motori: le schede di llama.cpp, Docker e vLLM con il loro stato e le versioni da scaricare">
</picture>

<!-- docs/screenshots/motori-ninfer.png (e -dark): la scheda NInfer con NInfer-all, da aggiungere quando la nuova scheda NInfer è su main. -->

## Se qualcosa non va

Ogni problema che LLM Bench riconosce ha una spiegazione e, quasi sempre, un pulsante che lo risolve. I casi più comuni:

- **«Docker non risponde».** Succede quando il **Resource Saver** di Docker Desktop lo spegne dopo qualche minuto senza contenitori e lo spegnimento si blocca a metà. Premi **Riavvia Docker**, dall'avviso in cima alla finestra o dal menu dell'area di notifica: immagini e modelli restano, e i server di LLM Bench ripartono da soli. Per evitarlo, in Docker Desktop apri Impostazioni → **Resources** → **Advanced** e disattiva **Resource Saver**.
- **«Docker non è avviato».** Premi **Avvia Docker**: LLM Bench lo accende e continua da solo.
- **«La memoria della scheda video è occupata».** Un gioco, un altro modello o una macchina virtuale stanno usando la scheda. Chiudili, oppure premi **Continua comunque** (il risultato lo segnerà). Anche un server acceso occupa la scheda: LLM Bench ti propone di fermarlo prima del test.
- **«Il modello non entra tutto nella scheda video».** Usa una versione più compressa del modello, la cache **q4_0** (la memoria del testo occupa circa un quarto), meno contesto, oppure **Trova le impostazioni migliori**.
- **NInfer-all sulla RTX 5090.** Per compilarlo serve il toolkit **CUDA 13.1 o più recente**, da installare dal sito di NVIDIA (su Windows dentro la distribuzione WSL): quello dei pacchetti di Ubuntu è troppo vecchio per la RTX 5090. LLM Bench lo controlla prima di compilare e ti dice cosa manca.
- **«Driver NVIDIA non installato» o «troppo vecchio».** Premi il pulsante che apre la pagina di NVIDIA, installa il driver e poi **Ricontrolla**.

Altri casi e tutti i dettagli sono nella [guida completa](docs/GUIDA.md#9-problemi-comuni).

## Per sviluppatori

Serve **Node.js 22** o più recente.

```bash
npm install
npm run build        # main, preload e core (esbuild) + interfaccia (Vite)
npm start            # apre l'app Electron
npm run validate     # lint, tipi, confini architetturali, test unitari e di integrazione, E2E, copertura 100%
npm run ci:docker    # la stessa validazione in un contenitore Linux pulito, sul commit attuale
npm run dist         # installer Windows (NSIS + portable) o pacchetti Linux (.deb + AppImage)
```

- **CI.** Non c'è una CI su GitHub, per scelta: la CI è locale. `npm run ci:docker` valida il commit attuale (`git HEAD`) in Linux, dentro Docker, con gli E2E sotto Xvfb (`-- --fast` li salta).
- **Pacchetti Linux da Windows.** `node scripts/dist-linux.mjs` costruisce il .deb e l'AppImage nell'immagine Docker di electron-builder.
- **Screenshot.** `node scripts/mockups.mjs` fotografa le schermate principali in `.qa/mockups` (chiaro e scuro) con dati realistici e servizi finti, senza toccare GPU, impostazioni o modelli veri. `node scripts/mockups.mjs --only=readme` rigenera le immagini di questo README in `docs/screenshots`.

**Architettura**

- `src/main`: il guscio Electron (finestra, area di notifica, dialoghi, segreti cifrati).
- `src/core`: un server HTTP locale (127.0.0.1, con un token per sessione) in un utility process: motori, modelli, download, benchmark, telemetria della GPU, Docker, server.
- `src/renderer`: l'interfaccia React (design system proprio, italiano e inglese).
- `src/contract`: gli schemi condivisi (zod) e i tipi delle risposte.

**Test**

- `test/unit`, `test/integration`: Vitest, con servizi finti deterministici in `test/fakes` (motore LLM, nvidia-smi, Docker, WSL, GitHub, Hugging Face).
- `test/e2e`: Playwright sulla vera app Electron, scritti come li userebbe una persona (ruoli ed etichette visibili), con il controllo di accessibilità axe.
- `scripts/coverage.mjs` unisce la copertura di unit ed E2E: il limite è il 100 % su ogni file.

Le idee per la stima della memoria video vengono in parte da [llmfit](https://github.com/AlexsJones/llmfit) (licenza MIT).
