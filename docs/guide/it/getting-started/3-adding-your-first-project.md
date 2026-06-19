# Aggiungere il tuo primo progetto

Un progetto è semplicemente una cartella sul tuo computer che contiene un codebase. Colleghiamone uno.

## Apri la finestra Aggiungi progetto

Clicca su **Aggiungi il tuo primo progetto** nella schermata di benvenuto (oppure, più avanti, sul pulsante **Aggiungi progetto** nella barra laterale sinistra). Compare una piccola finestra di dialogo.

## Inserisci i dettagli

**Cartella del progetto** *(obbligatoria)*

Indica a specrails la cartella che contiene il tuo codice. Nell'app desktop puoi cliccare sull'icona della cartella per sfogliare e sceglierla visivamente, oppure incollare il percorso completo. Dovrebbe essere la radice del tuo repository — la cartella che contiene il codice e (di solito) una directory `.git`.

**Nome del progetto** *(facoltativo)*

Un'etichetta amichevole mostrata nella barra laterale. Se la lasci vuota, specrails usa il nome della cartella.

**Provider**

Scegli quale o quali provider AI dovrà usare questo progetto. Specrails ti mostra quelli che ha rilevato sulla tua macchina:

- 🤖 **Claude**
- ⚡ **Codex**
- ✨ **Gemini**

I provider che non ha trovato appaiono in grigio e contrassegnati come *non trovati* — installane uno e accedi, poi riapri la finestra. Per impostazione predefinita ogni provider disponibile è preselezionato, ma puoi deselezionarli fino a tenere solo quello che ti serve. Se ne scegli più di uno, il **primo** diventa il provider predefinito del progetto; potrai poi scegliere quale usare a seconda dell'attività.

> Un controllo rapido viene eseguito in background per confermare che gli strumenti richiesti siano presenti. Se manca qualcosa di essenziale, il pulsante **Aggiungi** resta disabilitato e un link **Ulteriori informazioni** ti fornisce i comandi di installazione esatti.

Clicca su **Aggiungi** per continuare.

## Una configurazione che si completa in pochi secondi

Se la cartella ha già specrails configurato, hai finito — il progetto compare istantaneamente nella tua barra laterale.

Se invece è un progetto nuovo, parte una breve **procedura guidata di configurazione**. Si articola in tre passaggi:

1. **Configura** — conferma le impostazioni di base per ciascun provider che hai scelto.
2. **Installa** — specrails configura il progetto automaticamente. Si tratta dell'installazione *rapida*: agenti template pronti all'uso, predisposti nel giro di pochi secondi. Vedrai un log in tempo reale durante l'esecuzione.
3. **Fatto** — un riepilogo che conferma che è tutto pronto.

Per un progetto multi-provider, l'installazione viene eseguita una volta per provider, uno dopo l'altro, e il passaggio Fatto mostra una scheda per ciascuno.

## Cosa viene installato

La configurazione è volutamente leggera e **non invasiva**. Specrails aggiunge una piccola quantità di configurazione al tuo progetto così che la pipeline sappia come funzionare:

- Una cartella `.specrails/` che contiene i profili degli agenti e le impostazioni locali del progetto.
- Definizioni di agenti sotto `.claude/agents/` che alimentano la pipeline Architect → Developer → Reviewer → Ship.

Tutto qui — specrails non riscriverà il tuo codice sorgente durante la configurazione, e questi file possono tranquillamente essere committati se vuoi condividere la configurazione con il tuo team.

> **Preferisci la configurazione approfondita?** L'app propone di proposito l'installazione rapida basata su template. Se preferisci il flusso arricchito dall'AI (analisi del codebase e personas di agenti personalizzate), puoi eseguire `npx specrails-core@latest init` dalla cartella del tuo progetto in un terminale.

## Ci sei

Una volta terminata la configurazione, specrails ti porta direttamente nella dashboard del tuo progetto. È il momento del tour — vai a [Il tour della dashboard](the-dashboard-tour).
