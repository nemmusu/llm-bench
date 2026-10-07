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
   Se un modello ha l'etichetta **Provato su questa GPU**, l'hai già misurato: vedi subito quanto andava.
3. **Durata**: *Rapido* (circa 2 minuti), *Standard* (circa 6 minuti, è quello del punteggio), *Completo* (15–30 minuti) o *Trova le impostazioni migliori* (5–20 minuti, vedi sotto).

Premi **Avvia benchmark**. Se serve scaricare qualcosa, GPU Bench ti mostra cosa e quanto pesa e aspetta la tua conferma.

Durante il test vedi in tempo reale le fasi, la velocità, la memoria video, la temperatura e i watt. Puoi annullare in qualsiasi momento.

### Usare il modello nei tuoi programmi

Vuoi solo accendere il modello per una chat, un editor o un assistente, senza test? Premi **Avvia solo il server** accanto ad *Avvia benchmark* (oppure **Avvia server** accanto a un modello in **Modelli → Sul tuo PC**). GPU Bench ti mostra prima cosa farà:

- il **contesto**, cioè quanto testo il modello può leggere in una volta: scelto da GPU Bench perché entri bene nella tua scheda (in modalità esperto puoi deciderlo tu);
- se il modello **entra** nella memoria video, cosa va scaricato prima e il comando esatto.

Quando il server è pronto copi il suo indirizzo (compatibile OpenAI) e lo incolli nell'altro programma. Il server resta acceso finché non premi **Ferma** nel riquadro **Server attivi** della pagina Benchmark o chiudi GPU Bench; mentre è acceso non puoi fare benchmark.

Se hai già fatto **Trova le impostazioni migliori** con quel modello su questa scheda, *Avvia solo il server* usa il contesto e le impostazioni consigliate da quel test (te lo dice nella finestra di conferma).

### Trova le impostazioni migliori

Scegli la durata **Trova le impostazioni migliori** (*Veloce* circa 5 minuti, *Accurata* circa 20). GPU Bench avvia il modello più volte e prova da solo:

- la **cache KV** (la memoria che tiene il testo già letto): prima *f16*, poi *q8_0*, poi *q4_0*, che occupa circa un quarto e lascia spazio a molto più contesto. Con le cache ridotte attiva sempre la *flash attention* e usa lo stesso tipo per K e V;
- il **contesto più grande** che entra tutto nella memoria video, per ogni tipo di cache;
- le impostazioni che cambiano la velocità: *flash attention*, *batch* e *ubatch* (quanti token del prompt la scheda legge insieme: più alto legge più in fretta ma usa più memoria) e, se il modello ha già un file "draft" o "MTP" nella libreria, la generazione speculativa.

Poi misura ogni combinazione **riempiendo il contesto un po' alla volta** (1K, 4K, 8K, 16K… token) e ti mostra i numeri fianco a fianco: la più veloce a ogni lunghezza e quella consigliata, cioè la più veloce tra quelle che arrivano al contesto più grande. Ogni prova ha il suo comando esatto.

Su Windows, quando un modello non entra nella memoria video, il driver non dà errore: sposta una parte nella RAM del PC e tutto diventa circa 10 volte più lento. GPU Bench se ne accorge (memoria condivisa usata dal motore, oppure velocità crollata rispetto alla prima prova) e conta quella configurazione come "non entra".

Solo se il modello non entra nemmeno con 4K di contesto e cache *q4_0*, GPU Bench prova a tenere una parte del modello sulla CPU (*--n-cpu-moe* per i modelli MoE, meno *-ngl* per gli altri): funziona, ma è più lento, e lo trovi segnato così.

In modalità esperto puoi aggiungere il controllo di **fedeltà**: lo stesso testo generato con la cache più precisa e con quella consigliata, per vedere quanti token restano uguali. È un'indicazione, non un test di qualità.

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

Nella scheda **Come è stato avviato** trovi il comando esatto usato (PowerShell o bash) da copiare, e i pulsanti per **rifare lo stesso test**, **usare le stesse impostazioni** o **avviare solo il server** con quella configurazione.

Puoi **confrontare** due risultati ed **esportarli** in CSV (anche nel formato per Excel italiano), JSON, Markdown o HTML.

## 5. Modelli

Nella pagina **Modelli**:

- **Sul tuo PC**: i modelli che hai, con quanto spazio occupano e come sono andati.
- **Scarica**: i consigliati per la tua scheda e la ricerca su Hugging Face, con filtri per formato, dimensione e "solo quelli che entrano".

GPU Bench sceglie da solo la versione (quantizzazione) migliore che entra nella tua scheda; se sei esperto puoi sceglierne un'altra. I download si possono mettere in pausa e riprendono da soli se la connessione cade.

Per i modelli che richiedono di accettare una licenza (per esempio Llama o Gemma) GPU Bench apre la pagina giusta e ti chiede il token di Hugging Face una sola volta: viene salvato cifrato.

## 6. Docker e vLLM (facoltativo)

vLLM è un motore pensato per servire molti utenti insieme. Su Windows funziona tramite Docker Desktop.

- Se Docker manca, la pagina **Motori** ha un pulsante che lo installa (vedrai la licenza di Docker e la richiesta di permessi di Windows).
- Se Docker è spento, il pulsante **Avvia Docker** lo accende.
- Su Linux GPU Bench ti mostra prima i comandi esatti che eseguirà per installare Docker e il supporto NVIDIA, poi ti chiede la password.

**Su Windows**: i modelli letti da Docker passano per una condivisione lenta. Il pulsante **Copia nello spazio Docker** li copia una volta nello spazio di Docker: i caricamenti diventano molto più veloci.

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
| "Docker non è avviato" | Premi **Avvia Docker** |
| "Serve accettare la licenza" | Apri la pagina del modello su Hugging Face, accetta e salva il tuo token in Impostazioni |

## 10. Modalità esperto

Attiva **Modalità esperto** nella pagina Benchmark per impostare a mano contesto, strati sulla GPU, flash attention, tipo di cache, batch, thread, richieste parallele, argomenti extra, variabili d'ambiente, eseguibile llama-server personalizzato, immagine Docker, lunghezze dei prompt, ripetizioni e livelli di concorrenza. L'**Anteprima comando** mostra sempre la riga esatta che verrà eseguita.

---

Le idee per la stima della memoria video vengono in parte da [llmfit](https://github.com/AlexsJones/llmfit) (licenza MIT).
