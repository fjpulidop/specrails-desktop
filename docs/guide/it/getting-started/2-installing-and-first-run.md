# Installazione e primo avvio

Mettere specrails sulla tua macchina richiede un paio di minuti. Ecco l'intera procedura.

## 1. Scarica e installa

Procurati l'installer per la tua piattaforma:

- **macOS (Apple Silicon)** — un file `.dmg`. Aprilo e trascina **specrails** nella cartella Applicazioni.
- **Windows** — un installer `.exe`. Eseguilo e segui le istruzioni.

> **Attenzione agli avvisi di sicurezza su macOS e Windows**
>
> - Su **Windows**, l'installer non è ancora firmato digitalmente, quindi SmartScreen potrebbe mostrare un avviso. Clicca su **Ulteriori informazioni → Esegui comunque** per continuare.
> - Su **macOS**, l'app è firmata e notarizzata, quindi dovrebbe aprirsi senza intoppi.

## 2. Cosa ti serve (prerequisiti)

Specrails esegue pipeline di sviluppo AI pilotando veri strumenti da riga di comando, quindi servono alcune cose. La buona notizia: l'app desktop **ne include la maggior parte già al suo interno** (Node.js, npm e Git sono integrati nell'app), così su una macchina nuova di solito non c'è nulla da installare.

L'unica cosa che specrails non può includere è la **CLI del provider AI** vera e propria. Te ne servirà almeno una tra:

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**

Installa quella che intendi usare, accedi una volta dal terminale e sei a posto. Specrails rileva automaticamente quali provider sono presenti.

> Se mai vedessi uno strumento segnalato come mancante, l'app mostra un link **Ulteriori informazioni** con comandi di installazione pronti da copiare e incollare, su misura per il tuo sistema operativo (Homebrew su macOS, winget su Windows, apt/dnf su Linux). Puoi ricontrollare in qualsiasi momento senza riavviare.

## 3. Primo avvio — la schermata di benvenuto

La prima volta che apri specrails, ti ritroverai su una **schermata di benvenuto** pulita. Non ci sono ancora progetti, quindi l'app ti invita ad aggiungere il primo.

Vedrai:

- Una breve descrizione di cosa fa specrails.
- Un unico pulsante **Aggiungi il tuo primo progetto**.

Questo è tutto l'onboarding — nessun account da creare, nessuna registrazione. Specrails funziona interamente sulla tua macchina.

Clicca su **Aggiungi il tuo primo progetto** e prosegui con [Aggiungere il tuo primo progetto](adding-your-first-project).
