# GPU Bench: guida rapida

GPU Bench misura quanto è veloce la tua scheda video NVIDIA con l'intelligenza artificiale: scarica e avvia i modelli, li fa lavorare con testi di prova e ti dice, in parole semplici, quanto sono veloci.

Non serve sapere nulla di tecnico: il programma installa da solo quello che manca e ti chiede conferma prima di scaricare qualunque cosa.

## 1. Installazione

**Windows**: apri `GPU-Bench-Setup-x.y.z.exe` e segui la procedura. Non servono permessi da amministratore. Se preferisci non installare nulla, usa la versione *portable* (`GPU-Bench-x.y.z-portable.exe`).

> Al primo avvio Windows potrebbe mostrare "Windows ha protetto il PC": clicca **Ulteriori informazioni** → **Esegui comunque**. Succede con i programmi nuovi non ancora diffusi.

**Linux** (Ubuntu, Debian e derivate): apri il file `gpu-bench-x.y.z-amd64.deb` con il gestore dei pacchetti, oppure da terminale `sudo apt install ./gpu-bench-x.y.z-amd64.deb`. In alternativa c'è l'AppImage.

L'unica cosa che deve già esserci è il **driver NVIDIA**. Se manca o è troppo vecchio, GPU Bench te lo dice e ti porta alla pagina giusta per scaricarlo.

## 2. Primo avvio: il controllo del sistema

La prima schermata, **Benvenuto**, controlla il PC e mostra una lista a semafori:

| Voce | Cosa significa |
|---|---|
| Driver NVIDIA | La versione del driver e la versione CUDA che supporta |
| Scheda video | Il modello della scheda e quanta memoria video (VRAM) ha |
| Motore llama.cpp | Il programma che fa girare i modelli. Se manca, un pulsante lo installa (circa 500 MB) |
| Modelli | I modelli già presenti sul PC (anche quelli di LM Studio, Ollama e Hugging Face) |
| Spazio su disco | Lo spazio libero nella cartella dei modelli |
| Docker | Facoltativo: serve solo per usare vLLM o llama.cpp in un container |

Ogni voce in rosso o arancione ha **un solo pulsante** che la sistema.

## 3. Fare un benchmark

Nella pagina **Benchmark** scegli tre cose:

1. **Motore**: lascia *llama.cpp* (consigliato) se non sai cosa scegliere.
2. **Modello**: i modelli consigliati per la tua scheda hanno un'etichetta colorata:
   - **Entra perfettamente / Entra bene**: nessun problema;
   - **Al limite**: chiudi gli altri programmi prima del test;
   - **Entra in parte**: funziona, ma più lentamente;
   - **Non entra**: troppo grande per la tua scheda.
   Se un modello ha l'etichetta **Provato su questa GPU**, l'hai già misurato: vedi subito quanto andava. Se l'unico test fatto usava la RAM condivisa (vedi sotto) l'etichetta dice **Provato: usava la RAM condivisa**, senza numeri: quelli non erano i veri della scheda.
3. **Durata**: *Rapido* (circa 2 minuti), *Standard* (circa 6 minuti, è quello del punteggio), *Completo* (15–30 minuti) o *Trova le impostazioni migliori* (dipende dal modello: GPU Bench ti dice quanto prima di iniziare, vedi sotto).

Premi **Avvia benchmark**. Se serve scaricare qualcosa, GPU Bench ti mostra cosa e quanto pesa e aspetta la tua conferma.

Durante il test vedi in tempo reale le fasi, la velocità, la memoria video, la temperatura e i watt. Puoi annullare in qualsiasi momento.

Se il motore smette di rispondere (nessuna parola per un minuto; prima della prima parola, il tempo che servirebbe per leggere il prompt anche molto lentamente) GPU Bench ferma il test con **Il motore non ha risposto in tempo** invece di aspettare per sempre.

### Quando il modello non entra nella scheda (RAM condivisa)

Su Windows, se il modello con il contesto scelto non entra tutto nella memoria video, il driver non dà errore: mette il resto nella **RAM condivisa** del PC e tutto diventa circa 10–15 volte più lento. I numeri di un test così non sono quelli veri della scheda.

