# Se il server locale si arresta {#server-recovery}

Specrails esegue sul tuo computer un piccolo server che fa funzionare progetti, rail, missioni e terminali. L’app desktop lo sorveglia e lo riavvia se si arresta.

## Cosa succede quando il server si arresta

- **Specrails lo riavvia per te.** Il server torna allo stesso indirizzo e le finestre aperte si ricollegano da sole; la barra di stato mostra **Riconnessione…** per qualche secondo.
- **Un banner spiega cosa è successo**: quando il server si è arrestato e perché (un codice di uscita o un segnale). Il lavoro in corso in quel momento potrebbe essere stato interrotto: controlla il suo stato e rilancialo se serve.
- **Al massimo tre riavvii al minuto.** Se il server continua ad arrestarsi, Specrails smette di riavviarlo per non nascondere un problema e mostra una finestra di dialogo. Scegli **Try again** per avviarlo ora, oppure chiudi e riapri Specrails. I progetti salvati restano sul disco.
- **Anche l’avvio successivo lo spiega.** Se Specrails è stato chiuso mentre il server era fermo, il banner compare alla prossima apertura.

Scegli **Ignora** nel banner dopo averlo letto; non ricomparirà per quegli arresti.

## Segnala un problema {#report-a-problem}

**Segnala un problema** salva sul tuo computer uno ZIP che aiuta a capire cosa è andato storto. Non viene caricato nulla: decidi tu se condividerlo e con chi.

Aprilo da:

- **Segnala un problema** nel banner,
- **Impostazioni ▸ Informazioni ▸ Segnala un problema**,
- la palette dei comandi (**⌘K**), digitando *segnala un problema*.

Prima del salvataggio la finestra elenca ogni file del rapporto e ne mostra il contenuto. Lo ZIP contiene esattamente ciò che vedi:

| File | Contenuto |
| --- | --- |
| `README.txt` | Cos’è il rapporto e cosa contiene ogni file |
| `system.json` | Versioni dell’app e di Core, sistema operativo, memoria |
| `settings.json` | Impostazioni dell’app, senza token, chiavi, password, valori di ambiente né intestazioni |
| `server.log` | Output del server in esecuzione dal suo avvio |
| `sidecar-stderr.log` | Output di errore recente del server, comprese le esecuzioni precedenti che si sono arrestate (app desktop) |
| `desktop.log` | Quando il server è stato avviato, si è arrestato ed è stato riavviato (app desktop) |
| `crashes.json` | Ogni arresto imprevisto, con le ultime righe di errore |
| `stalls.json` | Momenti in cui il server non rispondeva |

Token, chiavi API, password, chiavi private e credenziali negli URL sono sostituiti da `***` o `[REDACTED]` e la tua cartella personale appare come `~`. Leggi comunque i file prima di condividerli: può comparire il nome di un progetto o di un file che consideri privato.

## Reattività {#responsiveness}

Il popover **Risorse dell'app** nella barra di stato mostra anche la **Reattività**: quanti rallentamenti ci sono stati (momenti di 200 ms o più in cui l'app non riusciva a rispondere), il più lungo e quando si è verificato l'ultimo. Rallentamenti lunghi e frequenti meritano un rapporto, che include il dettaglio tecnico.
