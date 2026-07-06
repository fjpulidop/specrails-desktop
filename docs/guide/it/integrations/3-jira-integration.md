# Integrazione Jira

Vuoi che le tue spec vivano su una vera **board Jira** invece che dentro Specrails? L'integrazione Jira appoggia le spec di un progetto ai ticket Jira, mantiene gli stati sincronizzati man mano che i rail vengono eseguiti e per il resto resta fuori dai piedi. Ogni progetto si sincronizza con la **propria** board Jira.

## Come funziona (in breve)

Specrails funge da **livello di sincronizzazione** tra Jira e il tuo progetto. L'idea di fondo: il tuo archivio locale delle spec resta l'elemento canonico che la pipeline legge, e Specrails è responsabile di mantenerlo allineato con Jira.

- Quando avvii un rail, Specrails sposta il ticket Jira collegato su **In corso**.
- Quando un job termina, Specrails fa transitare il ticket: in caso di successo passa al tuo stato di **revisione** mappato e arriva su **Fatto** solo quando la PR di consegna viene fusa o accetti il risultato locale; in caso di fallimento torna su **Da fare** con un commento di completamento che include risultato, id dell'esecuzione, costo, durata e cambio di stato Jira.
- Se chiedi modifiche di follow-up mentre il ticket Jira è già in revisione, Specrails prova a continuare il branch della PR aperta esistente per quel ticket invece di creare un branch nuovo. Se il tuo stato di revisione Jira non è mappato esplicitamente e localmente appare ancora come **In corso**, Specrails può comunque continuare la PR quando la chiave Jira corrisponde alla pull request aperta.
- Periodicamente Specrails interroga (**polling**) Jira per le modifiche apportate da chiunque sulla board e le riporta nelle tue spec.

Tutti i riscritti verso Jira passano attraverso un outbox durevole e resistente ai crash, così un'interruzione momentanea di Jira non blocca mai un job — l'aggiornamento viene semplicemente ritentato.

## Connettere una board

Ti connetti dalla pagina **Impostazioni** di un progetto (c'è anche un passo facoltativo "Configura Jira" alla fine della procedura guidata di Add Project). La procedura guidata di connessione ti accompagna passo dopo passo:

1. **Prova** — inserisci l'URL e le credenziali di Jira, e Specrails verifica la connessione.
2. **Scegli un progetto** — scegli con quale progetto Jira sincronizzarti.
3. **Mappa degli stati (facoltativo)** — associa gli stati del tuo workflow Jira agli stati di Specrails se il rilevamento automatico ha bisogno di un aiuto (più sotto).
4. **Connetti** — fatto. Le tue spec ora rispecchiano quella board.

### Autenticazione

Questa versione usa l'autenticazione con **incollatura del token** — veloce, sul dispositivo e senza alcun backend coinvolto:

- **Jira Cloud:** l'email del tuo account più un token API.
- **Jira Data Center / Server:** un Personal Access Token (PAT).

Il tuo token viene memorizzato **cifrato sulla tua macchina** e non la lascia mai. L'app mostra soltanto se un token è presente, mai il token stesso.

## Mappatura degli stati

La parte più delicata di qualsiasi sincronizzazione con Jira è far corrispondere il *tuo* workflow agli stati semplici di Specrails (Da fare / In corso / In revisione / Fatto, più le varianti di annullamento). Specrails risolve la cosa su due livelli:

1. **La tua mappa degli stati esplicita**, se ne hai impostata una nella procedura guidata — vince sempre.
2. **Il rilevamento automatico** dalla categoria di ciascuno stato (nuovo / in corso / fatto) più un'associazione intelligente per gli stati di tipo annullamento e rilascio.

Quando deve spostare un ticket attraverso un workflow con transizioni vincolate, trova un percorso valido passo dopo passo e compila lungo il tragitto eventuali campi obbligatori (come una risoluzione). Se uno stato è davvero irraggiungibile, l'operazione viene parcheggiata come dead-letter e ti viene segnalata invece di fallire silenziosamente — vedrai un indicatore **degradato** e potrai riprovare.

## Hot-swap: attivala e disattivala in tutta sicurezza

Il collegamento Jira è **per spec**, catturato nel momento in cui avvii un rail — non un interruttore globale, tutto-o-niente, sulla board. Questo lo rende sicuro da attivare e disattivare:

- **Abilitare o disabilitare** l'integrazione non riassegna mai le tue spec esistenti.
- **Disconnettere** riporta il tuo progetto al normale comportamento con spec locali.
- Le spec che hanno già un collegamento Jira mantengono il loro riscritto; quelle che non lo hanno restano intatte.

Così puoi sperimentare liberamente — attivala, esegui qualche rail, disattivala — senza scombussolare la tua board o le tue spec locali.

## Il giorno per giorno

Una volta connesso, la pagina Impostazioni del progetto mostra una **scheda di connessione** dove puoi:

- **Sincronizza ora** — forza un polling immediato invece di aspettare il timer.
- **Riprova i dead-letter** — riesegui qualsiasi riscritto rimasto bloccato.
- **Interruttore hot-swap** — metti temporaneamente in pausa/riprendi l'integrazione.
- **Disconnetti** — stacca la board in modo pulito.

Le spec appoggiate a Jira mostrano un **badge con la chiave Jira** (come `PROJ-123`) sulla loro scheda, e cliccandolo si torna al ticket. Riceverai anche piccole notifiche quando una sincronizzazione si completa, quando un token di autenticazione scade (così puoi rinnovarlo) o quando l'integrazione entra in stato degradato.

## Cose da tenere a mente

- **Polling, non webhook.** Poiché Specrails gira in locale, interroga Jira per le modifiche in arrivo invece di ricevere notifiche push. Le modifiche compaiono entro l'intervallo di polling, non istantaneamente.
- **Una board per progetto.** Progetti diversi possono sincronizzarsi con board diverse; un singolo progetto si sincronizza con esattamente una board.
- **L'ultima scrittura vince in caso di conflitti** per il caso raro in cui due schede modificano contemporaneamente la stessa bozza.

## Disattivarla

Se in qualsiasi momento vuoi tornare completamente indietro, basta **Disconnettere** dalle Impostazioni. Le tue spec tornano al comportamento solo-locale e i metadati Jira semplicemente restano inutilizzati — niente viene distrutto.
