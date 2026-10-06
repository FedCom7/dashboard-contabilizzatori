# Heat Ledger — Dashboard Contabilizzatori

Dashboard per registrare le letture dei contabilizzatori di calore di casa e confrontare i consumi stagione per stagione.

## Viste

- **Overview** — stagione più recente (ritmo vs. media allo stesso giorno, proiezione se in corso), prossima lettura con inserimento rapido, "corsa delle stagioni" cumulata, totali per stagione (misurati o corretti per il clima), ripartizione per stanza.
- **Seasons** — consumo corretto per i gradi-giorno ("meteo o abitudini?"), freddo vs. consumo, calendario dei periodi di riscaldamento, tabella riassuntiva.
- **Rooms** — quote per stanza (barre 100%), small multiples per stanza, cambiamenti notevoli.
- **Climate** — consumo settimanale stimato e temperatura esterna allineati, firma energetica (unità/giorno vs. temperatura, temperatura di "spegnimento"), calendario giornaliero.
- **Readings** — periodi di riscaldamento, registro letture (contatore / variazione / al giorno), modifica ed eliminazione. Le letture sospette (forti aumenti a riscaldamento spento) sono segnalate con ⚠︎.

## Metodo

- Le stagioni vanno dal 1 agosto al 31 luglio; i contatori ripartono da zero a ogni stagione.
- **Gradi-giorno**: somma di `max(0, 20 °C − T media)` sui giorni di riscaldamento coperti dalle letture (base 20 °C, convenzione italiana). Temperature giornaliere dall'archivio storico [Open-Meteo](https://open-meteo.com/) per la posizione impostata.
- **Consumo corretto per il clima**: `totale × gradi-giorno medi / gradi-giorno della stagione`.
- **Stima giornaliera**: il consumo tra due letture viene distribuito sui giorni intermedi in proporzione ai gradi-giorno (zero fuori dai periodi di riscaldamento).
- Una stagione è *completa* se le letture arrivano fino allo spegnimento; altrimenti è *parziale* e viene confrontata con le altre allo stesso giorno della stagione.

- **Report** — resoconto di stagione scritto automaticamente (meteo, efficienza, picchi, stanze, letture), stampabile/PDF.
- **Firme per stanza** (in Rooms) — sensibilità al freddo di ogni stanza e temperatura a cui smette di scaldare, stagione per stagione.

## Telefono, promemoria, backup

- **Telefono**: Settings → *On your phone* mostra i QR code. In casa: l'indirizzo Wi‑Fi del server; ovunque: la versione GitHub Pages con Cloud sync. Poi *Condividi → Aggiungi alla schermata Home*. Il link `#new` apre subito l'inserimento.
- **Promemoria**: *Add reminders* / *Reading reminders* scarica un file `.ics` con le domeniche di lettura (una ogni due settimane, avviso alle 9:00). Reimportandolo gli eventi si aggiornano, non si duplicano.
- **Backup**: il server salva una copia datata in `backups/` prima di ogni modifica (ultime 100 per file); si ripristinano da Settings.

## Cloud sync (Firebase)

Configurazione una tantum nella console Firebase del progetto `dashboard-contabilizzatoti`:

1. **Firestore Database → Create database** (posizione europea, production mode).
2. **Authentication → Get started → Sign-in method → Email/Password**; poi **Users → Add user**.
3. **Authentication → Settings → Authorized domains**: verificare `fedcom7.github.io`.
4. Accedere da Settings → Cloud sync, copiare l'UID in `firestore.rules` al posto di `PASTE_YOUR_UID` e pubblicare le regole in **Firestore → Rules**.
5. *Sync now*. Da quel momento, per chi ha fatto l'accesso, il cloud è la fonte principale e il server locale ne tiene una copia (con backup).

## Avvio locale

```bash
node server.js
```

Poi aprire `http://localhost:3000`. Il server salva le letture in `letture.json` e i periodi di riscaldamento in `periods.json`.

## Struttura

- `index.html`, `styles.css` — interfaccia (stile Apple, tema chiaro/scuro).
- `analytics.js` — calcoli puri (stagioni, gradi-giorno, stime, regressioni).
- `charts.js` — grafici D3 in stile editoriale.
- `app.js` — stato, persistenza, rendering delle viste, import/export.
- `data.js` — dati iniziali di riserva per l'uso senza server (es. GitHub Pages).
- `firebase-service.js` — sincronizzazione opzionale con Firestore (usata solo se il server locale non è disponibile).
