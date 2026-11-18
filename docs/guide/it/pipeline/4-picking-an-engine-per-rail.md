<!-- guide-revision: mission-first-v1 -->

# Scegliere un provider e le sue capacità {#provider-capabilities}

Le impostazioni di esecuzione appartengono al provider scelto. Un nome di modello familiare non implica che ogni provider supporti gli stessi controlli di ragionamento, output strutturato o approvazione.

## Verifica prima la disponibilità

Autentica la CLI del provider e conferma il suo stato in Specrails. Scegli tra i modelli e i valori di effort offerti dai controlli di quel provider. Una CLI installata può comunque fallire perché la sua sessione, la sua quota o il suo servizio remoto non sono disponibili.

Claude e Codex hanno adattatori diversi. Le combinazioni non supportate dovrebbero fallire prima che un loop parta; ad esempio, non si può dare per scontato che un passo che richiede una risposta strutturata senza strumenti funzioni con ogni provider.

## Usa il giusto livello di controllo

La scelta di provider e modello di un rail ne controlla l'esecuzione. Il loop Freestyle della galleria gira su ogni provider CLI ed engine locale; solo Claude aggiunge la chat interattiva nel job. I profili di ruolo e il routing per agente dipendono dal provider e dal workflow Core che Desktop ha installato nel progetto; controlla la configurazione effettiva invece di presumere che un profilo cambi ogni chiamata.

Quando confronti delle esecuzioni, mantieni la stessa spec, la stessa revisione del repository e gli stessi criteri di verifica. Tratta separatamente il costo riportato, quello stimato e quello non disponibile. Vedi [profili](../agents/profiles-and-the-balanced-default) e [consumi](../insights/analytics-and-cost-tracking).

Per un avvio da missione, i passi del loop ereditano provider, modello ed effort della missione, a meno che un agente non li sovrascriva esplicitamente nell'editor del loop. Le impostazioni generali gestiscono le connessioni ai provider; il vecchio blocco dei default del provider e il selettore dei Ruoli non sono più offerti.
