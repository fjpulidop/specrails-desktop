<!-- guide-revision: mission-first-v1 -->

# Connettere un provider AI {#ai-providers}

Specrails coordina la tua CLI Claude o Codex autenticata. L'installazione del provider, l'accesso all'account e la fatturazione dei modelli restano separati dall'applicazione.

## Connettere e verificare

Installa la CLI che vuoi seguendo le sue istruzioni ufficiali e accedi con l'account che intendi usare. Controlla la disponibilità in Specrails, poi seleziona un modello supportato e le impostazioni per la missione o il rail.

Un controllo di rilevamento riuscito non garantisce la disponibilità di quota o di rete per la chiamata successiva. Risolvi gli errori di autenticazione e di compatibilità prima di riprovare un'implementazione.

## Capire il confine

L'app conserva i dati del progetto in locale, mentre le richieste ai modelli e le integrazioni configurate possono inviare contesto fuori dalla tua macchina. Scegli quali riferimenti e allegati fornire tenendone conto.

Le capacità variano: i controlli di ragionamento, le risposte strutturate, i subagenti e la guida durante il turno attivo non sono intercambiabili tra provider. Vedi [impostazioni di esecuzione del provider](../pipeline/picking-an-engine-per-rail) e [guida in corsa](../pipeline/the-job-detail-view).

La selezione Sonnet esegue Claude Sonnet 5.5 (`claude-sonnet-5-5`). [Anthropic](https://platform.claude.com/docs/en/models/sonnet-5-5/overview).
