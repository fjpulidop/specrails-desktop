# Lavorare in un progetto esistente {#existing-projects}

Queste funzioni aiutano i run a rispettare un progetto che esiste già: ciò che una spec lascia fuori, le domande dell'architetto prima di pianificare, quali requisiti un test dimostra davvero, come descrivere il codice esistente prima di cambiarlo e le regole che il tuo team ha già scritto. Ognuna richiede una versione di specrails-core che la supporti; nel frattempo il suo interruttore è disattivato con una nota per aggiornare Core.

## Fuori ambito

Ogni spec può elencare ciò che volutamente **non** cambia. Quick ed Explore lo compilano per te; nella finestra della spec appare come **Fuori ambito** sotto la descrizione, un elemento per riga, e si modifica come qualsiasi altro campo. Gli agenti lo ricevono con la spec a ogni avvio.

## Domande dell'architetto su Jira

In **Impostazioni ▸ Ancoraggio nei progetti esistenti**, attiva **Pubblica i chiarimenti dell'architetto su Jira**. Quando un run si ferma perché l'architetto ha bisogno di una risposta, o prosegue su ipotesi, Specrails le pubblica come un commento sull'issue Jira collegata. Rispondi a quel commento in Jira: la risposta viene aggiunta alla spec come chiarimento e il run successivo della spec la legge. Puoi comunque rispondere a un run in pausa dall'app.

## Requisiti dimostrati

Quando un test nomina il requisito che dimostra (`[spec:<capability>/<requisito>]` nel titolo), la pagina di revisione mostra **Requisiti dimostrati X/Y**: quali requisiti dimostra un test riuscito, quali non ne hanno ancora uno e quali ha toccato la modifica stessa. Le analisi mostrano lo stesso per loop. Per far fallire la CI quando un requisito modificato non ha test, aggiungi `specrails-core pipeline trace --check --tests-passed` dopo i tuoi test.

La libreria dei loop offre anche **Controllo del drift**, un loop di sola lettura che confronta ciò che dice ogni spec con ciò che fa il codice ed elenca ogni contraddizione. Non modifica nulla.

## Baseline al contatto

Attiva **Baseline al contatto** perché una modifica che raggiunge codice non descritto da nessuna spec cominci descrivendolo: test del comportamento attuale, dimostrati sul codice invariato, e una breve spec dell'esistente. La pagina di revisione mostra **Spec creata dove è passato il lavoro** con il modulo, i requisiti e i test, e il suo costo è mostrato a parte. Se quei test falliscono sul codice invariato, il run si ferma prima di modificare il modulo e lo segnala.

## Regole del progetto {#project-rules}

**Impostazioni ▸ Regole del progetto** elenca i controlli che il tuo progetto esegue già (lint, tipi, test, CI) e ogni regola scritta in file come `CLAUDE.md` o `AGENTS.md`, suddivise in:

- **Applicata**: un controllo la garantisce già.
- **Automatizzabile**: un controllo potrebbe farlo. **Crea spec** la trasforma in spec con un clic.
- **Solo umana**: qualcuno deve guardarla. Compaiono in ogni pagina di revisione sotto **Serve un occhio umano**.

Le regole che Core non ha ancora potuto classificare (per esempio subito dopo aver aggiunto il progetto, quando l'inventario gira offline) compaiono come **Non classificata**; **Riesegui l'inventario** con un provider configurato le classifica.

**Riesegui l'inventario** aggiorna l'elenco. Quando un progetto non ha ancora comandi di verifica, le impostazioni dell'agent runtime propongono per primi questi controlli.
