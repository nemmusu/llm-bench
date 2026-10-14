# LLM Bench: guida rapida

LLM Bench misura quanto è veloce la tua scheda video NVIDIA con l'intelligenza artificiale: scarica e avvia i modelli, li fa lavorare con testi di prova e ti dice, in parole semplici, quanto sono veloci.

Non serve sapere nulla di tecnico: il programma installa da solo quello che manca e ti chiede conferma prima di scaricare qualunque cosa.

## 1. Installazione

**Windows**: apri `LLM-Bench-Setup-x.y.z.exe` e segui la procedura. Windows chiede una volta il permesso di amministratore: LLM Bench si installa in *Programmi*, per tutti gli utenti del PC, e si disinstalla come ogni programma da **Impostazioni → App → App installate** (i tuoi risultati restano in `%APPDATA%\LLM Bench`). Se preferisci non installare nulla, usa la versione *portable* (`LLM-Bench-x.y.z-portable.exe`).

> Al primo avvio Windows potrebbe mostrare "Windows ha protetto il PC": clicca **Ulteriori informazioni** → **Esegui comunque**. Succede con i programmi nuovi non ancora diffusi.

**Linux** (Ubuntu, Debian e derivate): apri il file `llm-bench-x.y.z-amd64.deb` con il gestore dei pacchetti, oppure da terminale `sudo apt install ./llm-bench-x.y.z-amd64.deb`. In alternativa c'è l'AppImage.

L'unica cosa che deve già esserci è il **driver NVIDIA**. Se manca o è troppo vecchio, LLM Bench te lo dice e ti porta alla pagina giusta per scaricarlo.

### Da GPU Bench a LLM Bench

Fino alla versione 0.3 il programma si chiamava **GPU Bench**. Al primo avvio LLM Bench prende i tuoi dati e te lo dice una volta ("I tuoi dati di GPU Bench sono stati spostati in LLM Bench"):

- risultati, impostazioni, preset, motori installati e token di Hugging Face passano nella cartella di LLM Bench (su Windows `%APPDATA%\LLM Bench`, su Linux `~/.config/LLM Bench`). Se GPU Bench è ancora aperto la sua cartella non si può spostare: LLM Bench ne copia i dati e la lascia com'era;
- i **modelli restano dove sono**: se usavi la cartella predefinita (`GPU Bench\models` nella tua cartella utente), LLM Bench continua a usare quella;
- se GPU Bench partiva all'accesso, ora parte LLM Bench al suo posto;
- su Linux, se il token di Hugging Face non si può più leggere (il portachiavi del sistema lo lega al nome del programma), LLM Bench lo toglie e ti chiede di reinserirlo.

I test fatti prima dicono ancora "GPU Bench 0.3": è la loro storia. GPU Bench, se è ancora installato, puoi disinstallarlo quando vuoi: i tuoi dati non sono più nella sua cartella.

## 2. Primo avvio: il controllo del sistema

La prima schermata, **Benvenuto**, controlla il PC e mostra una lista a semafori:

| Voce | Cosa significa |
|---|---|
| Driver NVIDIA | La versione del driver e la versione CUDA che supporta |
| Scheda video | Il modello della scheda e quanta memoria video (VRAM) ha |
| Motore llama.cpp | Il programma che fa girare i modelli. Se manca, un pulsante lo installa (circa 500 MB) |
| Modelli | I modelli già presenti sul PC (anche quelli di LM Studio, Ollama e Hugging Face) |
| Spazio su disco | Lo spazio libero nella cartella dei modelli |
| Docker | Facoltativo: serve solo per vLLM e SGLang (e per llama.cpp in un contenitore) |

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

   Il giudizio guarda la **memoria totale della scheda**, meno 1 GB che tengono sempre il driver e lo schermo: non cambia se hai altri programmi aperti. Se in quel momento altri programmi (una macchina virtuale, un gioco, un altro modello) occupano una parte importante della scheda, l'anteprima e la conferma del server lo dicono con calma ("Ora altri programmi usano 6,2 GB della scheda: per provarlo così com'è chiudili, oppure il test partirà con meno memoria"); se per questo il modello non ci sta, l'avviso dice quanto serve e quanto è libero adesso.
3. **Durata**: *Rapido* (circa 2 minuti), *Standard* (circa 6 minuti: sul modello di riferimento dà il Punteggio LLM Bench), *Completo* (15–30 minuti) o *Trova le impostazioni migliori* (dipende dal modello: LLM Bench ti dice quanto prima di iniziare, vedi sotto).

Premi **Avvia benchmark**. Se serve scaricare qualcosa, LLM Bench ti mostra cosa e quanto pesa e aspetta la tua conferma.

Durante il test vedi in tempo reale le fasi, la velocità, la memoria video, la temperatura e i watt. Puoi annullare in qualsiasi momento.

Se il motore smette di rispondere (nessuna parola per un minuto; prima della prima parola, il tempo che servirebbe per leggere il prompt anche molto lentamente) LLM Bench ferma il test con **Il motore non ha risposto in tempo** invece di aspettare per sempre.

### Quando il modello non entra nella scheda (RAM condivisa)

Su Windows, se il modello con il contesto scelto non entra tutto nella memoria video, il driver non dà errore: mette il resto nella **RAM condivisa** del PC e tutto diventa circa 10–15 volte più lento. I numeri di un test così non sono quelli veri della scheda.

