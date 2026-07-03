# Batch implement e multi-feature

Una spec alla volta va benissimo, ma molto del lavoro reale arriva a grappoli — una feature più i suoi test più la sua migrazione, oppure un backlog che vuoi smaltire in un'unica sessione. Questa pagina spiega come eseguire più spec insieme: la modalità Batch, le ondate di dipendenze e come la pipeline evita che il lavoro concorrente entri in collisione.

## Eseguire più spec in una volta sola

Il modo più semplice per eseguire un mucchio di spec da un unico rail è la modalità **Batch**:

1. **Trascina tutte le spec** che vuoi su un singolo rail. Si accumulano nell'elenco di spec di quel rail.
2. **Imposta la modalità del rail su Batch** (il controllo segmentato nell'intestazione del rail).
3. **Premi ▶ Play.**

Il rail avvia **un solo** job `/specrails:batch-implement` che lavora ogni spec assegnata. Monitoralo come qualsiasi altro job nella pagina Job — è un unico job che copre l'intero gruppo, non un job per ogni spec.

Questo è importante per via della **coda a un job per progetto**. Dato che un progetto esegue un solo job di rail alla volta, la modalità Batch è anche il modo più pulito per *concatenare* un elenco di spec senza dover gestire più rail e aspettare che ciascuno si svuoti.

### Implement vs Batch — quale modalità?

| | **Implement** | **Batch** |
|---|---|---|
| Comando | `/specrails:implement` | `/specrails:batch-implement` |
| Spec per job | Tutte sul rail, trattate come un'unica unità di lavoro | Tutte sul rail, lavorate **in sequenza** |
| Ideale per | Una modifica strettamente accoppiata | Più feature distinte che vuoi smaltire in ordine |
| Ordinamento | n/d | Ondate consapevoli delle dipendenze (vedi sotto) |

Se le spec sono davvero un'unica modifica, usa **Implement**. Se sono un elenco di feature separate, usa **Batch** e lascia che le metta in sequenza.

## Ondate di dipendenze

La modalità Batch non si limita a eseguire le spec dall'alto verso il basso — calcola un **ordine di esecuzione consapevole delle dipendenze** e raggruppa le spec in *ondate*. L'orchestratore (`/specrails:batch-implement`) capisce quali spec dipendono da quali altre, poi le pianifica in modo che nulla parta prima del lavoro su cui si appoggia.

Concettualmente:

```
Ondata 1:  #2 (modello dati)        ← nessuna dipendenza, parte per prima
Ondata 2:  #4 (API sul modello)     ← attende #2
           #5 (CLI sul modello)     ← attende #2
Ondata 3:  #7 (docs su tutto)       ← attende #4 e #5
```

All'interno del job, le spec di ogni ondata vengono implementate prima che inizi l'ondata successiva. Non lo configuri a mano — l'orchestratore ricava le ondate dalle spec stesse. Guarda tutto svolgersi nella [vista Dettaglio job](the-job-detail-view): il log in streaming racconta su quale spec sta lavorando il batch, e l'intestazione ticket mostra ogni spec toccata dal job.

## Isolamento worktree e come viene consegnato il lavoro

Quando più spec vengono implementate in un'unica esecuzione, la pipeline mantiene isolata ogni unità di lavoro, così che le modifiche concorrenti o sequenziali non si calpestino i file a vicenda. L'implementazione di ogni spec viene eseguita nel suo **git worktree** pulito e dedicato — un checkout separato che condivide la cronologia del tuo repository ma non tocca mai il tuo working tree mentre l'IA lavora.

Quando l'esecuzione termina, i branch isolati vengono assemblati e consegnati come **un'unica pull request in bozza** a partire dal ramo di integrazione designato del tuo progetto (impostalo in **Impostazioni → Ramo di integrazione**; per impostazione predefinita corrisponde al ramo predefinito del tuo repository). specrails **non esegue mai il merge e non committa mai direttamente sul tuo ramo di integrazione** — ricevi una PR in bozza da revisionare, e il merge resta in mano a una persona. È la consegna sicura: specrails produce la pull request, i tuoi sviluppatori la revisionano e la fondono su GitHub come già fanno.

In pratica questo significa:

- Ogni spec ottiene una tabula rasa su cui implementare, invece di ereditare a metà corsa le modifiche ancora in corso della spec precedente.
- Il tuo working tree non viene mai modificato mentre l'esecuzione è in corso — nulla viene applicato finché non sei tu a dirlo.
- Quando l'esecuzione è terminata ricevi una notifica con la PR in bozza: **Apri PR** per visualizzarla, oppure **Approva** per promuoverla a pronta-per-la-revisione e affidarla alla normale revisione GitHub del tuo team.
- Se i branch isolati non possono essere combinati in modo pulito, specrails si ferma in sicurezza e lascia i branch a una persona — non forza mai un merge rotto sul tuo ramo base.

> La consegna della PR richiede la GitHub CLI (`gh`) autenticata e un remote configurato. Senza di essi, specrails committa comunque il lavoro su un branch da cui puoi aprire tu stesso una pull request — non si perde nulla. Per tornare al comportamento precedente (integrazione in locale invece di aprire una PR), imposta `SPECRAILS_RAIL_DELIVER_PR=0`.

## Multi-feature tra progetti

Se vuoi un vero parallelismo — due grandi feature che vengono costruite nello stesso momento — dividile **tra progetti diversi**, non tra rail nello stesso progetto. Ogni progetto ha la sua coda indipendente, quindi:

```
Progetto A   ▶ Rail che esegue la feature X   ┐
                                              ├─ vengono eseguiti in contemporanea
Progetto B   ▶ Rail che esegue la feature Y   ┘
```

Non c'è alcun limite globale di concorrenza né contesa tra progetti. Apri entrambi, avvia un rail in ciascuno e procedono insieme. L'unico freno condiviso è il tuo limite di budget, che mette in pausa le code per progetto o per tutta l'app quando la spesa della giornata raggiunge il limite.

## Consigli per i batch grandi

- **Raggruppa le spec correlate su un unico rail** prima di passare a Batch — le ondate di dipendenze vedono solo ciò che si trova su quel rail.
- **Imposta un budget giornaliero** prima di un batch grande, così un'esecuzione inaspettatamente costosa va in pausa automatica invece di andare fuori controllo. Configuralo in [Budget](../settings/customizing).
- **Usa il pulsante Confronta** nella pagina Job dopo l'esecuzione per mettere a confronto due batch fianco a fianco.
- **Esporta una diagnostica** (se la telemetria era attiva) per ottenere lo snapshot esatto di profilo + plugin dell'intero batch.

## Dove andare ora

- [Rail e job](rails-and-jobs) — il modello della coda in dettaglio.
- [La vista Dettaglio job](the-job-detail-view) — guarda un batch in esecuzione dal vivo.
- [Scegliere un engine per ogni rail](picking-an-engine-per-rail) — nota che il Batch gira su qualsiasi provider; Ultra è solo Claude.
