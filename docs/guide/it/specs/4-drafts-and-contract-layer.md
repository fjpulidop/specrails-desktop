# Le bozze e il Contract Layer

Questa pagina copre due modi per sfruttare meglio le tue spec: le **bozze** (salvare un'idea in corso così da riprenderla in seguito) e il **Contract Layer** (un arricchimento facoltativo che rende le spec più precise per la pipeline AI).

## Bozze: salvare un'idea in corso

Una **bozza** è una conversazione [Explore](add-spec-explore-mode.md) in corso, salvata come spec. Ti permette di fermarti a metà ragionamento senza perdere nulla e di tornarci quando sei pronto.

### Salvare una bozza

Mentre sei in una conversazione Explore, clicca su **Salva come bozza** (disponibile una volta che hai inviato almeno un messaggio). L'app:

- Crea una spec con stato **Bozza** sulla tua board.
- Le assegna automaticamente un titolo se non ne hai impostato uno (un breve riepilogo della conversazione).
- La ricollega alla conversazione, così l'intera cronologia chat viene conservata.

Il salvataggio è idempotente — se salvi la stessa conversazione due volte, aggiorna la bozza esistente invece di crearne una duplicata.

### Come appaiono le bozze sulla board

Le bozze vivono nello stesso gruppo attivo delle tue spec Da fare — non c'è una colonna separata. Le riconosci da:

- Un badge `Draft` dove normalmente si trova il badge della priorità.
- Un bordo dalla tinta sottile sulla card.

Una bozza può non avere *alcuna priorità* — la priorità la imposti quando la confermi trasformandola in una spec vera e propria.

### Riprendere una bozza

Per riprendere da dove avevi lasciato:

1. Apri la bozza dalla board.
2. Clicca su **Continua a modificare** nel modale di dettaglio.
3. La conversazione Explore originale si riapre con la sua cronologia chat completa, e il pannello della bozza live precompilato con tutto ciò che avevi modellato fino a quel momento.
4. Continua a conversare. Quando hai finito, **Crea spec** promuove la bozza a una spec vera e propria (stato **Da fare**, con la priorità che scegli).

### Scartare una bozza

Le bozze **non vengono mai eliminate automaticamente**. Spariscono solo quando le scarti esplicitamente, oppure quando le confermi in uno stato non-bozza. Scartare una bozza ripulisce anche la sua conversazione collegata, quando nient'altro vi fa riferimento.

> Suggerimento: quando non sei sicuro che una spec valga la pena, salvala come bozza e lasciala lì. Aprila il mattino dopo, dai un'occhiata alla descrizione e decidi con occhi freschi.

## Il Contract Layer: precisione per la pipeline

Il **Contract Layer** è un arricchimento facoltativo che aggiunge un blocco strutturato alla descrizione di una spec. Il suo compito è eliminare le incertezze per gli agenti AI che realizzano la spec — così riutilizzano i nomi giusti, rispettano le forme dei dati attese e toccano i file giusti invece di inventarne di propri.

### Cosa aggiunge

Il Contract Layer è composto da cinque brevi sezioni aggiunte alla spec:

- **Naming Contract** — gli identificatori esatti (funzioni, campi, route) che l'implementazione dovrebbe riutilizzare.
- **Data Shapes** — i payload in stile JSON coinvolti.
- **State Machine** — le transizioni o gli stati attraverso cui passa la funzionalità.
- **Invariants** — le proprietà che devono sempre rimanere vere.
- **File Touch List** — i file che l'implementazione dovrebbe modificare.

Pensalo come consegnare alla pipeline un progetto preciso invece di uno schizzo. È particolarmente prezioso per le spec che si innestano in codice esistente, dove un nome o una forma indovinata dall'AI causerebbe del lavoro da rifare.

### Come aggiungerlo

Ci sono tre modi in cui il Contract Layer viene applicato:

- **Modalità Quick** — attiva il toggle **Arricchisci con Contract Layer** prima di generare. La tua ultima scelta viene ricordata per ogni progetto. (Vedi [Aggiungi spec — Modalità Quick](add-spec-quick-mode.md).)
- **Modalità Explore** — scegli il preset di contesto **Max** o **Desktop** (che eseguono l'arricchimento automaticamente alla conferma), oppure apri **Fine-tune** e attivalo manualmente. (Vedi [Aggiungi spec — Modalità Explore](add-spec-explore-mode.md).)
- **Su una spec esistente** — apri il modale di dettaglio della spec e ri-esegui l'arricchimento da lì.

### Dove appare

Una volta che una spec ha un Contract Layer, il modale di dettaglio lo mostra come una sezione comprimibile con un badge tipo `3/5 compilate` — che ti dice quante delle cinque sezioni sono state effettivamente compilate (alcune funzionalità semplicemente non hanno, ad esempio, una state machine, e quelle sezioni vengono contrassegnate come non applicabili). Espandila per leggere il contratto completo; comprimila per mantenere ordinata la descrizione.

Se l'arricchimento dovesse fallire, l'app mostra una notifica con un'azione **Riprova** così puoi rilanciarlo.

### Vale sempre la pena?

Non sempre. Per una spec piccola e autonoma l'AI riesce a implementarla bene anche senza. Il Contract Layer dà il suo valore sulle spec che si integrano strettamente con il codice esistente, dove nomi e forme esatti contano — è lì che fissare il contratto in anticipo ti risparmia un giro di correzioni più avanti.

## Dove andare adesso

- [Aggiungi spec — Modalità Explore](add-spec-explore-mode.md) — da dove arrivano le bozze.
- [Aggiungi spec — Modalità Quick](add-spec-quick-mode.md) — il toggle del Contract Layer in modalità Quick.
- [Esecuzione delle pipeline](running-pipelines.md) — realizza una spec una volta che è pronta.