- **Prima di iniziare**, l'anteprima te lo dice ("Il modello non entra tutto nella scheda video") con quanto serve e quanto hai libero, e ti offre due correzioni con un clic: **Usa cache q4_0** (la memoria del testo occupa circa un quarto) e **Contesto massimo che entra**. Su Linux, invece, il motore si fermerebbe per memoria esaurita, e l'avviso lo dice.
- **Durante il test**, appena GPU Bench se ne accorge (la RAM condivisa usata dal motore, oppure una generazione molto più lenta dei tuoi test precedenti con lo stesso modello) compare un avviso con **Annulla test**.
- **Nel risultato**, l'avviso è in cima, con quanta RAM condivisa è stata usata e quanto era più lento del normale, e tre pulsanti: **Trova le impostazioni migliori**, **Riprova con cache q4_0** e **Riprova con meno contesto**. La memoria video mostra anche "+ … nella RAM condivisa" e la stabilità dice "Falsata dalla RAM condivisa".

- **Test fatti con versioni precedenti**, che non misuravano la RAM condivisa: GPU Bench li controlla quando li legge. Se uno è stato molto più lento (meno di 0,4 volte) degli altri dello stesso modello su questa scheda, con ogni probabilità il modello era finito nella RAM condivisa: il risultato lo dice in cima ("Probabilmente il modello non è entrato tutto…", con quante volte era più lento) con gli stessi pulsanti, e il test è segnato come gli altri. Il file del test non viene modificato.

Questi test sono segnati **RAM condivisa** in Risultati, in Configurazioni e negli Ultimi risultati, e non contano per le stime: durata prevista, memoria, "Provato su questa GPU" e il server consigliato usano solo i test che entravano nella scheda. La stima della memoria ignora anche le misure arrivate al limite della scheda (a meno di 1 GB, o del 3 % sulle schede più grandi, dalla sua memoria totale): lì è la scheda stessa a tagliare il numero, che non dice quanto serviva davvero.

### Usare il modello nei tuoi programmi

Vuoi solo accendere il modello per una chat, un editor o un assistente, senza test? Premi **Avvia solo il server** accanto ad *Avvia benchmark* (oppure **Avvia server** accanto a un modello in **Modelli → Sul tuo PC**). GPU Bench ti mostra prima cosa farà:

- il **contesto**, cioè quanto testo il modello può leggere in una volta: scelto da GPU Bench perché entri bene nella tua scheda (in modalità esperto puoi deciderlo tu);
- se il modello **entra** nella memoria video, cosa va scaricato prima e il comando esatto.

Quando il server è pronto copi il suo indirizzo (compatibile OpenAI) e lo incolli nell'altro programma. Il server resta acceso finché non premi **Ferma** nel riquadro **Server attivi** della pagina Benchmark o chiudi GPU Bench; mentre è acceso non puoi fare benchmark.

Se hai già fatto **Trova le impostazioni migliori** con quel modello su questa scheda, *Avvia solo il server* usa il contesto e le impostazioni consigliate da quel test (te lo dice nella finestra di conferma).

### Trova le impostazioni migliori

Scegli la durata **Trova le impostazioni migliori** e poi *Veloce* o *Accurata*: accanto a ognuna GPU Bench ti dice quanto ci vorrà **per quel modello su questa scheda** (per esempio "~20 min"). Un modello piccolo richiede pochi minuti; uno grande con un contesto di 256K anche più di mezz'ora, perché leggere prompt così lunghi richiede tempo anche a una scheda veloce. GPU Bench avvia il modello più volte e prova da solo:

- la **cache KV** (la memoria che tiene il testo già letto): prima *f16*, poi *q8_0*, poi *q4_0*, che occupa circa un quarto e lascia spazio a molto più contesto. Con le cache ridotte attiva sempre la *flash attention* e usa lo stesso tipo per K e V;
- il **contesto più grande** che entra tutto nella memoria video, per ogni tipo di cache;
- le impostazioni che cambiano la velocità: *flash attention*, *batch* e *ubatch* (quanti token del prompt la scheda legge insieme: più alto legge più in fretta ma usa più memoria) e, se il modello ha già un file "draft" o "MTP" nella libreria, la generazione speculativa.

Poi misura ogni combinazione **riempiendo il contesto un po' alla volta** (1K, 4K, 8K, 16K… token) e ti mostra i numeri fianco a fianco: la più veloce a ogni lunghezza e quella consigliata, cioè la più veloce tra quelle che arrivano al contesto più grande. Ogni prova ha il suo comando esatto.