- **Prima di iniziare**, l'anteprima te lo dice ("Il modello non entra tutto nella scheda video") con quanto serve e quanto hai libero, e ti offre due correzioni con un clic: **Usa cache q4_0** (la memoria del testo occupa circa un quarto) e **Contesto massimo che entra**. Su Linux, invece, il motore si fermerebbe per memoria esaurita, e l'avviso lo dice.
- **Durante il test**, appena LLM Bench se ne accorge (la RAM condivisa usata dal motore, oppure una generazione molto più lenta dei tuoi test precedenti con lo stesso modello) compare un avviso con **Annulla test**.
- **Nel risultato**, l'avviso è in cima, con quanta RAM condivisa è stata usata e quanto era più lento del normale, e tre pulsanti: **Trova le impostazioni migliori**, **Riprova con cache q4_0** e **Riprova con meno contesto**. La memoria video mostra anche "+ … nella RAM condivisa" e la stabilità dice "Falsata dalla RAM condivisa".

- **Test fatti con versioni precedenti**, che non misuravano la RAM condivisa: LLM Bench li controlla quando li legge. Se uno è stato molto più lento (meno di 0,4 volte) degli altri dello stesso modello su questa scheda, con ogni probabilità il modello era finito nella RAM condivisa: il risultato lo dice in cima ("Probabilmente il modello non è entrato tutto…", con quante volte era più lento) con gli stessi pulsanti, e il test è segnato come gli altri. Il file del test non viene modificato.

Questi test sono segnati **RAM condivisa** in Risultati, in Configurazioni e negli Ultimi risultati, e non contano per le stime: durata prevista, memoria, "Provato su questa GPU" e il server consigliato usano solo i test che entravano nella scheda. La stima della memoria ignora anche le misure arrivate al limite della scheda (a meno di 1 GB, o del 3 % sulle schede più grandi, dalla sua memoria totale): lì è la scheda stessa a tagliare il numero, che non dice quanto serviva davvero.

### Usare il modello nei tuoi programmi: la pagina Server

Vuoi solo accendere il modello per una chat, un editor o un assistente, senza test? Apri **Server** nella barra laterale e premi **Avvia un server**. Ci arrivi anche da **Avvia solo il server** (pagina Benchmark), da **Avvia il server così** (un risultato o una configurazione) e da **Avvia server** (Modelli → Sul tuo PC): la pagina si apre con quelle scelte già fatte. In quattro passi:

1. **Modello**: quelli sul tuo PC partono subito, i consigliati vengono scaricati prima.
2. **Motore**: llama.cpp, vLLM, SGLang, NInfer o un tuo motore personalizzato (i fork stanno sotto il motore da cui derivano). Se il modello ha dei **comandi suoi** (YaRN, MTP, un fork), il suo motore è già scelto e un interruttore ti lascia avviarlo senza.
3. **Impostazioni**, da tre fonti:
   - **Le migliori dai tuoi test**: la scelta di LLM Bench (l'ultimo *Trova le impostazioni migliori*, altrimenti il contesto più grande che entra bene nella scheda) e le configurazioni già provate di questo modello, con i loro numeri (per esempio "54,6 tok/s a 32K");
   - **I tuoi preset**: quelli salvati per questo modello (con un modello .ninfer anche le impostazioni pronte di NInfer);
   - **Comandi personalizzati**: contesto, cache e gli altri parametri, più argomenti extra e variabili d'ambiente.
4. **Porta e rete**: sempre la stessa (vuota = la prima libera da 8080), così gli altri programmi la ritrovano.

A destra vedi sempre cosa verrà avviato: motore, contesto, indirizzo, se entra nella memoria video, cosa va scaricato prima e il **comando esatto**. Poi premi **Avvia** (o **Scarica e avvia**).

Nella pagina Server ogni server acceso ha il suo riquadro: l'**URL base** e il **nome del modello** da copiare, esempi pronti (terminale, Python con la libreria OpenAI, le tre impostazioni da incollare in Open WebUI, Continue o Chatbox), da quanto è acceso, la memoria video, **Ferma**, **Riavvia** e **Log**. Mentre un server è acceso non puoi fare benchmark: LLM Bench ti propone di fermarlo prima.

**Preset.** Con **Salva come preset** ricordi modello, motore, impostazioni, argomenti extra e porta: lo riavvii con un clic dalla pagina Server o dall'area di notifica. Segna **Avvia all'apertura di LLM Bench** per farlo partire da solo ogni volta che apri LLM Bench; se non parte, la pagina Server ti dice perché.

**Rete locale (avanzato).** Di solito il server risponde solo a questo PC (127.0.0.1). Con **Rendi raggiungibile dalla rete locale** ascolta su tutte le schede di rete e risponde solo a chi usa la **chiave API** che LLM Bench genera e ti mostra: incollala nei programmi degli altri dispositivi. La chiave è salvata cifrata come il token di Hugging Face (su Linux senza portachiavi LLM Bench te lo dice) e non compare mai nei log. Attivalo solo su reti di cui ti fidi; Windows potrebbe chiederti di consentire l'accesso.

### L'area di notifica

Chiudendo la finestra mentre un server è acceso, LLM Bench resta nell'area di notifica (vicino all'orologio) e il server continua a funzionare; te lo dice una volta. Dall'icona riapri la finestra, copi l'indirizzo di un server, lo fermi o lo riavvii, avvii un preset, fermi tutti i server o esci. **Esci** chiede conferma se ci sono server accesi e li ferma: LLM Bench chiude solo i programmi che ha avviato lui, mai un tuo llama-server. Su Windows il menu dice anche com'è Docker (acceso, spento, non risponde) e offre **Avvia Docker** o **Riavvia Docker**.

