# Dashboard Contabilizzatori

Una dashboard interattiva per visualizzare e analizzare i consumi di riscaldamento registrati dai contabilizzatori.

## Funzionalità

- **Dashboard**: Panoramica dei consumi con grafici di andamento, confronto annuale e variazione.
- **Inserimento**: Interfaccia per inserire nuove letture e gestire i periodi di riscaldamento.
- **Dettaglio**: Tabelle e grafici dettagliati per ogni lettura.
- **Import/Export**: Funzionalità per importare dati da CSV o esportare in JSON.
- **Meteo**: Integrazione con dati meteo storici per correlare consumi e temperature.

## Utilizzo Online (GitHub Pages)

La dashboard è progettata per funzionare come sito statico. I dati vengono caricati dal file `data.js` che funge da database statico quando l'API server non è disponibile.

Per aggiornare i dati:
1. Modificare il file `data.js` inserendo le nuove letture o periodi di riscaldamento.
2. Committare e pushare le modifiche su GitHub.

## Sviluppo Locale

Per eseguire il progetto in locale con il server API (opzionale):

1. Assicurarsi di avere [Node.js](https://nodejs.org/) installato.
2. Installare le dipendenze (se presenti `package.json`):
   ```bash
   npm install
   ```
3. Avviare il server:
   ```bash
   node server.js
   ```
4. Aprire il browser su `http://localhost:3000`.

## Struttura Dati

- `letture.json`: Database utilizzato dal server Node.js locale.
- `data.js`: Fallback statico per l'utilizzo senza server (es. GitHub Pages).
# dashboard-contabilizzatori
