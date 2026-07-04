# Gestisci Specrails conversando (Agent Chat)

L'**Agent Chat** è un copilota che vive *dentro* Specrails e può pilotare l'intera app al posto tuo. Invece di navigare a clic tra progetti, spec, binari e analisi, basta che chiedi: *«quanti job sono andati a buon fine questa settimana?»*, *«crea una spec per il login social nel progetto API»*, *«lancia i tre ticket a priorità più alta e avvisami quando finiscono»*. Porta a termine il lavoro chiamando gli strumenti stessi di Specrails — gli stessi che espone il [server MCP](./5-mcp-server.md) — mentre vedi la dashboard aggiornarsi dal vivo dietro di lui.

> **Da non confondere con gli agenti della pipeline.** La sezione *Agenti* (Architect → Developer → Reviewer) riguarda *come un binario implementa una spec*. L'**Agent Chat** è un unico assistente che *gestisce l'app stessa*. Cose diverse, stessa parola.

## Come aprirlo

C'è una **bolla** fluttuante in fondo alla finestra: cliccala per aprire il pannello, oppure premi **⌘⇧A** (**Ctrl+Shift+A** su Windows/Linux) da qualsiasi punto. Il pannello è una finestra vera che puoi spostare, ridimensionare, massimizzare e rimettere nella bolla; ricorda dove l'hai lasciato.

È **non modale di proposito**: la dashboard dietro resta viva, così quando l'agente lancia un binario o crea una spec la vedi comparire in tempo reale — non stai guardando uno schermo congelato.

## Prerequisito: il server MCP

L'Agent Chat gestisce l'app tramite il **server MCP di Specrails** integrato, quindi deve essere attivo. Se non lo è, il pannello si apre con un banner **Attiva Specrails MCP** con un clic: premilo e sei pronto (senza riavvio). Vedi [Controlla Specrails da qualsiasi IA](./5-mcp-server.md) per i dettagli; non viene installato nulla, è tutto locale sulla tua macchina.

## Scegliere su cosa lavora

L'intestazione ha un **selettore di progetto** (come quello di Cursor). Scegli un progetto e tutto ciò che chiedi è circoscritto a esso — *«lancia quelli ad alta priorità»* si risolve su quel progetto. Lascialo su **Home** e l'agente lavora sull'intera configurazione: può elencare o creare progetti e rispondere a domande che abbracciano tutto. Se chiedi qualcosa di specifico di un progetto stando su Home, ti chiederà quale (o si offrirà di crearne uno) invece di indovinare.

Scegliere un progetto qui **non** sposta la tua dashboard: l'obiettivo dell'agente e ciò che stai guardando sono indipendenti.

## Provider e modello

Proprio sopra la casella del messaggio scegli il **provider** (Claude, Codex o Gemini) e il suo **modello**. Ogni provider ha la propria lista di modelli, e cambiare provider avvia una sessione nuova con il modello predefinito di quel provider — così puoi, ad esempio, pilotare l'app con Claude e passare a Codex per un'altra conversazione senza che nulla si incroci.

## Livelli di permesso — le redini le tieni tu

L'agente può toccare tutta l'app, quindi decidi tu quanta libertà ha tramite un **livello** che cambi dal vivo premendo **Shift+Tab** (lo stesso ciclo usato da Claude Code). Ogni livello include tutto ciò che sta sotto:

| Livello | Cosa può fare |
|---|---|
| 👀 **Osserva** | Sola lettura — elencare e ispezionare progetti, spec, job, analisi. Nulla cambia. |
| ✍️ **Modifica** | Quanto sopra **+** creare e modificare (spec, impostazioni, configurazione dei binari) — modifiche reversibili. |
| ⚡ **Opera** | Quanto sopra **+** avviare lavoro di IA che **costa denaro** (binari, generazione di spec). |
| 🔥 **Autonomo** | Quanto sopra **+** eliminare e fermare cose — azioni irreversibili. |

Inizia da **Osserva** e alza il livello solo quando vuoi che l'agente agisca. Se prova qualcosa oltre il livello attuale, si ferma e ti dice esattamente quale livello attivare — non aggira mai il limite. Questo è distinto dai livelli di Impostazioni ▸ MCP, che regolano gli assistenti *esterni*; il livello qui riguarda solo questo agente interno all'app.