In **Impostazioni → Area di notifica** scegli cosa fa la chiusura della finestra (restare nell'area di notifica solo con un server acceso, sempre, oppure uscire) e attivi **Avvia LLM Bench all'accesso**: parte nell'area di notifica con i preset segnati *Avvia all'apertura*. Su un desktop Linux senza area di notifica (GNOME senza l'estensione AppIndicator) la finestra si riduce a icona invece di nascondersi.

### Trova le impostazioni migliori

Scegli la durata **Trova le impostazioni migliori** e poi *Veloce* o *Accurata*: accanto a ognuna LLM Bench ti dice quanto ci vorrà **per quel modello su questa scheda** (per esempio "~20 min"). Un modello piccolo richiede pochi minuti; uno grande con un contesto di 256K anche più di mezz'ora, perché leggere prompt così lunghi richiede tempo anche a una scheda veloce. LLM Bench avvia il modello più volte e prova da solo:

- la **cache KV** (la memoria che tiene il testo già letto): prima *f16*, poi *q8_0*, poi *q4_0*, che occupa circa un quarto e lascia spazio a molto più contesto. Con le cache ridotte attiva sempre la *flash attention* e usa lo stesso tipo per K e V;
- il **contesto più grande** che entra tutto nella memoria video, per ogni tipo di cache;
- le impostazioni che cambiano la velocità: *flash attention*, *batch* e *ubatch* (quanti token del prompt la scheda legge insieme: più alto legge più in fretta ma usa più memoria) e, se il modello ha già un file "draft" o "MTP" nella libreria, la generazione speculativa.

Poi misura ogni combinazione **riempiendo il contesto un po' alla volta** (1K, 4K, 8K, 16K… token) e ti mostra i numeri fianco a fianco: la più veloce a ogni lunghezza e quella consigliata, cioè la più veloce tra quelle che arrivano al contesto più grande. Ogni prova ha il suo comando esatto.

Per il contesto più grande LLM Bench non misura tutto a ogni tentativo: avvia il modello, controlla la RAM condivisa e fa una prova breve (1K) da confrontare con la prima. Tra l'ultimo contesto che entra e il primo che non entra cerca a metà, finché resta poco spazio: nella tabella **Contesto massimo per tipo di cache** "Limite trovato" vuol dire che il contesto subito sopra non entrava, "Almeno …" che più in alto non ha provato (la stima lo escludeva, o il tempo era finito).

Su Windows, quando un modello non entra nella memoria video, il driver non dà errore: sposta una parte nella RAM del PC e tutto diventa circa 10–15 volte più lento. LLM Bench se ne accorge (memoria condivisa usata dal motore, oppure velocità crollata rispetto alla prima prova) e conta quella configurazione come "non entra".

La memoria del motore è controllata **per tutta la prova**, dal caricamento all'ultima misura, non solo all'inizio: certe prove entrano appena caricate e finiscono nella RAM condivisa alla prima richiesta, quando il motore prepara i suoi buffer di calcolo. Appena la RAM condivisa usata dal motore supera di oltre 768 MB quella di una prova che entra (la prima, più circa 1 MB ogni 1K di contesto in più; almeno 1 GB in tutto), oppure di 512 MB quando la memoria video è già piena (a meno di 1 GB, o del 3 %, dal totale), LLM Bench ferma subito quella prova, anche a metà di una richiesta, e la segna **Usa la RAM condivisa (lento)**.

Ogni richiesta della ricerca ha anche un suo **limite di tempo**: 5 volte quanto dovrebbe durare secondo le velocità della prima prova (mai meno di 30 secondi; minuti per i prompt molto lunghi). Se una richiesta lo supera, o il motore non manda nulla per un minuto, la prova è **Troppo lento: probabilmente usa la RAM condivisa**. In entrambi i casi la prova fermata compare subito nell'elenco delle prove, con il motivo, il motore viene spento e la ricerca continua con un contesto più piccolo. Mentre una prova aspetta la sua prima misura, gli indicatori di velocità dicono "in attesa della prima misura" invece di mostrare i numeri della prova precedente.

La ricerca ha un **tempo massimo** (la sua stima, con un po' di margine). Prima di ogni richiesta LLM Bench controlla se finirebbe in tempo: se no, non la inizia (per il tempo massimo della ricerca non interrompe mai una misura a metà: lo fanno solo la RAM condivisa e il limite di tempo di una richiesta, qui sopra) e lo scrive nel risultato. Se il tempo finisce prima di aver misurato tutto, il risultato tiene quello che ha misurato: le combinazioni **Misurata in parte (tempo finito)** sono confrontate con le stesse regole, una è comunque consigliata e **Usa questo preset** usa quella. Le richieste molto lunghe (oltre un minuto) vengono fatte una volta sola invece di ripeterle.

Se **annulli** la ricerca (o si ferma per un errore), il risultato tiene quello che aveva misurato fino a quel momento, con le stesse regole del tempo finito (**Misurata in parte (test annullato)**). Nella tabella **Contesto massimo per tipo di cache** le cache non ancora provate dicono **Non provato (test annullato)**, quella che stava cercando "Almeno …" con il contesto più grande che era entrato; "Nessun contesto è entrato tutto nella memoria video" compare solo quando ogni contesto provato con quella cache non entrava e la ricerca era finita. Allo stesso modo **Non provato (tempo finito)** e **Non provato (non serviva)** dicono perché una cache non è stata provata.

Alcuni errori si ripeterebbero uguali a ogni avvio, qualunque impostazione si provi: la ricerca si ferma **al primo** e il risultato dice perché. Succede quando il motore non sa leggere il modello (un formato dei pesi o un'architettura che questa versione del motore non conosce, un file .ninfer in un formato vecchio), quando manca un programma o un argomento, quando la scheda non è quella giusta. Una ricerca in cui nessun avvio è riuscito (né caricato, né esaurito la memoria) non finisce mai come "Completato": è **Non riuscito**, con l'errore dell'ultimo avvio.

Solo se il modello non entra nemmeno con 4K di contesto e cache *q4_0*, LLM Bench prova a tenere una parte del modello sulla CPU (*--n-cpu-moe* per i modelli MoE, meno *-ngl* per gli altri): funziona, ma è più lento, e lo trovi segnato così.

In modalità esperto puoi aggiungere il controllo di **fedeltà**: lo stesso testo generato con la cache più precisa e con quella consigliata, per vedere quanti token restano uguali. È un'indicazione, non un test di qualità.

Il **contesto per gradi** misura 1K, 4K, 8K, 16K… e anche **200K** quando il contesto ci arriva, così i test di modelli e schede diverse si confrontano allo stesso punto. Con *Veloce*, sui contesti lunghi, misura meno punti (1K, 4K, 16K, 64K… e il contesto massimo) e salta il 200K: una prova da 200K token dura minuti, e la ricerca diventerebbe molto più lunga. Il 200K lo misurano *Accurata* e il profilo **Completo**.

In modalità esperto, **Cerca anche oltre il limite del modello (YaRN)** lascia che la ricerca vada oltre il contesto su cui il modello è stato addestrato, fino a 300K, 500K o al contesto che scegli: oltre quel limite ogni prova usa YaRN con il fattore giusto (contesto ÷ contesto di addestramento). Ci mette di più, e la qualità lassù non è garantita: LLM Bench misura solo velocità e memoria.

Il profilo **Completo** misura anche il **contesto per gradi** con le impostazioni scelte. Il testo di prova è un romanzo di circa 100.000 token: oltre quella lunghezza LLM Bench lo riusa a pezzi rimescolati, così nessun pezzo lungo si ripete; la velocità non cambia (conta quanti token riempiono il contesto, non cosa dicono).

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
| **Punteggio LLM Bench** | Un numero solo per confrontare le schede: 1.000 è una RTX 5090 con llama.cpp sul modello di riferimento (Qwen3 4B). Si calcola solo con il profilo Standard su quel modello |

Gli avvisi gialli o azzurri ti dicono se un risultato potrebbe essere falsato, per esempio "altri programmi stavano usando la GPU", e cosa fare.

Nella scheda **Come è stato avviato** trovi il comando esatto usato (PowerShell o bash) da copiare, e i pulsanti per **rifare lo stesso test**, **usare le stesse impostazioni** o **avviare solo il server** con quella configurazione. In cima a ogni risultato c'è la configurazione in breve (contesto, cache KV, quello che cambia rispetto alle impostazioni predefinite) con **Usa questo preset** e **Avvia il server così** a portata di clic.

Nella pagina **Risultati**, la vista **Configurazioni** raggruppa i test per modo di avvio (stesso motore, modello, scheda e impostazioni): una riga per configurazione, dalla più veloce, con la mediana dei test che l'hanno misurata. **Confronta a** sceglie la profondità (quanti token di testo ha già davanti il modello) a cui confrontarle: si vedono solo numeri misurati davvero. **Usa questo preset** porta motore, modello e impostazioni nel Benchmark (con un riquadro che dice da quale test vengono); se il modello non è più sul PC viene riscaricato prima.

Ogni velocità dice su cosa è stata misurata: **scrittura** (generazione) o **lettura** (del prompt), e con quanto testo. Per esempio "54,6 tok/s · scrittura con 32.768 token già nel contesto" o "2.244 tok/s · lettura di un prompt da 512 token"; nelle tabelle "Generazione (tok/s) a 32K" o, sotto il numero, "a 32K di contesto". Più il contesto è pieno, più il modello va piano: per questo un numero senza contesto non basta.

### Confronta

Premi **Confronta** accanto a un test (in Risultati), a una configurazione (in Configurazioni), a una combinazione di **Trova le impostazioni migliori** o in cima a un risultato: in fondo alla finestra compare una barra con quello che hai scelto ("3 selezionati · Confronta"), fino a 4, che resta mentre cambi pagina. Con **Confronta modelli** (in Risultati) scegli invece da 2 a 4 modelli: per ognuno LLM Bench prende la configurazione più veloce misurata su questa scheda, e puoi sceglierne un'altra.

Il confronto mette ogni elemento in colonna, con modello, motore, configurazione in parole e data, e per ogni misura evidenzia il numero migliore e dice gli altri in parole ("2,2 volte più lento", "−16%"). Le velocità sono sempre confrontate alla **stessa lunghezza di contesto misurata da tutti**: **Confronta a** offre solo le lunghezze misurate da almeno due, e dove uno non l'ha misurata c'è scritto "non misurato" (mai stime). Ci sono anche i grafici con tutti gli elementi, **Cosa cambia tra loro** con le impostazioni diverse, **Usa questo preset** e **Avvia il server così** per ognuno, e la **Scheda da condividere** su uno di loro con il confronto completo. L'indirizzo della pagina contiene il confronto: puoi riaprirlo o condividerlo così com'è.

Puoi **esportare** i risultati in CSV (anche nel formato per Excel italiano), JSON, Markdown o HTML.

## 5. Modelli

Nella pagina **Modelli**:

- **Sul tuo PC**: i modelli che hai, divisi per formato (per llama.cpp, per vLLM / SGLang, per NInfer), con quanto spazio occupano e come sono andati. Un download fermato a metà compare come **Incompleto · 1 di 4 file**: non si può usare finché non è completo (riprendilo o eliminalo).
- **Scarica**: i consigliati per la tua scheda e la ricerca su Hugging Face, con filtri per motore (llama.cpp, vLLM, SGLang, NInfer), dimensione e "solo quelli che entrano". La ricerca, i filtri e la posizione nella lista restano come li hai lasciati quando apri un modello e torni indietro.

Ogni modello mostra i suoi **formati**, ognuno con il motore che lo usa: **GGUF · llama.cpp**, **Safetensors · vLLM / SGLang** (con la precisione, per esempio FP8 o BF16), **NInfer · solo RTX 5090**. I formati che LLM Bench non usa (MLX, ONNX…) sono indicati come non supportati. Molti repository sono misti: nella pagina del modello ogni formato ha la sua sezione e il suo download, che scarica solo i file di quel formato (mai le descrizioni, le immagini o i video).

LLM Bench sceglie da solo la versione (quantizzazione) migliore che entra nella tua scheda; se sei esperto puoi sceglierne un'altra. I download si possono mettere in pausa e riprendono da soli se la connessione cade.

Quello che hai già non si riscarica mai. Se scegli una versione già sul PC, è segnata **Già scaricato** e il download prende solo le parti che mancano: per esempio, se la prima volta non avevi preso la parte visione, la finestra dice **Il modello è già sul PC: scarico solo la parte visione (mmproj)**. Un file della stessa dimensione ma non ancora verificato viene controllato prima (sha256): si riscarica solo se è diverso. Nell'elenco **Sul tuo PC** e nella pagina del modello trovi anche **Aggiungi la parte visione** e **Aggiungi MTP** quando il repository ha queste parti e tu no: finiscono nella stessa cartella del modello.

**Aggiornamenti.** LLM Bench guarda su Hugging Face se i file che hai scaricato sono cambiati: quando premi **Controlla aggiornamenti** e, da solo, al massimo una volta al giorno (un repository al secondo, mai a raffica). Se un file è cambiato vedi **Aggiornamento disponibile** con cosa è cambiato (per esempio "Il file Q4_K_M è cambiato (17,8 GB → 17,6 GB)") e il pulsante **Aggiorna**, che scarica solo i file cambiati: quello vecchio resta finché il nuovo non è scaricato e verificato. I risultati misurati prima restano com'erano: il badge dice **Provato con la versione precedente**.

Quanto spazio serve nella scheda conta anche quello che carichi insieme al modello: con un modello MTP o bozza (`-md`) o con la parte visione (`--mmproj`) la stima mostra **+ MTP 3,2 GB** e **+ visione 0,9 GB**.

Per i modelli che richiedono di accettare una licenza (per esempio Llama o Gemma) LLM Bench apre la pagina giusta e ti chiede il token di Hugging Face una sola volta: viene salvato cifrato.

### Comandi per questo modello

Alcuni modelli vanno avviati con comandi che si scoprono solo leggendo la loro scheda: un contesto più lungo con YaRN, il file MTP per scrivere più in fretta, un fork del motore. Scrivili una volta, nella sezione **Comandi per questo modello** della pagina del modello o con **Comandi** accanto a un modello di *Sul tuo PC*: Benchmark, *Trova le impostazioni migliori* (come punto di partenza) e *Avvia solo il server* li usano da soli.

- **Scegli da una ricetta pronta**: comandi già scritti, presi dalla documentazione dei motori. *Contesto esteso con YaRN* (300K, 500K: il fattore lo calcola LLM Bench), *Decodifica speculativa con MTP / modello draft* (il file MTP accanto al modello per llama.cpp, il metodo mtp per vLLM, EAGLE per SGLang), *Fork PrismML per modelli Bonsai*, *Modelli con immagini* (il proiettore mmproj), *NInfer per i modelli .ninfer*, *NInfer-all per i modelli GGUF-NInfer*. «Usa» li aggiunge ai comandi del modello: li rivedi prima di salvare.
- **Scrivi i comandi**: per quali modelli (solo questo, o tutti quelli il cui nome contiene una parola e, se vuoi, con una certa quantizzazione), il contesto, il motore, il file MTP, il proiettore immagini, gli argomenti in più per ogni motore, le variabili d'ambiente, una nota e il link alla scheda. Sotto vedi il **comando completo** che ne viene fuori, mentre scrivi.
- Una ricetta che vale solo per questo modello vince su una che vale per tutta la famiglia. Salvarla vuota la rimuove.
- Se la ricetta usa un fork che non hai ancora indicato, **Indica dove si trova il fork** apre la pagina Motori con il fork già scelto per quel modello.

Nella pagina **Benchmark**, quando il modello scelto ha i suoi comandi, compare **Usa i comandi di questo modello** con quello che fanno (per esempio "YaRN 300K · MTP"): con l'interruttore spento il test parte con le impostazioni normali. In modalità esperto i valori della ricetta compaiono nei campi, segnati come tali; quello che scrivi tu li sostituisce, e te lo dice. Nel risultato, *Come è stato avviato* dice quali comandi sono stati usati, insieme al comando esatto.

## 6. Docker e vLLM (facoltativo)

vLLM è un motore pensato per servire molti utenti insieme. Su Windows funziona tramite Docker Desktop.

- Se Docker manca, la pagina **Motori** ha un pulsante che lo installa (vedrai la licenza di Docker e la richiesta di permessi di Windows).
- Se Docker è spento, il pulsante **Avvia Docker** lo accende. Lo trovi ovunque serve: avviando un test o un server con un motore in Docker te lo chiede nella stessa finestra e poi continua da solo; c'è anche nel menu dell'area di notifica.
- Su Linux LLM Bench ti mostra prima i comandi esatti che eseguirà per installare Docker e il supporto NVIDIA, poi ti chiede la password.

### Quando Docker non risponde

A volte Docker Desktop resta aperto ma smette di rispondere: di solito succede quando il suo **Resource Saver** lo spegne dopo qualche minuto senza contenitori accesi e lo spegnimento si blocca a metà. LLM Bench se ne accorge (anche mentre un tuo server gira in Docker) e lo dice in alto in ogni pagina, nell'area di notifica e con una notifica.

- **Riavvia Docker** (dalla finestra o dal menu dell'area di notifica) lo riavvia; se non basta lo chiude e lo riapre. Immagini, modelli e contenitori restano. I server di LLM Bench che erano accesi ripartono da soli, con le stesse impostazioni e la stessa porta.
- Se nemmeno così riparte, LLM Bench ti propone l'ultima prova, spiegata: spegnere e riaccendere solo la macchina WSL di Docker (`docker-desktop`). Le tue altre distribuzioni WSL restano accese.
- **Perché e come evitarlo** legge il registro di Docker Desktop e ti dice cosa è successo. Per evitarlo: in Docker Desktop apri Impostazioni (l'ingranaggio) → Resources → Advanced e disattiva **Resource Saver**. LLM Bench non cambia mai le impostazioni di Docker: il pulsante **Apri Docker Desktop** ti porta lì.
- Se Docker si è fermato da solo e ha spento i tuoi server, LLM Bench ti propone **Riavvia i server che erano attivi** appena Docker è di nuovo acceso.

**Su Windows**: i modelli letti da Docker passano per una condivisione lenta. Il pulsante **Copia nello spazio Docker** li copia una volta nello spazio di Docker: i caricamenti diventano molto più veloci.

### SGLang

SGLang è un altro motore per servire molti utenti insieme e legge i modelli come vLLM: cartelle Hugging Face (safetensors), non file GGUF.

- **Windows**: funziona in Docker Desktop, come vLLM. Nella pagina **Motori** la scheda **SGLang (Docker)** ti fa scegliere la versione (quella consigliata è segnata) e la scarica. Se non l'hai ancora scaricata, il Benchmark te la propone prima di iniziare.
- **Linux**: in Docker oppure installato sul PC, in un suo ambiente Python che LLM Bench prepara per te.

I modelli scaricati per vLLM servono anche a SGLang: non li scarichi due volte.

### Motori personalizzati (fork e programmi tuoi)

Nella pagina **Motori**, sotto **Motori personalizzati**, premi **Aggiungi motore**:

1. **Tipo**: un fork di llama.cpp, di vLLM o di SGLang, una **Variante di NInfer** (vedi sotto), oppure un **Programma con API OpenAI**.
2. **Dove si trova**: il programma sul PC, un'immagine Docker o, per un programma tuo, il comando che lo avvia. **Prova** legge versione e opzioni (`--version`, `--help`) senza caricare nessun modello.
3. **Opzioni**: argomenti in più e variabili d'ambiente da usare a ogni avvio, e i modelli per cui vuoi usarlo (parole nel nome, quantizzazioni).

Un fork funziona come il motore da cui deriva. Se non conosce un'impostazione di LLM Bench (per esempio `-ub`), LLM Bench te lo dice già nella prova: in quel caso userà il suo valore predefinito, e lo trovi scritto anche nell'anteprima e nel risultato. Se gli manca qualcosa di indispensabile (per esempio la porta), LLM Bench non lo avvia. Nei risultati il motore si chiama con il suo nome e la sua versione (per esempio "PrismML b7001"), separato da llama.cpp.

Per un **Programma con API OpenAI** scrivi il comando come in un terminale. LLM Bench sostituisce `{model}`, `{modelDir}`, `{port}`, `{host}`, `{ctx}` e `{alias}`, e `{port}` è obbligatorio. Il comando parte senza shell: niente `|`, `>` o `&&`, e i file `.bat`/`.cmd` vanno avviati con `cmd /c`. LLM Bench lo avvia, lo misura e lo ferma alla fine. Con `{alias}` lo riconosce e lo ferma anche dopo un riavvio improvviso.

Per i modelli Bonsai (quantizzazioni PQ2_0 e PTQ1_0) il Benchmark ti propone il motore pronto **Fork PrismML di llama.cpp**: devi solo dirgli dove si trova il suo llama-server.

### NInfer (solo RTX 5090)

NInfer è un motore fatto apposta per i modelli Qwen 3.6 e 3.8 su una sola RTX 5090. Legge solo i suoi modelli `.ninfer` (per esempio `neroued/Qwen3.8-27B-nvfp4-NInfer`, che trovi in **Modelli**).

La scheda **NInfer** in **Motori** ha due versioni, ognuna con il suo stato (**Pronto**, **Da compilare**, **Da ricompilare**, **Non funziona** e perché, **Non installato**) e un solo pulsante principale:

- **NInfer (ufficiale)**: quella dei suoi autori, nella cartella `~/ninfer`.
- **NInfer-all (serve per i modelli GGUF-NInfer)**: una versione di NInfer che legge anche i modelli convertiti da GGUF ([github.com/iamwavecut/ninfer-all](https://github.com/iamwavecut/ninfer-all), ramo `master`), nella cartella `~/ninfer-all`. Ti serve solo per quei modelli: LLM Bench la usa da sola quando servono.

I pulsanti:

- **Scarica e compila** (quando non c'è): LLM Bench controlla subito cosa serve (git, CMake, Ninja, un compilatore C++20, CUDA, le librerie FFmpeg, libcurl). Se tutto c'è, scarica il codice e lo compila; se manca qualcosa te lo elenca con il comando `sudo apt install …` da copiare (LLM Bench non installa pacchetti di sistema) e **Ricontrolla**. Finita la compilazione la versione è salvata da sola: la scheda dice **Pronto**, senza altri passaggi. Ci vuole tempo: NInfer-all sono circa 800 file da compilare, circa 25 minuti con 20 core; durante la compilazione vedi quanti file mancano e il tempo rimasto, e puoi **Annullare**.
- **Ricompila** (quando il codice c'è ma il programma no, o è più vecchio del codice): compila la copia che c'è, senza riscaricarla. Se una compilazione precedente si era fermata o aveva usato un altro CUDA, cancella solo la cache di CMake (`build/CMakeCache.txt` e `build/CMakeFiles`) e riconfigura.
- **Aggiorna** (quando sul suo ramo ci sono commit nuovi): scarica le modifiche e ricompila in un clic.
- **Cambia cartella** / **Ce l'ho già: indica la cartella**: se l'hai compilata tu altrove, scrivi la sua cartella (per esempio `~/ninfer`) e premi **Controlla e usa**. NInfer-all compilato a mano in `~/ninfer-all` lo trova da sola, senza che tu scriva niente.
- **Avanzate**: un'altra cartella, il repository e i comandi esatti che eseguirà.

**CUDA per NInfer-all**: per la RTX 5090 NInfer-all vuole CUDA 13.1 o più nuovo (con il 13.0 compilerebbe male i suoi kernel, e la sua configurazione si ferma). Se hai il 13.0, la scheda lo dice ("CUDA 13.0 · Serve 13.1 o più recente") e ti dà il comando, per esempio `sudo apt install cuda-toolkit-13-3`: il nuovo CUDA si aggiunge a quello che hai, non lo toglie. Dopo **Ricontrolla**, LLM Bench compila con quel CUDA (`-DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.3/bin/nvcc`). Il NInfer ufficiale non è toccato.

**Se una compilazione si ferma**, la scheda dice perché in parole semplici (CUDA troppo vecchio, manca un componente, niente rete, disco pieno, memoria finita, modifiche fatte a mano nella cartella, che LLM Bench non tocca mai), le ultime righe che ha scritto e **Mostra il log completo**.

- **Linux**: tutto succede su questo PC. **Windows**: NInfer gira dentro WSL 2, nella distribuzione predefinita (per esempio Ubuntu-24.04); i percorsi sono quelli che vede Linux. LLM Bench legge la distribuzione e basta: compila solo nelle cartelle di NInfer, avvia solo il suo ninfer-serve e ferma solo quello.
- **Impostazioni pronte**: nel Benchmark, con un modello `.ninfer`, scegli **Consigliata da NInfer** (contesto 240K, KV fp8, 2 utenti, MTP 3) oppure **Provata su RTX 5090** (64K per richiesta, KV int8 condivisa da 128K, 2 utenti, visione, MTP 3). Valgono anche per **Avvia solo il server**.
- I test leggono ogni prompt per intero e rispondono senza "thinking", come con gli altri motori; un server invece tiene la cache delle conversazioni di NInfer.
- NInfer non dice in quanti token si divide un testo: LLM Bench tara la lunghezza dei prompt sui conteggi che NInfer restituisce, e lo scrive nelle note del risultato.
- **Modelli su Windows**: un modello sul disco di Windows si carica più lentamente da WSL (un modello da 21 GB in circa 2 minuti). Per caricamenti veloci tienilo dentro WSL e aggiungi la sua cartella (`\\wsl.localhost\Ubuntu-24.04\…`) in **Impostazioni → Cartelle dei modelli**.
- **Senza manifest**: un file `.ninfer` senza il suo manifest accanto compare lo stesso nei **Modelli**. LLM Bench legge il manifest che il file ha al suo inizio (nome, parti, formato dei pesi); se non c'è nemmeno quello, il file è segnato **senza manifest** e LLM Bench ne conosce solo il nome e la dimensione.

#### I modelli GGUF-NInfer e NInfer-all

I modelli **GGUF-NInfer** (file `.ninfer` convertiti da GGUF, come quelli di nerkyor) conservano i blocchi di quantizzazione di GGUF (formato `gguf_blocks_v1`): il NInfer ufficiale non li sa leggere, nemmeno aggiornato; **NInfer-all** sì. LLM Bench lo legge nel manifest all'inizio del file, e:

- in **Modelli** il modello dice **Funziona con NInfer-all** (un clic apre la sua versione nella scheda NInfer);
- scegliendo **NInfer** nel Benchmark (o per un server, un preset, *Trova le impostazioni migliori*, **Usa queste impostazioni**) LLM Bench usa da solo NInfer-all e lo dice: **NInfer · versione NInfer-all (serve per questo modello)**. Il risultato salvato dice quale versione e quale commit l'hanno fatto girare;
- se NInfer-all non è ancora compilato, **Avvia benchmark** prima ti chiede di farlo: *Questo modello funziona solo con NInfer-all. Lo scarico (circa 38 MB) e lo compilo io dentro Ubuntu-24.04 (circa 25 min)*, con quello che manca e il comando da copiare; finita la compilazione il test parte da solo;
- se il manifest non si può leggere (un file rinominato), basta il nome "GGUF-NInfer"; altrimenti il primo avvio con il NInfer ufficiale si ferma e dice *Il NInfer ufficiale non sa leggere il formato gguf_blocks_v1 di questo modello, nemmeno aggiornato*, con **Scarica e compila NInfer-all e riprova** (o **Riprova con NInfer-all**, se c'è già). Da lì in poi LLM Bench ricorda che quel modello va su NInfer-all.

Per i modelli GGUF-NInfer c'è l'impostazione **Consigliata dalla scheda del modello**: 100K per richiesta, cache KV `rk8v4` condivisa, 4 utenti, MTP 3 (`--max-context 102400 --kv-capacity auto --kv-dtype rk8v4 --max-concurrency 4 --spec mtp --draft-tokens 3`). La scheda del modello chiede 400K token di cache condivisa, che con i pesi Q6_K non entrano in una RTX 5090 da 32 GB: per questo la cache è grande quanto entra (NInfer la misura all'avvio e lascia 1 GB libero; sono circa 200K token). Con NInfer-all è quella scelta all'inizio; la si vede solo con una versione che ha la cache `rk8v4`.

Altre varianti di NInfer (un tuo fork, per esempio ninfer-fusion-kvmem) si aggiungono da **Motori personalizzati → Aggiungi motore → Variante di NInfer**: scrivi dove si trova e premi **Prova**, oppure l'indirizzo del suo repository e LLM Bench lo scarica e lo compila. Una variante funziona come NInfer: impostazioni pronte, *Trova le impostazioni migliori*, caricamento, server, con i suoi argomenti in più. **Prova** legge dal suo `--help` le cache KV che conosce.

### Aggiornare i motori

Le schede di vLLM, SGLang, NInfer e dei motori personalizzati ti dicono se c'è una versione più nuova, per esempio "Aggiornamento disponibile: v0.5.21 → v0.5.22 · 9,8 GB". Prima di aggiornare LLM Bench ti mostra i comandi esatti che eseguirà, e parte solo quando confermi.

- **vLLM e SGLang in Docker**: scarica la versione nuova dell'immagine e la sceglie per i prossimi test. Quella di prima resta sul PC: puoi tornarci con **Usa** nell'elenco delle versioni.
- **vLLM e SGLang installati sul PC (Linux)**: aggiorna il loro ambiente con uv, alla versione più recente pubblicata.
- **Un motore personalizzato in Docker**: scarica la versione più nuova dell'immagine. Se l'immagine non è su Docker Hub, LLM Bench non può sapere se ce n'è una più nuova, ma può scaricarla di nuovo.
- **Un fork di llama.cpp compilato da te da una cartella git**: **Controlla aggiornamenti** ti dice quanti commit nuovi ci sono. **Aggiorna** esegue `git pull --ff-only` e poi ricompila con `cmake --build`. Se nella cartella ci sono modifiche tue non salvate, LLM Bench non tocca niente e te lo dice.
- **NInfer** (e ogni sua variante, come NInfer-all, nella sua cartella): come un fork in una cartella git, su Windows dentro la sua distribuzione WSL; le sue due versioni hanno ognuna la sua cartella. **Aggiorna** scarica le modifiche e ricompila in un clic, senza altre conferme; se il programma manca, non risponde o è più vecchio del codice (per esempio dopo un aggiornamento fatto a mano), la versione dice **Da ricompilare** e offre **Ricompila**. Prima di ricompilare mette da parte il programma di adesso: se la compilazione non riesce, lo rimette al suo posto e riporta la cartella al commit di prima, così NInfer funziona come prima. Se i tuoi modelli `.ninfer` sono in un formato più vecchio di quello che legge il tuo NInfer, la scheda te li elenca con il comando di NInfer per convertirli.
- **Tutto il resto** (un programma tuo, un fork installato in altro modo): lo aggiorni con i suoi strumenti.

## 7. Misura "a freddo" reale

Per misurare davvero il caricamento dal disco, il modello non deve essere già nella memoria del PC.

- **Linux**: LLM Bench lo fa da solo, senza permessi speciali.
- **Windows**: serve un'attivazione una tantum in **Impostazioni → Misure a freddo reali**. Windows chiede il permesso da amministratore una volta sola; viene creata un'operazione pianificata che, prima di ogni misura a freddo, svuota la cache dei file. Si può disattivare in qualsiasi momento dalle stesse impostazioni.

Senza attivazione i risultati portano l'avviso "misura a freddo non garantita".

## 8. Condividere i risultati tra più PC

In **Impostazioni → Cartella dei risultati** puoi scegliere una cartella condivisa o sincronizzata (OneDrive, Syncthing, una cartella di rete). Ogni PC salva i propri risultati in file separati, quindi non ci sono conflitti: ogni PC vede anche quelli degli altri, separati per scheda video.

## 9. Problemi comuni

| Problema | Cosa fare |
|---|---|
| "Driver NVIDIA non installato" o "Driver NVIDIA troppo vecchio" | Premi il pulsante per aprire la pagina NVIDIA, installa l'ultimo driver e premi **Ricontrolla** |
| "La memoria della scheda video è occupata" | Chiudi gli altri programmi che usano la GPU (giochi, altri modelli, macchine virtuali) oppure premi **Continua comunque** |
| "Memoria della scheda video insufficiente" | Scegli un modello più piccolo o una versione più compressa; in modalità esperto riduci il contesto |
| "Il motore non ha risposto in tempo" | Riprova; se succede ancora, il modello probabilmente non entra nella memoria video: usa la cache q4_0, meno contesto o **Trova le impostazioni migliori** |
| "Questa versione del motore non sa leggere il modello" | Il modello usa un formato o un'architettura che il motore non conosce. Premi **Aggiorna** sulla scheda del motore, oppure usa la variante che il messaggio propone (per i modelli GGUF-NInfer: **Scarica e compila NInfer-all e riprova**) |
| "Docker non è avviato" | Premi **Avvia Docker** |
| "Docker non risponde" | Premi **Riavvia Docker**; per evitarlo disattiva il Resource Saver di Docker Desktop (vedi «Quando Docker non risponde») |
| "Serve accettare la licenza del modello" | Apri la pagina del modello su Hugging Face, accetta e salva il tuo token in Impostazioni |

## 10. Modalità esperto

Attiva **Modalità esperto** nella pagina Benchmark per impostare a mano contesto, strati sulla GPU, flash attention, tipo di cache, batch, thread, richieste parallele, argomenti extra, variabili d'ambiente, eseguibile llama-server personalizzato, immagine Docker, lunghezze dei prompt, ripetizioni e livelli di concorrenza. L'**Anteprima comando** mostra sempre la riga esatta che verrà eseguita.

**Contesto oltre il limite del modello (YaRN)**: 300K, 500K o un altro contesto. LLM Bench imposta il contesto e YaRN con fattore = contesto scelto ÷ contesto di addestramento (llama.cpp *--rope-scaling yarn --rope-scale --yarn-orig-ctx*, vLLM e SGLang con il loro *rope_scaling*), e il contesto per gradi misura fino a lì, anche oltre il tempo che il profilo darebbe (la durata prevista te lo dice). Oltre il contesto di addestramento la qualità delle risposte non è garantita: il test misura solo velocità e memoria.

---

Le idee per la stima della memoria video vengono in parte da [llmfit](https://github.com/AlexsJones/llmfit) (licenza MIT).
