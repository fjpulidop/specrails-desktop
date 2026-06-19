# Il terminale integrato

Specrails ha un vero terminale incorporato — il pannello che scorre verso l'alto dal fondo della finestra, proprio come quello di VS Code o Cursor. Esegue la tua shell reale, nella directory reale del tuo progetto, così puoi lanciare `git`, `npm`, i test o qualunque altra cosa senza uscire dall'app.

## Aprirlo e chiuderlo

Il modo più rapido è la tastiera: **Cmd+J** (macOS) o **Ctrl+J** (Windows/Linux) apre e chiude il pannello, e mette a fuoco il terminale nel momento in cui compare, così puoi iniziare a digitare subito. Puoi anche usare il chevron nella barra di stato.

Il pannello ha tre stati:

- **Nascosto** — riposto via.
- **Ripristinato** — il normale pannello ad altezza dimezzata.
- **Massimizzato** — occupa l'area di lavoro quando ti serve spazio per leggere l'output.

Comprimere il pannello (il chevron) **non** ferma nulla — le tue shell continuano a girare in background. L'unica cosa che termina davvero una sessione è chiuderla (l'icona del cestino, o la ✕ del singolo tab).

## Più sessioni

Puoi eseguire diversi terminali contemporaneamente nello stesso progetto — fino a dieci. Ciascuno ottiene il proprio tab; puoi rinominarli così "dev server" e "test" non si confondono. Partono tutti nella cartella del tuo progetto e caricano il profilo della tua shell (`.zshrc`, `.bashrc` e così via), quindi i tuoi alias e il PATH sono esattamente quelli che ti aspetti.

Ecco la parte importante: i tuoi terminali **sopravvivono ai cambi di progetto e di tab**. Specrails tiene viva e intatta ogni sessione dietro le quinte — scrollback, processi in esecuzione, tutto — così passare a Analytics e tornare indietro non resetta la tua shell né interrompe un comando di lunga durata. Le sessioni terminano solo quando le chiudi esplicitamente (o quando rimuovi l'intero progetto).

## Per progetto, ricordato

Se il pannello è aperto, quanto in alto lo hai trascinato, quali tab esistono — tutto questo viene ricordato **per progetto**. Torna a un progetto ed è configurato come lo avevi lasciato.

## Le funzionalità premium

Questa non è una console essenziale. Il terminale arriva con le comodità che ti aspetteresti da uno di prima categoria:

- **Rendering veloce e nitido** tramite WebGL (con un fallback automatico così non si rompe mai), gestione completa della larghezza Unicode e legature dei font.
- **Cerca nello scrollback** con **Cmd+F** — ottimo per trovare quell'errore sepolto 500 righe più su.
- **Zoom del font** con **Cmd+=**, **Cmd+-** e **Cmd+0** per ripristinare.
- **Scorciatoie per gli appunti** — Cmd+C / Cmd+V per copiare e incollare, Cmd+K per pulire — più un menu contestuale con il tasto destro.
- **Trascina e rilascia i percorsi dei file** (nell'app desktop): rilascia un file sul terminale e il suo percorso viene inserito, opportunamente quotato per la tua shell.
- **Ridimensionamento fluido** — trascinare l'altezza del pannello o comprimere la barra laterale non fa tremolare l'output.
- **Immagini in linea** — i terminali che emettono immagini in stile Sixel o iTerm2 le mostrano direttamente sul posto.
- **Integrazione con la shell** — Specrails sa dove inizia e finisce ogni comando, così può tenere traccia della cronologia dei comandi e avvisarti quando un comando di lunga durata si completa (una notifica desktop, con un fallback nel browser). Se per qualche motivo la tua shell non può essere strumentata, degrada in silenzio e te lo dice una volta.

## Impostazioni

Le preferenze del terminale vivono su due livelli: un'impostazione predefinita a livello di app e un'override opzionale per progetto. L'impostazione per progetto ha la precedenza quando è presente, così puoi mantenere un aspetto coerente globale ritoccando il singolo progetto che ha bisogno di qualcosa di diverso.

## Disattivarlo

Il terminale è attivo per impostazione predefinita. Se preferisci non averlo, può essere disabilitato tramite i flag `VITE_FEATURE_TERMINAL_PANEL` (client) o `SPECRAILS_TERMINAL_PANEL` (server) — imposta uno dei due su `false`. La maggior parte delle persone lo lascerà semplicemente attivo.