## Alcune cose che puoi chiedere

Una volta su **Opera**, prova:

> *«Elenca ogni spec da fare nel progetto API, poi lancia le tre a priorità più alta su binari separati e tienile d'occhio.»*
>
> *«Quanto ho speso questa settimana, suddiviso per progetto?»*
>
> *«Crea una spec per un interruttore modalità scura nel progetto web, con Contract Layer.»*
>
> *«Qualcosa è fallito nell'ultimo lotto — trova i job falliti e riassumi il perché.»*

Le risposte arrivano fluide e già formattate (titoli, tabelle, elenchi), ciascuna con un piccolo pulsante **copia**. Un'etichetta di stato in basso mostra cosa sta facendo l'agente in questo momento — *Sto pensando…*, *MCP · jobs*, *Terminal* — così conosci sempre il suo stato.

## Dettagli pratici

- **Super spec da una conversazione.** Chiedi all’agente di *dare forma* a una spec insieme a te invece di generarla in un colpo solo: prima legge il codice reale, ti fa qualche domanda e mostra la bozza che evolve come una card dal vivo nella conversazione. Al tuo sì crea la spec e — per impostazione predefinita — la arricchisce in background con un **Contract Layer** (percorsi file esatti, forme dei dati, invarianti) perché gli agenti che implementano non improvvisino. Di’ "senza contract layer" per saltare l’arricchimento.
- **Clicca ciò che menziona.** In una missione fissata a un progetto, i numeri di spec (`#12`) e gli id di job/run nelle risposte dell'agente sono chip cliccabili: una spec apre il modale di dettaglio della board, un id di job apre la vista del job dal vivo. Se il riferimento non esiste più, compare una discreta nota "non trovato".
- **La scheda di implementazione resta in vista.** Quando l'agente implementa delle spec, una scheda dal vivo segue il lavoro — e finché ha bisogno di qualcosa da te (creare la PR, pubblicarla, riprovare, scartare) resta **fissata appena sopra la casella dei messaggi**, per quanto scorra la conversazione; al suo posto nella cronologia compare un discreto segnaposto «fissata sopra». Più schede attive si impilano come piccoli chip (cliccane uno per portarla in primo piano), e un chevron riduce la scheda a una barra sottile. Una volta pubblicata la PR — o quando il lavoro viene unito o scartato — la scheda torna al suo posto nella cronologia della conversazione.
- **Cronologia dei prompt.** Con la casella vuota, premi **↑**/**↓** per scorrere ciò che hai chiesto prima (mostrato attenuato mentre scorri); inizia a scrivere per modificarlo, oppure premi Invio per inviarlo.
- **Modifica la coda.** Hai inviato altro mentre l'agente era occupato? Finché ci sono messaggi in coda, **↑**/**↓** scorre *quelli*: la casella mostra il selezionato, lo modifichi sul posto e **Invio lo salva di nuovo in coda** (Esc annulla; la tua bozza non inviata torna com'era).
- **Riduci a icona, senza perdere nulla.** Clicca la ✕ per rimettere il pannello nella bolla — la conversazione continua a girare. Riaprilo e atterri sull'ultimo messaggio; nulla viene riscritto.
- **Nuova conversazione.** Il pulsante **+** avvia un thread pulito; la cronologia vive a livello di app, sopra qualunque singolo progetto.
- **Cambia missione.** Il selettore di missioni accanto al selettore di progetto elenca le conversazioni dalla più recente alla più vecchia — un punto pulsante segnala quelle in cui l'agente sta ancora lavorando, e un piccolo badge conta i messaggi in coda. La ricerca compare quando la lista supera le otto voci, e l'icona del cestino su ogni riga elimina una missione dopo una rapida conferma in linea — anche una in corso (prima avvisa, poi ferma l'agente).

## Alcune cose da sapere

- **Opera e Autonomo costano denaro** perché eseguono IA. L'agente mette in evidenza le azioni che generano costi prima di eseguirle; tieni il livello su Osserva o Modifica se vuoi solo guardare e mettere in ordine.
- **L'agente vale per tutta l'app**, non è legato al progetto che hai aperto — ecco perché ha un proprio selettore e la sua cronologia non è per progetto.
- **È capace solo quanto glielo consente l'MCP.** Se un'intera area sembra off-limits, verifica che il server MCP sia attivato.
