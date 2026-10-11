# Ambiente del progetto

Alcuni progetti hanno bisogno di una credenziale durante l'esecuzione, come `NODE_AUTH_TOKEN` per i pacchetti npm privati. In **Impostazioni del progetto → Ambiente**, aggiungi i **nomi** delle variabili che servono ai tuoi rail e loop. Specrails salva solo i nomi, mai i valori.

## Da dove arrivano i valori

Quando un'esecuzione parte, Specrails legge ogni nome configurato dall'ambiente con cui è stato avviato. Se apri Specrails dal Dock o dal Finder, quell'ambiente non include ciò che esporta il tuo profilo della shell, quindi Specrails legge anche i nomi mancanti dalla tua login shell (per esempio `~/.zprofile` o `~/.zshrc`). Tieni la credenziale reale nel profilo della shell, non nel repository.

Il controllo avviene in background all'apertura del progetto, quando cambi i nomi e poi periodicamente, così un profilo lento non ritarda le esecuzioni. I valori restano in memoria solo per quel progetto.

## Leggere gli indicatori di stato

Ogni nome salvato mostra un indicatore:

| Indicatore | Significato | Cosa fare |
|------------|-------------|-----------|
| **Ereditata** | Specrails è stato avviato con la variabile. | Niente. |
| **Dalla login shell** | Specrails l'ha letta dalla tua login shell. | Niente. |
| **Non definita** | La tua login shell non la esporta. | Aggiungi un `export` nel profilo della shell. |
| **Timeout della shell** | La tua login shell ha impiegato troppo ad avviarsi. | Velocizza il profilo o aumenta `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS` (10 secondi di default). |
| **Lettura della shell non riuscita** | Specrails non è riuscito a leggere la tua login shell. | Correggi il profilo o avvia Specrails da un terminale. |

Passa il mouse su un indicatore per vedere la spiegazione. Dopo aver corretto il profilo, fai clic su **Verifica di nuovo**: non serve riavviare Specrails.

Se un'esecuzione parte con un nome non risolto, il suo log mostra una riga `[environment]` con la variabile e il suo stato. L'esecuzione parte comunque. Il valore non compare mai nell'app, nei log o negli strumenti MCP.

Su Windows, Specrails usa solo l'ambiente con cui è stato avviato.