Per il contesto più grande GPU Bench non misura tutto a ogni tentativo: avvia il modello, controlla la RAM condivisa e fa una prova breve (1K) da confrontare con la prima. Tra l'ultimo contesto che entra e il primo che non entra cerca a metà, finché resta poco spazio: nella tabella **Contesto massimo per tipo di cache** "Limite trovato" vuol dire che il contesto subito sopra non entrava, "Almeno …" che più in alto non ha provato (la stima lo escludeva, o il tempo era finito).

Su Windows, quando un modello non entra nella memoria video, il driver non dà errore: sposta una parte nella RAM del PC e tutto diventa circa 10–15 volte più lento. GPU Bench se ne accorge (memoria condivisa usata dal motore, oppure velocità crollata rispetto alla prima prova) e conta quella configurazione come "non entra".

La memoria del motore è controllata **per tutta la prova**, dal caricamento all'ultima misura, non solo all'inizio: certe prove entrano appena caricate e finiscono nella RAM condivisa alla prima richiesta, quando il motore prepara i suoi buffer di calcolo. Appena la RAM condivisa usata dal motore supera di oltre 768 MB quella di una prova che entra (la prima, più circa 1 MB ogni 1K di contesto in più; almeno 1 GB in tutto), oppure di 512 MB quando la memoria video è già piena (a meno di 1 GB, o del 3 %, dal totale), GPU Bench ferma subito quella prova, anche a metà di una richiesta, e la segna **Usa la RAM condivisa (lento)**.

Ogni richiesta della ricerca ha anche un suo **limite di tempo**: 5 volte quanto dovrebbe durare secondo le velocità della prima prova (mai meno di 30 secondi; minuti per i prompt molto lunghi). Se una richiesta lo supera, o il motore non manda nulla per un minuto, la prova è **Troppo lento: probabilmente usa la RAM condivisa**. In entrambi i casi la prova fermata compare subito nell'elenco delle prove, con il motivo, il motore viene spento e la ricerca continua con un contesto più piccolo. Mentre una prova aspetta la sua prima misura, gli indicatori di velocità dicono "in attesa della prima misura" invece di mostrare i numeri della prova precedente.

