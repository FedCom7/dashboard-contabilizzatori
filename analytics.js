// ==========================================
// Analytics — calcoli puri su letture, periodi e meteo.
// Nessun accesso al DOM: tutto ciò che serve ai grafici nasce qui.
// ==========================================

(() => {
const ROOMS = ['cucina', 'soggiorno', 'camera', 'cameretta', 'bagno'];
const ROOM_LABELS = {
    cucina: 'Kitchen', soggiorno: 'Living room', camera: 'Bedroom',
    cameretta: "Kids' room", bagno: 'Bathroom'
};

const DAY_MS = 86400000;
const HDD_BASE = 20;            // gradi-giorno: base 20 °C (convenzione italiana DPR 412/93)
const MAX_OPEN_PERIOD_DAYS = 210; // un periodo senza spegnimento si considera chiuso dopo ~7 mesi

// ---------- Date helpers (sempre in ora locale, mai UTC) ----------
const parseYMD = (s) => {
    if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((parseYMD(b) - parseYMD(a)) / DAY_MS);
const today = () => parseYMD(new Date());

// ---------- Seasons ----------
// Una stagione va dal 1 agosto al 31 luglio: "25/26" = ago 2025 → lug 2026.
const seasonOf = (date) => {
    const d = parseYMD(date);
    const y = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
    return `${String(y % 100).padStart(2, '0')}/${String((y + 1) % 100).padStart(2, '0')}`;
};
const seasonStartYear = (key) => 2000 + parseInt(String(key).match(/\d{2}/)[0], 10);
const seasonStart = (key) => new Date(seasonStartYear(key), 7, 1);
const dayOfSeason = (date, key) => daysBetween(seasonStart(key), date);
const compareSeasons = (a, b) => seasonStartYear(a) - seasonStartYear(b);
const readingSeason = (r) => r.stagione || seasonOf(r.data);

const total = (r) => ROOMS.reduce((s, k) => s + (+r[k] || 0), 0);

// ---------- Heating periods ----------
// Fine effettiva di un periodo: quella registrata, oppure oggi (limitata a MAX_OPEN_PERIOD_DAYS).
const periodEnd = (p) => {
    if (p.end) return parseYMD(p.end);
    const cap = addDays(parseYMD(p.start), MAX_OPEN_PERIOD_DAYS);
    const t = today();
    return t < cap ? t : cap;
};
const isPeriodOpen = (p) => !p.end && today() <= addDays(parseYMD(p.start), MAX_OPEN_PERIOD_DAYS);
const isHeatingOn = (date, periods) => {
    const d = parseYMD(date);
    return periods.some(p => p.start && d >= parseYMD(p.start) && d <= periodEnd(p));
};

// ---------- Weather ----------
// weather = { time: ['2018-08-01', ...], temp: [12.3, ...] } → Map data → temperatura media
const weatherIndex = (weather) => {
    const m = new Map();
    if (!weather || !weather.time) return m;
    weather.time.forEach((t, i) => { if (weather.temp[i] != null) m.set(t, weather.temp[i]); });
    return m;
};
const hddOf = (temp) => Math.max(0, HDD_BASE - temp);

// ---------- Stagioni: struttura completa ----------
/**
 * Costruisce il modello di ogni stagione.
 * points: letture ordinate con totale cumulativo (i contatori ripartono da 0 a ogni stagione).
 */
const buildSeasons = (readings, periods, weather) => {
    const temps = weatherIndex(weather);
    const groups = new Map();
    readings.forEach(r => {
        const key = readingSeason(r);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    });

    const t0 = today();
    const seasons = [...groups.keys()].sort(compareSeasons).map(key => {
        const sorted = groups.get(key).slice().sort((a, b) => a.data.localeCompare(b.data));
        const points = sorted.map(r => ({
            date: r.data,
            day: dayOfSeason(r.data, key),
            total: total(r),
            rooms: Object.fromEntries(ROOMS.map(k => [k, +r[k] || 0])),
            raw: r
        }));
        const last = points[points.length - 1];
        const seasonPeriods = periods.filter(p => p.start && seasonOf(p.start) === key)
            .sort((a, b) => a.start.localeCompare(b.start));

        // Giorni di riscaldamento e gradi-giorno, limitati all'intervallo coperto dalle letture
        const firstDate = parseYMD(points[0].date);
        const lastDate = parseYMD(last.date);
        let heatingDays = 0, hdd = 0, hddMissing = 0;
        seasonPeriods.forEach(p => {
            const s = parseYMD(p.start), e = periodEnd(p);
            for (let d = new Date(Math.max(s, firstDate)); d <= e && d <= lastDate; d = addDays(d, 1)) {
                heatingDays++;
                const t = temps.get(ymd(d));
                if (t == null) hddMissing++; else hdd += hddOf(t);
            }
        });

        // Una stagione è "completa" se le letture arrivano oltre lo spegnimento,
        // o almeno fino ad aprile quando lo spegnimento non è registrato.
        const lastPeriod = seasonPeriods[seasonPeriods.length - 1];
        const aprilFirst = new Date(seasonStartYear(key) + 1, 3, 1);
        const complete = lastPeriod && lastPeriod.end
            ? lastDate >= addDays(parseYMD(lastPeriod.end), -10)
            : lastDate >= aprilFirst;

        const finalRooms = last.rooms;
        return {
            key,
            points,
            final: last.total,
            finalRooms,
            firstDate: points[0].date,
            lastDate: last.date,
            lastDay: last.day,
            periods: seasonPeriods,
            heatingStart: seasonPeriods[0]?.start || null,
            heatingEnd: lastPeriod ? (lastPeriod.end || null) : null,
            heatingOpen: lastPeriod ? isPeriodOpen(lastPeriod) : false,
            heatingDays,
            hdd: hddMissing > heatingDays * 0.1 ? null : hdd, // troppi giorni senza meteo → non affidabile
            complete,
            stale: !complete && daysBetween(last.date, t0) > 35,
            perHdd: null,
            adjusted: null
        };
    });

    // Efficienza: unità per grado-giorno e totale "a parità di clima"
    const withHdd = seasons.filter(s => s.complete && s.hdd > 0);
    const meanHdd = withHdd.length ? withHdd.reduce((a, s) => a + s.hdd, 0) / withHdd.length : null;
    seasons.forEach(s => {
        if (s.hdd > 0) {
            s.perHdd = s.final / s.hdd;
            if (s.complete && meanHdd) s.adjusted = s.final * meanHdd / s.hdd;
        }
    });
    seasons.meanHdd = meanHdd;
    return seasons;
};

// Valore cumulativo interpolato al giorno `day` della stagione
const valueAtDay = (season, day) => {
    const pts = season.points;
    if (day < pts[0].day) return pts[0].day <= 0 ? pts[0].total : 0;
    if (day > season.lastDay) return season.complete ? season.final : null;
    for (let i = 1; i < pts.length; i++) {
        if (pts[i].day >= day) {
            const a = pts[i - 1], b = pts[i];
            if (b.day === a.day) return b.total;
            return a.total + (b.total - a.total) * (day - a.day) / (b.day - a.day);
        }
    }
    return season.final;
};

// Confronto della stagione `latest` con la media delle stagioni complete, allo stesso giorno
const paceVsAverage = (seasons, latest) => {
    const past = seasons.filter(s => s.complete && s.key !== latest.key);
    if (!past.length) return null;
    const day = latest.lastDay;
    const values = past.map(s => ({ key: s.key, value: valueAtDay(s, day), final: s.final }))
        .filter(v => v.value != null);
    if (!values.length) return null;
    const avg = values.reduce((a, v) => a + v.value, 0) / values.length;
    const delta = avg > 0 ? latest.final / avg - 1 : null;
    // Proiezione: quota di stagione tipicamente consumata a quel giorno
    const shares = values.filter(v => v.value > 0 && v.final > 0).map(v => v.value / v.final);
    let projection = null;
    if (shares.length && latest.final > 0 && !latest.complete) {
        const est = shares.map(sh => latest.final / sh).sort((a, b) => a - b);
        const mid = est.reduce((a, b) => a + b, 0) / est.length;
        projection = { mid, low: est[0], high: est[est.length - 1] };
    }
    const rank = values.filter(v => v.value < latest.final).length; // stagioni più basse a quel giorno
    return { day, avg, delta, projection, rank, count: values.length, values };
};

// ---------- Stima giornaliera ----------
/**
 * Distribuisce il consumo tra due letture sui singoli giorni:
 * peso = gradi-giorno nei giorni di riscaldamento (0 fuori dai periodi).
 * Ritorna [{ date, value, temp, heating, reading }].
 */
const dailyEstimate = (season, periods, weather) => {
    const temps = weatherIndex(weather);
    const out = [];
    const pts = season.points;
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const n = daysBetween(a.date, b.date);
        if (n <= 0) continue;
        const delta = Math.max(0, b.total - a.total);
        const days = [];
        for (let k = 1; k <= n; k++) {
            const d = addDays(parseYMD(a.date), k);
            const key = ymd(d);
            const temp = temps.has(key) ? temps.get(key) : null;
            const heating = isHeatingOn(d, periods);
            const w = heating ? (temp == null ? 1 : Math.max(0.5, hddOf(temp))) : 0;
            days.push({ date: key, temp, heating, w, reading: k === n });
        }
        let sumW = days.reduce((s, d) => s + d.w, 0);
        if (sumW === 0) { days.forEach(d => d.w = 1); sumW = n; } // consumo fuori periodo: distribuzione uniforme
        days.forEach(d => out.push({ date: d.date, value: delta * d.w / sumW, temp: d.temp, heating: d.heating, reading: d.reading }));
    }
    return out;
};

// Somma settimanale (lunedì → domenica) della stima giornaliera
const weeklyTotals = (daily) => {
    const weeks = new Map();
    daily.forEach(d => {
        const dt = parseYMD(d.date);
        const monday = ymd(addDays(dt, -((dt.getDay() + 6) % 7)));
        if (!weeks.has(monday)) weeks.set(monday, { week: monday, value: 0, tSum: 0, tN: 0 });
        const w = weeks.get(monday);
        w.value += d.value;
        if (d.temp != null) { w.tSum += d.temp; w.tN++; }
    });
    return [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week))
        .map(w => ({ week: w.week, value: w.value, temp: w.tN ? w.tSum / w.tN : null }));
};

// Intervalli sospetti: forte aumento con il riscaldamento spento (probabile errore di battitura)
const anomalies = (seasons, periods) => {
    const out = new Map();
    seasons.forEach(s => {
        for (let i = 1; i < s.points.length; i++) {
            const a = s.points[i - 1], b = s.points[i];
            const n = daysBetween(a.date, b.date);
            let heat = 0;
            for (let k = 1; k <= n; k++) if (isHeatingOn(addDays(parseYMD(a.date), k), periods)) heat++;
            ROOMS.forEach(k => {
                const d = b.rooms[k] - a.rooms[k];
                if (d > 50 && heat / Math.max(1, n) < 0.25) {
                    out.set(b.date, `${ROOM_LABELS[k]} rose by ${d} while the heating was off — check this reading.`);
                }
            });
        }
    });
    return out;
};

// ---------- Firma energetica ----------
// Ogni intervallo tra letture (in riscaldamento) diventa un punto: temperatura media → unità/giorno
const signaturePoints = (seasons, periods, weather) => {
    const temps = weatherIndex(weather);
    const pts = [];
    seasons.forEach(s => {
        for (let i = 1; i < s.points.length; i++) {
            const a = s.points[i - 1], b = s.points[i];
            const n = daysBetween(a.date, b.date);
            if (n < 5 || n > 45) continue;
            let tSum = 0, tN = 0, heat = 0;
            for (let k = 1; k <= n; k++) {
                const d = addDays(parseYMD(a.date), k);
                if (isHeatingOn(d, periods)) heat++;
                const t = temps.get(ymd(d));
                if (t != null) { tSum += t; tN++; }
            }
            const delta = b.total - a.total;
            if (heat / n < 0.8 || tN < n * 0.8 || delta < 0) continue;
            const rooms = Object.fromEntries(ROOMS.map(k => [k, Math.max(0, b.rooms[k] - a.rooms[k]) / n]));
            pts.push({ season: s.key, from: a.date, to: b.date, days: n, temp: tSum / tN, rate: delta / n, rooms });
        }
    });
    return pts;
};

const linearFit = (pts, xKey, yKey) => {
    const n = pts.length;
    if (n < 3) return null;
    const mx = pts.reduce((s, p) => s + p[xKey], 0) / n;
    const my = pts.reduce((s, p) => s + p[yKey], 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    pts.forEach(p => {
        sxy += (p[xKey] - mx) * (p[yKey] - my);
        sxx += (p[xKey] - mx) ** 2;
        syy += (p[yKey] - my) ** 2;
    });
    if (sxx === 0) return null;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    const r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
    return { slope, intercept, r2, at: (x) => intercept + slope * x, zero: slope ? -intercept / slope : null };
};

// Firma per stanza: sensibilità al freddo (unità/giorno per °C) complessiva e stagione per stagione
const roomSignatures = (sigPoints) => {
    const out = {};
    const seasons = [...new Set(sigPoints.map(p => p.season))].sort(compareSeasons);
    ROOMS.forEach(k => {
        const pts = sigPoints.map(p => ({ season: p.season, temp: p.temp, rate: p.rooms[k], from: p.from, to: p.to, days: p.days }));
        const fit = linearFit(pts, 'temp', 'rate');
        const bySeason = seasons.map(key => {
            const sp = pts.filter(p => p.season === key);
            const f = sp.length >= 4 ? linearFit(sp, 'temp', 'rate') : null;
            // Una pendenza positiva (più consumo col caldo) non ha senso fisico: dati insufficienti
            return { key, n: sp.length, fit: f && f.slope < 0 ? f : null, mean: sp.length ? sp.reduce((a, p) => a + p.rate, 0) / sp.length : null };
        });
        out[k] = { points: pts, fit, bySeason };
    });
    return out;
};

// ---------- Prossima lettura ----------
// Letture di domenica ogni 2 settimane, dalla prima domenica dopo l'accensione
const nextMeasure = (periods) => {
    const t = today();
    const candidates = [];
    periods.forEach(p => {
        if (!p.start) return;
        const end = p.end ? parseYMD(p.end) : addDays(parseYMD(p.start), MAX_OPEN_PERIOD_DAYS);
        let d = parseYMD(p.start);
        d = addDays(d, (7 - d.getDay()) % 7);
        for (let i = 0; i < 40 && d <= end; i++, d = addDays(d, 14)) {
            if (d >= t) { candidates.push(d); break; }
        }
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => a - b);
    return { date: candidates[0], daysUntil: daysBetween(t, candidates[0]) };
};

// Tutte le date di lettura future dei periodi aperti (domeniche alterne) — per i promemoria in calendario
const upcomingMeasures = (periods, limit = 20) => {
    const t = today();
    const out = [];
    periods.forEach(p => {
        if (!p.start) return;
        const end = p.end ? parseYMD(p.end) : addDays(parseYMD(p.start), MAX_OPEN_PERIOD_DAYS);
        let d = parseYMD(p.start);
        d = addDays(d, (7 - d.getDay()) % 7);
        for (; d <= end && out.length < limit * 3; d = addDays(d, 14)) if (d >= t) out.push(new Date(d));
    });
    return out.sort((a, b) => a - b).slice(0, limit);
};

// ---------- Validazione di una nuova lettura ----------
const validateReading = (reading, readings) => {
    const warnings = [];
    const key = readingSeason(reading);
    const prev = readings
        .filter(r => readingSeason(r) === key && r.data < reading.data)
        .sort((a, b) => b.data.localeCompare(a.data))[0];
    if (readings.some(r => r.data === reading.data && r !== reading)) {
        warnings.push(`A reading for ${reading.data} already exists — it will be replaced.`);
    }
    if (prev) {
        ROOMS.forEach(k => {
            if ((+reading[k] || 0) < (+prev[k] || 0)) {
                warnings.push(`${ROOM_LABELS[k]} is lower than the previous reading (${prev[k]}). Meters only go up — is this a new season?`);
            }
        });
    }
    return { prev, warnings };
};

window.Analytics = {
    ROOMS, ROOM_LABELS, HDD_BASE,
    parseYMD, ymd, addDays, daysBetween, today,
    seasonOf, seasonStart, seasonStartYear, dayOfSeason, compareSeasons, readingSeason,
    total, periodEnd, isPeriodOpen, isHeatingOn, hddOf, weatherIndex,
    buildSeasons, valueAtDay, paceVsAverage, dailyEstimate, weeklyTotals, anomalies, signaturePoints, roomSignatures, linearFit,
    nextMeasure, upcomingMeasures, validateReading
};
})();