La ricerca ha un **tempo massimo** (la sua stima, con un po' di margine). Prima di ogni richiesta GPU Bench controlla se finirebbe in tempo: se no, non la inizia (per il tempo massimo della ricerca non interrompe mai una misura a metà: lo fanno solo la RAM condivisa e il limite di tempo di una richiesta, qui sopra) e lo scrive nel risultato. Se il tempo finisce prima di aver misurato tutto, il risultato tiene quello che ha misurato: le combinazioni **Misurata in parte (tempo finito)** sono confrontate con le stesse regole, una è comunque consigliata e **Usa questo preset** usa quella. Le richieste molto lunghe (oltre un minuto) vengono fatte una volta sola invece di ripeterle.

Se **annulli** la ricerca (o si ferma per un errore), il risultato tiene quello che aveva misurato fino a quel momento, con le stesse regole del tempo finito (**Misurata in parte (test annullato)**). Nella tabella **Contesto massimo per tipo di cache** le cache non ancora provate dicono **Non provato (test annullato)**, quella che stava cercando "Almeno …" con il contesto più grande che era entrato; "Nessun contesto è entrato tutto nella memoria video" compare solo quando ogni contesto provato con quella cache non entrava e la ricerca era finita. Allo stesso modo **Non provato (tempo finito)** e **Non provato (non serviva)** dicono perché una cache non è stata provata.

Solo se il modello non entra nemmeno con 4K di contesto e cache *q4_0*, GPU Bench prova a tenere una parte del modello sulla CPU (*--n-cpu-moe* per i modelli MoE, meno *-ngl* per gli altri): funziona, ma è più lento, e lo trovi segnato così.

In modalità esperto puoi aggiungere il controllo di **fedeltà**: lo stesso testo generato con la cache più precisa e con quella consigliata, per vedere quanti token restano uguali. È un'indicazione, non un test di qualità.

Il **contesto per gradi** misura 1K, 4K, 8K, 16K… (con *Veloce*, sui contesti lunghi: 1K, 4K, 16K, 64K…) e anche **200K** quando il contesto ci arriva, così i test di modelli e schede diverse si confrontano allo stesso punto.

In modalità esperto, **Cerca anche oltre il limite del modello (YaRN)** lascia che la ricerca vada oltre il contesto su cui il modello è stato addestrato, fino a 300K, 500K o al contesto che scegli: oltre quel limite ogni prova usa YaRN con il fattore giusto (contesto ÷ contesto di addestramento). Ci mette di più, e la qualità lassù non è garantita: GPU Bench misura solo velocità e memoria.

Il profilo **Completo** misura anche il **contesto per gradi** con le impostazioni scelte. Il testo di prova è un romanzo di circa 100.000 token: oltre quella lunghezza GPU Bench lo riusa a pezzi rimescolati, così nessun pezzo lungo si ripete; la velocità non cambia (conta quanti token riempiono il contesto, non cosa dicono).

## 4. Leggere i risultati

| Misura | In parole semplici |
|---|---|
| **Generazione (tok/s)** | Quanto velocemente il modello scrive. Un token è circa 0,7 parole |
| **Lettura prompt (tok/s)** | Quanto velocemente legge il testo che gli dai, importante con documenti lunghi |
| **Primo token (ms)** | Quanto aspetti prima che compaia la prima parola |
| **Caricamento a freddo** | Il tempo per caricare il modello dal disco la prima volta |
| **Caricamento a caldo** | Il tempo per ricaricarlo quando il PC lo tiene già in memoria |
| **VRAM di picco** | La memoria video usata dal modello nel momento di massimo |
| **Efficienza (tok/J)** | Quanti token per ogni joule di energia: più è alto, meno consuma |
| **Più utenti** | Quanto regge quando più persone lo usano insieme |

Gli avvisi gialli o azzurri ti dicono se un risultato potrebbe essere falsato, per esempio "altri programmi stavano usando la GPU", e cosa fare.

Nella scheda **Come è stato avviato** trovi il comando esatto usato (PowerShell o bash) da copiare, e i pulsanti per **rifare lo stesso test**, **usare le stesse impostazioni** o **avviare solo il server** con quella configurazione. In cima a ogni risultato c'è la configurazione in breve (contesto, cache KV, quello che cambia rispetto alle impostazioni predefinite) con **Usa questo preset** e **Avvia il server così** a portata di clic.

Nella pagina **Risultati**, la vista **Configurazioni** raggruppa i test per modo di avvio (stesso motore, modello, scheda e impostazioni): una riga per configurazione, dalla più veloce, con la mediana dei test che l'hanno misurata. **Confronta a** sceglie la profondità (quanti token di testo ha già davanti il modello) a cui confrontarle: si vedono solo numeri misurati davvero. **Usa questo preset** porta motore, modello e impostazioni nel Benchmark (con un riquadro che dice da quale test vengono); se il modello non è più sul PC viene riscaricato prima.

Puoi **confrontare** due risultati ed **esportarli** in CSV (anche nel formato per Excel italiano), JSON, Markdown o HTML.

## 5. Modelli

Nella pagina **Modelli**:

- **Sul tuo PC**: i modelli che hai, con quanto spazio occupano e come sono andati.
- **Scarica**: i consigliati per la tua scheda e la ricerca su Hugging Face, con filtri per formato, dimensione e "solo quelli che entrano".

GPU Bench sceglie da solo la versione (quantizzazione) migliore che entra nella tua scheda; se sei esperto puoi sceglierne un'altra. I download si possono mettere in pausa e riprendono da soli se la connessione cade.

Per i modelli che richiedono di accettare una licenza (per esempio Llama o Gemma) GPU Bench apre la pagina giusta e ti chiede il token di Hugging Face una sola volta: viene salvato cifrato.

### Comandi per questo modello

Alcuni modelli vanno avviati con comandi che si scoprono solo leggendo la loro scheda: un contesto più lungo con YaRN, il file MTP per scrivere più in fretta, un fork del motore. Scrivili una volta, nella sezione **Comandi per questo modello** della pagina del modello o con **Comandi** accanto a un modello di *Sul tuo PC*: Benchmark, *Trova le impostazioni migliori* (come punto di partenza) e *Avvia solo il server* li usano da soli.

- **Scegli da una ricetta pronta**: comandi già scritti, presi dalla documentazione dei motori. *Contesto esteso con YaRN* (300K, 500K: il fattore lo calcola GPU Bench), *Decodifica speculativa con MTP / modello draft* (il file MTP accanto al modello per llama.cpp, il metodo mtp per vLLM, EAGLE per SGLang), *Fork PrismML per modelli Bonsai*, *Modelli con immagini* (il proiettore mmproj), *NInfer per i modelli .ninfer*. «Usa» li aggiunge ai comandi del modello: li rivedi prima di salvare.
- **Scrivi i comandi**: per quali modelli (solo questo, o tutti quelli il cui nome contiene una parola e, se vuoi, con una certa quantizzazione), il contesto, il motore, il file MTP, il proiettore immagini, gli argomenti in più per ogni motore, le variabili d'ambiente, una nota e il link alla scheda. Sotto vedi il **comando completo** che ne viene fuori, mentre scrivi.
- Una ricetta che vale solo per questo modello vince su una che vale per tutta la famiglia. Salvarla vuota la rimuove.
- Se la ricetta usa un fork che non hai ancora indicato, **Indica dove si trova il fork** apre la pagina Motori con il fork già scelto per quel modello.

Nella pagina **Benchmark**, quando il modello scelto ha i suoi comandi, compare **Usa i comandi di questo modello** con quello che fanno (per esempio "YaRN 300K · MTP"): con l'interruttore spento il test parte con le impostazioni normali. In modalità esperto i valori della ricetta compaiono nei campi, segnati come tali; quello che scrivi tu li sostituisce, e te lo dice. Nel risultato, *Come è stato avviato* dice quali comandi sono stati usati, insieme al comando esatto.

## 6. Docker e vLLM (facoltativo)

vLLM è un motore pensato per servire molti utenti insieme. Su Windows funziona tramite Docker Desktop.

- Se Docker manca, la pagina **Motori** ha un pulsante che lo installa (vedrai la licenza di Docker e la richiesta di permessi di Windows).
- Se Docker è spento, il pulsante **Avvia Docker** lo accende.
- Su Linux GPU Bench ti mostra prima i comandi esatti che eseguirà per installare Docker e il supporto NVIDIA, poi ti chiede la password.

**Su Windows**: i modelli letti da Docker passano per una condivisione lenta. Il pulsante **Copia nello spazio Docker** li copia una volta nello spazio di Docker: i caricamenti diventano molto più veloci.

### SGLang

SGLang è un altro motore per servire molti utenti insieme e legge i modelli come vLLM: cartelle Hugging Face (safetensors), non file GGUF.

- **Windows**: funziona in Docker Desktop, come vLLM. Nella pagina **Motori** la scheda **SGLang (Docker)** ti fa scegliere la versione (quella consigliata è segnata) e la scarica. Se non l'hai ancora scaricata, il Benchmark te la propone prima di iniziare.
- **Linux**: in Docker oppure installato sul PC, in un suo ambiente Python che GPU Bench prepara per te.

I modelli scaricati per vLLM servono anche a SGLang: non li scarichi due volte.

### Motori personalizzati (fork e programmi tuoi)

Nella pagina **Motori**, sotto **Motori personalizzati**, premi **Aggiungi motore**:

1. **Tipo**: un fork di llama.cpp, di vLLM o di SGLang, oppure un **Programma con API OpenAI**.
2. **Dove si trova**: il programma sul PC, un'immagine Docker o, per un programma tuo, il comando che lo avvia. **Prova** legge versione e opzioni (`--version`, `--help`) senza caricare nessun modello.
3. **Opzioni**: argomenti in più e variabili d'ambiente da usare a ogni avvio, e i modelli per cui vuoi usarlo (parole nel nome, quantizzazioni).

Un fork funziona come il motore da cui deriva. Se non conosce un'impostazione di GPU Bench (per esempio `-ub`), GPU Bench te lo dice già nella prova: in quel caso userà il suo valore predefinito, e lo trovi scritto anche nell'anteprima e nel risultato. Se gli manca qualcosa di indispensabile (per esempio la porta), GPU Bench non lo avvia. Nei risultati il motore si chiama con il suo nome e la sua versione (per esempio "PrismML b7001"), separato da llama.cpp.

Per un **Programma con API OpenAI** scrivi il comando come in un terminale. GPU Bench sostituisce `{model}`, `{modelDir}`, `{port}`, `{host}`, `{ctx}` e `{alias}`, e `{port}` è obbligatorio. Il comando parte senza shell: niente `|`, `>` o `&&`, e i file `.bat`/`.cmd` vanno avviati con `cmd /c`. GPU Bench lo avvia, lo misura e lo ferma alla fine. Con `{alias}` lo riconosce e lo ferma anche dopo un riavvio improvviso.

Per i modelli Bonsai (quantizzazioni PQ2_0 e PTQ1_0) il Benchmark ti propone il motore pronto **Fork PrismML di llama.cpp**: devi solo dirgli dove si trova il suo llama-server.

### Aggiornare i motori

Le schede di vLLM, SGLang e dei motori personalizzati ti dicono se c'è una versione più nuova, per esempio "Aggiornamento disponibile: v0.5.21 → v0.5.22 · 9,8 GB". Prima di aggiornare GPU Bench ti mostra i comandi esatti che eseguirà, e parte solo quando confermi.

- **vLLM e SGLang in Docker**: scarica la versione nuova dell'immagine e la sceglie per i prossimi test. Quella di prima resta sul PC: puoi tornarci con **Usa** nell'elenco delle versioni.
- **vLLM e SGLang installati sul PC (Linux)**: aggiorna il loro ambiente con uv, alla versione più recente pubblicata.
- **Un motore personalizzato in Docker**: scarica la versione più nuova dell'immagine. Se l'immagine non è su Docker Hub, GPU Bench non può sapere se ce n'è una più nuova, ma può scaricarla di nuovo.
- **Un fork di llama.cpp compilato da te da una cartella git**: **Controlla aggiornamenti** ti dice quanti commit nuovi ci sono. **Aggiorna** esegue `git pull --ff-only` e poi ricompila con `cmake --build`. Se nella cartella ci sono modifiche tue non salvate, GPU Bench non tocca niente e te lo dice.
- **Tutto il resto** (un programma tuo, un fork installato in altro modo): lo aggiorni con i suoi strumenti.

## 7. Misura "a freddo" reale

Per misurare davvero il caricamento dal disco, il modello non deve essere già nella memoria del PC.

- **Linux**: GPU Bench lo fa da solo, senza permessi speciali.
- **Windows**: serve un'attivazione una tantum in **Impostazioni → Misure a freddo reali**. Windows chiede il permesso da amministratore una volta sola; viene creata un'operazione pianificata che, prima di ogni misura a freddo, svuota la cache dei file. Si può disattivare in qualsiasi momento dalle stesse impostazioni.

Senza attivazione i risultati portano l'avviso "misura a freddo non garantita".

## 8. Condividere i risultati tra più PC

In **Impostazioni → Cartella dei risultati** puoi scegliere una cartella condivisa o sincronizzata (OneDrive, Syncthing, una cartella di rete). Ogni PC salva i propri risultati in file separati, quindi non ci sono conflitti: ogni PC vede anche quelli degli altri, separati per scheda video.

## 9. Problemi comuni

| Problema | Cosa fare |
|---|---|
| "Driver NVIDIA mancante o troppo vecchio" | Premi il pulsante per aprire la pagina NVIDIA, installa l'ultimo driver e premi **Ricontrolla** |
| "La memoria video è occupata" | Chiudi gli altri programmi che usano la GPU (giochi, altri modelli, macchine virtuali) oppure premi **Continua comunque** |
| "Memoria video esaurita" | Scegli un modello più piccolo o una versione più compressa; in modalità esperto riduci il contesto |
| "Il motore non ha risposto in tempo" | Riprova; se succede ancora, il modello probabilmente non entra nella memoria video: usa la cache q4_0, meno contesto o **Trova le impostazioni migliori** |
| "Docker non è avviato" | Premi **Avvia Docker** |
| "Serve accettare la licenza" | Apri la pagina del modello su Hugging Face, accetta e salva il tuo token in Impostazioni |

## 10. Modalità esperto

Attiva **Modalità esperto** nella pagina Benchmark per impostare a mano contesto, strati sulla GPU, flash attention, tipo di cache, batch, thread, richieste parallele, argomenti extra, variabili d'ambiente, eseguibile llama-server personalizzato, immagine Docker, lunghezze dei prompt, ripetizioni e livelli di concorrenza. L'**Anteprima comando** mostra sempre la riga esatta che verrà eseguita.

**Contesto oltre il limite del modello (YaRN)**: 300K, 500K o un altro contesto. GPU Bench imposta il contesto e YaRN con fattore = contesto scelto ÷ contesto di addestramento (llama.cpp *--rope-scaling yarn --rope-scale --yarn-orig-ctx*, vLLM e SGLang con il loro *rope_scaling*), e il contesto per gradi misura fino a lì, anche oltre il tempo che il profilo darebbe (la durata prevista te lo dice). Oltre il contesto di addestramento la qualità delle risposte non è garantita: il test misura solo velocità e memoria.

---

Le idee per la stima della memoria video vengono in parte da [llmfit](https://github.com/AlexsJones/llmfit) (licenza MIT).
