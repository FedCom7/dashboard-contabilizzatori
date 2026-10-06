// ==========================================
// Heat Ledger — controller: stato, persistenza, viste
// ==========================================

const A = window.Analytics;
const C = window.Charts;
const { ROOMS, ROOM_LABELS } = A;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Storage locale (sempre protetto: può fallire in navigazione privata) ----------
const store = {
    get(key, fallback = null) {
        try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota o storage bloccato */ }
    }
};

// ---------- Server locale ----------
const api = {
    async get(path) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        try {
            const r = await fetch(path, { signal: ctrl.signal, cache: 'no-store' });
            if (!r.ok) return null;
            const data = await r.json();
            return Array.isArray(data) ? data : null;
        } catch { return null; } finally { clearTimeout(t); }
    },
    async post(path, data) {
        try {
            const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
            return r.ok;
        } catch { return false; }
    }
};

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// ---------- Stato ----------
const state = {
    readings: store.get('letture', []),
    periods: store.get('heatingPeriods', []),
    weather: null,
    settings: store.get('settings', { lat: 45.5962, lng: 8.9167 }),
    theme: store.get('theme', 'system'),
    serverOK: false,
    firebaseOK: false,              // accesso effettuato e Firestore raggiungibile
    cloud: { status: 'off', message: '' },
    serverOnly: null,               // differenze tra server locale e cloud da risolvere
    lanUrls: [],
    roomSigSeason: null,
    reportSeason: null,
    view: 'overview',
    barsMode: 'measured',
    climateSeason: null,
    logSeason: 'all',
    logMode: 'meter',
    model: null
};

const normalizeReading = (r) => {
    const o = { data: String(r.data).slice(0, 10), stagione: r.stagione || A.seasonOf(r.data) };
    ROOMS.forEach(k => o[k] = +r[k] || 0);
    return o;
};
const normalizePeriod = (p) => ({ start: p.start, end: p.end || null });
const sortReadings = () => state.readings.sort((a, b) => a.data.localeCompare(b.data));

const FS = () => window.FirebaseService;
const setCloud = (status, message = '') => { state.cloud = { status, message }; renderCloudStatus(); };

// Invio al cloud: non blocca l'interfaccia (offline le scritture restano in coda nella cache Firestore)
const pushToCloud = () => {
    if (!state.firebaseOK) return Promise.resolve();
    setCloud('syncing', 'Syncing…');
    return FS().sync(state.readings, state.periods)
        .then(n => setCloud('ok', n ? `Synced ${n} change${n > 1 ? 's' : ''}` : 'Up to date'))
        .catch(e => setCloud('error', FS().explain(e)));
};

// Persistenza: localStorage sempre, poi server (con backup automatico) e cloud se disponibili
const persist = async () => {
    sortReadings();
    store.set('letture', state.readings);
    store.set('heatingPeriods', state.periods);
    if (state.serverOK) {
        await Promise.all([api.post('/api/letture', state.readings), api.post('/api/periods', state.periods)]);
    }
    pushToCloud();
};

// ---------- Meteo (Open-Meteo, archivio storico) ----------
const loadWeather = async (force = false) => {
    const key = `${(+state.settings.lat).toFixed(4)},${(+state.settings.lng).toFixed(4)}`;
    const todayStr = A.ymd(A.today());
    const cache = store.get('weather_v2');
    if (cache && cache.key === key) state.weather = cache;
    if (!force && cache && cache.key === key && cache.fetchedOn === todayStr) return;

    const firstSeason = state.readings.length ? A.readingSeason(state.readings[0]) : A.seasonOf(A.today());
    const start = A.ymd(A.seasonStart(firstSeason));
    const end = A.ymd(A.addDays(A.today(), -1));
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${state.settings.lat}&longitude=${state.settings.lng}`
        + `&start_date=${start}&end_date=${end}&daily=temperature_2m_mean&timezone=Europe%2FRome`;
    try {
        const r = await withTimeout(fetch(url), 12000);
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        state.weather = { key, fetchedOn: todayStr, time: j.daily.time, temp: j.daily.temperature_2m_mean };
        store.set('weather_v2', state.weather);
    } catch (e) {
        console.warn('Weather unavailable', e);
    }
};

// ---------- Modello derivato ----------
const buildModel = () => {
    const seasons = A.buildSeasons(state.readings, state.periods, state.weather);
    const latest = seasons[seasons.length - 1] || null;
    const complete = seasons.filter(s => s.complete);
    const latestComplete = complete[complete.length - 1] || null;
    const pace = latest && !latest.complete ? A.paceVsAverage(seasons, latest) : null;
    const temps = A.weatherIndex(state.weather);
    const anomalies = A.anomalies(seasons, state.periods);
    state.model = { seasons, latest, complete, latestComplete, pace, temps, anomalies };
    if (!state.climateSeason || !seasons.some(s => s.key === state.climateSeason)) {
        const withData = seasons.filter(s => s.points.length > 2);
        state.climateSeason = withData[withData.length - 1]?.key || latest?.key || null;
    }
    return state.model;
};

// ---------- Formattazione ----------
const fmt = C.fmt, fmt1 = C.fmt1, fmt2 = C.fmt2;
const pctAbs = (v) => `${Math.abs(Math.round(v * 100))}%`;
const signed = (v) => C.pct(v);
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayMonth = (s) => { const d = A.parseYMD(s); return `${d.getDate()} ${MONTHS_LONG[d.getMonth()].slice(0, 3)}`; };
const fullDate = (s) => { const d = A.parseYMD(s); return `${d.getDate()} ${MONTHS_LONG[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const roomSwatch = (k) => `<i style="background:var(--room-${ROOMS.indexOf(k) + 1})"></i>`;

// Feedback in linea sul bottone (nessuna notifica a comparsa)
const flash = (btn, text, ms = 1600) => {
    if (!btn) return;
    const old = btn.dataset.label || btn.innerHTML;
    btn.dataset.label = old;
    btn.innerHTML = text;
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = old; btn.disabled = false; delete btn.dataset.label; }, ms);
};

// ==========================================
// Navigazione
// ==========================================
const VIEW_TITLES = { overview: 'Overview', seasons: 'Seasons', rooms: 'Rooms', climate: 'Climate', readings: 'Readings', report: 'Report' };
const showView = (view) => {
    if (!VIEW_TITLES[view]) view = 'overview';
    state.view = view;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
    $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $('#page-title').textContent = VIEW_TITLES[view];
    document.title = `${VIEW_TITLES[view]} · Heat Ledger`;
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    window.scrollTo({ top: 0 });
};
$$('[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
// "#new" apre subito l'inserimento (scorciatoia dalla home del telefono e dai promemoria)
const routeHash = () => {
    const h = location.hash.slice(1);
    if (h === 'new') {
        showView('overview');
        if (state.model && !$('#sheet-reading').open) openReadingSheet();
        return;
    }
    showView(h);
};
window.addEventListener('hashchange', routeHash);

// ==========================================
// Header & stato riscaldamento
// ==========================================
const renderHeader = () => {
    const t = A.today();
    $('#today-label').textContent = `${WEEKDAYS[t.getDay()]} ${t.getDate()} ${MONTHS_LONG[t.getMonth()]}`;
    const open = state.periods.find(A.isPeriodOpen);
    $('#status-pill').classList.toggle('on', !!open);
    $('#status-season').textContent = `Season ${A.seasonOf(t)}`;
    $('#status-heating').textContent = open ? `Heating on since ${dayMonth(open.start)}` : 'Heating off';
};

// ==========================================
// OVERVIEW
// ==========================================
const renderHero = () => {
    const { latest, pace, seasons, complete } = state.model;
    const el = $('#hero-card');
    if (!latest) { el.innerHTML = '<p class="muted">No readings yet. Add your first reading to get started.</p>'; return; }

    let badge, sub, cards = [], note = '';
    if (latest.complete) {
        const others = complete.filter(s => s !== latest);
        const avg = others.length ? d3.mean(others, s => s.final) : null;
        const rank = others.filter(s => s.final < latest.final).length + 1;
        badge = '<span class="badge">Complete</span>';
        sub = `${fullDate(latest.firstDate)} → ${fullDate(latest.lastDate)} · ${latest.heatingDays} heating days`;
        if (avg) cards.push({ v: signed(latest.final / avg - 1), cls: latest.final > avg ? 'up' : 'down', l: `vs. the average of ${others.length} other seasons` });
        if (latest.adjusted && others.some(s => s.adjusted)) {
            const avgAdj = d3.mean(others.filter(s => s.adjusted), s => s.adjusted);
            cards.push({ v: signed(latest.adjusted / avgAdj - 1), cls: latest.adjusted > avgAdj ? 'up' : 'down', l: 'after adjusting for how cold it was' });
        }
        cards.push({ v: ordinal(rank), cls: '', l: `lowest of ${complete.length} complete seasons` });
    } else {
        badge = latest.stale ? '<span class="badge">Readings paused</span>' : '<span class="badge live">● In progress</span>';
        sub = latest.stale
            ? `Last reading ${fullDate(latest.lastDate)} · ${latest.heatingDays} heating days covered`
            : `Through ${fullDate(latest.lastDate)} · ${latest.heatingDays} heating days so far`;
        if (pace?.delta != null) {
            cards.push({ v: signed(pace.delta), cls: pace.delta > 0 ? 'up' : 'down', l: `vs. the average season by ${dayMonth(latest.lastDate)}` });
            cards.push({ v: `${ordinal(pace.rank + 1)}`, cls: '', l: `lowest of ${pace.count + 1} seasons at this date` });
        }
        if (pace?.projection && !latest.stale) {
            cards.push({ v: `≈ ${fmt(pace.projection.mid)}`, cls: '', l: `projected total (${fmt(pace.projection.low)}–${fmt(pace.projection.high)})` });
        }
        if (latest.stale) {
            const open = latest.periods.some(p => !p.end);
            note = `No readings since ${fullDate(latest.lastDate)}${open ? ', and the heating period has no switch-off date' : ''}. Add the missing readings or close the period in <a href="#readings">Readings</a> — until then this season is treated as partial.`;
        }
    }
    const curSeason = A.seasonOf(A.today());
    if (latest.key !== curSeason && !seasons.some(s => s.key === curSeason)) {
        note = note || `Season ${curSeason} has no readings yet.`;
    }

    el.innerHTML = `
        <div class="hero-label">Season ${latest.key} ${badge}</div>
        <div class="hero-figure">${fmt(latest.final)}<small>units${latest.complete ? '' : ' so far'}</small></div>
        <div class="hero-sub">${sub}</div>
        ${cards.length ? `<div class="hero-delta">${cards.map(c => `<div class="delta-card"><div class="v ${c.cls}">${c.v}</div><div class="l">${c.l}</div></div>`).join('')}</div>` : ''}
        ${note ? `<div class="hero-note"><span>${note}</span></div>` : ''}`;
};

const renderNextCard = () => {
    const el = $('#next-card');
    const nm = A.nextMeasure(state.periods);
    const open = state.periods.find(A.isPeriodOpen);
    const latest = state.model.latest;
    const t = A.today();

    if (!nm || !open) {
        el.innerHTML = `
            <div class="next-top"><div><h3 class="next-title">Heating is off</h3>
            <div class="next-when">No readings scheduled</div></div></div>
            <div class="offseason">
                <p>When the heating comes back on, log the date: readings are then scheduled every other Sunday until it goes off again.</p>
                <div class="btn-row">
                    <button class="btn btn-accent" id="btn-heat-on">Heating on today</button>
                    <a class="link-btn" href="#readings">Pick another date</a>
                </div>
            </div>`;
        $('#btn-heat-on').addEventListener('click', async () => {
            state.periods.push({ start: A.ymd(t), end: null });
            await persist();
            renderAll();
            if (confirm('Heating on. Add the reading reminders (every other Sunday) to your calendar?')) downloadICS();
        });
        return;
    }

    const d = nm.date;
    const when = nm.daysUntil === 0 ? 'Today' : nm.daysUntil === 1 ? 'Tomorrow' : `${WEEKDAYS[d.getDay()]} · in ${nm.daysUntil} days`;
    const curKey = A.seasonOf(t);
    const last = state.readings.filter(r => A.readingSeason(r) === curKey).slice(-1)[0];
    el.innerHTML = `
        <div class="next-top">
            <div><h3 class="next-title">Next reading</h3><div class="next-when">${when}</div></div>
            <div class="cal-badge"><span class="m">${MONTHS_LONG[d.getMonth()].slice(0, 3)}</span><span class="d">${d.getDate()}</span></div>
        </div>
        <div class="quick-grid">
            ${ROOMS.map(k => `<label class="quick-field"><span>${roomSwatch(k)}${ROOM_LABELS[k]}</span>
                <input type="number" inputmode="decimal" min="0" step="1" data-room="${k}" placeholder="${last ? last[k] : 0}"></label>`).join('')}
        </div>
        <div class="next-actions">
            <span class="muted" style="font-size:12.5px">Saves as today, ${dayMonth(A.ymd(t))} · season ${curKey}</span>
            <div class="btn-row">
                <button class="link-btn" id="btn-ics-next" style="font-size:13px">Add reminders</button>
                <button class="link-btn" id="btn-heat-off" style="font-size:13px">Heating off</button>
                <button class="btn btn-primary" id="btn-quick-save">Save</button>
            </div>
        </div>`;
    $('#btn-quick-save').addEventListener('click', async (e) => {
        const inputs = $$('input[data-room]', el);
        if (!inputs.some(i => i.value !== '')) { inputs[0].focus(); return; }
        const r = { data: A.ymd(t), stagione: curKey };
        inputs.forEach(i => r[i.dataset.room] = i.value === '' ? (last ? +last[i.dataset.room] : 0) : +i.value);
        upsertReading(r);
        await persist();
        flash(e.currentTarget, 'Saved ✓');
        setTimeout(renderAll, 700);
    });
    $('#btn-ics-next').addEventListener('click', (e) => downloadICS(e.currentTarget));
    $('#btn-heat-off').addEventListener('click', async () => {
        if (!confirm(`Record the heating as switched off today (${dayMonth(A.ymd(t))})?`)) return;
        open.end = A.ymd(t);
        await persist();
        renderAll();
    });
};

const renderRace = () => {
    const { seasons, latest, pace } = state.model;
    if (!latest) return;
    let headline;
    if (!latest.complete && pace?.delta != null) {
        const dir = pace.delta < 0 ? 'below' : 'above';
        headline = latest.stale
            ? `${latest.key} was running ${pctAbs(pace.delta)} ${dir} the average winter when readings stopped`
            : `${latest.key} is running ${pctAbs(pace.delta)} ${dir} the average winter`;
    } else if (latest.complete) {
        const others = state.model.complete.filter(s => s !== latest);
        const avg = d3.mean(others, s => s.final);
        headline = avg ? `${latest.key} finished ${pctAbs(latest.final / avg - 1)} ${latest.final < avg ? 'below' : 'above'} the average season` : `Season ${latest.key}`;
    } else headline = `Season ${latest.key} so far`;
    $('#race-headline').textContent = headline;
    $('#race-key-latest').textContent = `${latest.key}${latest.complete ? '' : ' (latest)'}`;
    $('#race-key-proj').hidden = !(pace?.projection && !latest.stale);
    C.seasonRace($('#chart-race'), { seasons, latest, pace });
};

const renderTiles = () => {
    const { seasons, latest, complete } = state.model;
    const el = $('#tiles');
    if (!latest) { el.innerHTML = ''; return; }
    const pts = latest.points;
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const n = prev ? A.daysBetween(prev.date, last.date) : 0;
    const rates = pts.slice(1).map((p, i) => { const dd = A.daysBetween(pts[i].date, p.date); return dd > 0 ? (p.total - pts[i].total) / dd : null; });
    const lastRate = rates.length ? rates[rates.length - 1] : null;
    const peakRate = d3.max(rates);
    const idx = seasons.indexOf(latest);
    const avgPer = d3.mean(complete.filter(s => s.perHdd && s !== latest), s => s.perHdd);

    const tiles = [
        {
            label: 'Last reading', value: fmt(last.total), unit: 'units',
            sub: prev ? `${dayMonth(last.date)} · +${fmt(last.total - prev.total)} in ${n} days` : dayMonth(last.date),
            spark: pts.map(p => p.total), hero: pts.length - 1
        },
        {
            label: 'Daily rate', value: lastRate == null ? '–' : fmt1(lastRate), unit: 'units/day',
            sub: lastRate == null ? '' : `Season peak ${fmt1(peakRate)} / day`,
            spark: rates, hero: rates.length - 1
        },
        {
            label: 'Heating days', value: latest.heatingDays, unit: 'days',
            sub: latest.heatingStart ? `On since ${dayMonth(latest.heatingStart)}${latest.heatingEnd ? ` · off ${dayMonth(latest.heatingEnd)}` : ''}` : 'No heating period logged',
            spark: seasons.map(s => s.heatingDays), hero: idx
        },
        {
            label: 'Efficiency', value: latest.perHdd ? fmt2(latest.perHdd) : '–', unit: 'units/°C·day',
            sub: latest.perHdd && avgPer && !latest.complete
                ? `Season to date · full-season avg ${fmt2(avgPer)}`
                : latest.perHdd && avgPer
                ? `<span class="${latest.perHdd > avgPer ? 'up' : 'down'}">${signed(latest.perHdd / avgPer - 1)}</span> vs. average · lower is better`
                : (state.weather ? 'Not enough data' : 'Loading weather…'),
            spark: seasons.map(s => s.perHdd), hero: idx
        }
    ];
    el.innerHTML = tiles.map((t, i) => `<article class="card tile">
        <span class="tile-label">${t.label}</span>
        <span class="tile-value">${t.value}<small>${t.unit}</small></span>
        <span class="tile-sub">${t.sub}</span>
        <div class="tile-spark" data-i="${i}"></div></article>`).join('');
    tiles.forEach((t, i) => C.sparkline($(`.tile-spark[data-i="${i}"]`, el), { values: t.spark, heroIndex: t.hero }));
};

const renderSeasonBars = () => {
    const { seasons, complete, latestComplete } = state.model;
    const mode = state.barsMode;
    let headline = '–';
    if (mode === 'measured' && complete.length > 1) {
        const hi = complete.reduce((a, b) => a.final > b.final ? a : b);
        const lo = complete.reduce((a, b) => a.final < b.final ? a : b);
        headline = `${lo.key} used ${pctAbs(1 - lo.final / hi.final)} less heat than ${hi.key}`;
    } else if (mode === 'adjusted') {
        const adj = complete.filter(s => s.adjusted);
        if (adj.length > 1) {
            const best = adj.reduce((a, b) => a.adjusted < b.adjusted ? a : b);
            headline = `Adjusted for weather, ${best.key} was the thriftiest winter`;
        } else headline = 'Waiting for weather data…';
    }
    $('#bars-headline').textContent = headline;
    C.seasonBars($('#chart-bars'), { seasons, latestComplete, mode });
};
$$('#seg-bars button').forEach(b => b.addEventListener('click', () => {
    state.barsMode = b.dataset.mode;
    $$('#seg-bars button').forEach(x => x.classList.toggle('active', x === b));
    renderSeasonBars();
}));

const renderRoomList = () => {
    const { latest } = state.model;
    const el = $('#room-list');
    if (!latest || !latest.final) { el.innerHTML = ''; return; }
    const rows = ROOMS.map(k => ({ k, v: latest.finalRooms[k], share: latest.finalRooms[k] / latest.final }))
        .sort((a, b) => b.v - a.v);
    const top = rows[0];
    $('#rooms-mini-headline').textContent = `The ${ROOM_LABELS[top.k].toLowerCase()} takes ${pctAbs(top.share)} of the heat in ${latest.key}`;
    el.innerHTML = rows.map(r => `<div class="room-row">
        <span class="name">${roomSwatch(r.k)}${ROOM_LABELS[r.k]}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(r.v / top.v * 100).toFixed(1)}%;background:var(--room-${ROOMS.indexOf(r.k) + 1})"></div></div>
        <span class="val">${fmt(r.v)}<small>${Math.round(r.share * 100)}%</small></span></div>`).join('')
        + `<p class="source" style="margin:4px 0 0">${latest.complete ? 'Full season' : `Season so far, through ${dayMonth(latest.lastDate)}`}. Details in <a class="link-btn" style="font-size:12px" href="#rooms">Rooms</a>.</p>`;
};

// ==========================================
// SEASONS
// ==========================================
const renderSeasons = () => {
    const { seasons, complete, latestComplete, latest } = state.model;
    const adj = complete.filter(s => s.adjusted);
    if (adj.length > 1) {
        const best = adj.reduce((a, b) => a.adjusted < b.adjusted ? a : b);
        const worst = adj.reduce((a, b) => a.adjusted > b.adjusted ? a : b);
        $('#db-headline').textContent = `Adjusted for the weather, ${best.key} was the most efficient winter — and ${worst.key} the least`;
    } else $('#db-headline').textContent = state.weather ? 'Not enough complete seasons yet' : 'Loading weather data…';
    C.dumbbell($('#chart-dumbbell'), { seasons });

    // Freddo vs consumo
    const hddPts = complete.filter(s => s.hdd).map(s => ({ key: s.key, hdd: s.hdd, total: s.final, perHdd: s.perHdd }));
    if (hddPts.length >= 3) {
        const fit = A.linearFit(hddPts, 'hdd', 'total');
        $('#hdd-headline').textContent = fit && fit.r2 >= 0.5
            ? 'Colder winters, bigger totals'
            : 'The cold explains only part of the gap between winters';
        C.labeledScatter($('#chart-hdd'), {
            points: hddPts, xKey: 'hdd', yKey: 'total', label: p => p.key, hero: p => p.key === latestComplete?.key,
            xLabel: 'Degree-days (colder)', yLabel: 'units', height: 320,
            tipHtml: p => `<div class="tip-title">Season ${p.key}</div>
                <div class="tip-row"><span>Degree-days</span><b>${fmt(p.hdd)}</b></div>
                <div class="tip-row"><span>Units</span><b>${fmt(p.total)}</b></div>
                <div class="tip-row is-hero"><span>Per degree-day</span><b>${fmt2(p.perHdd)}</b></div>`
        });
    } else $('#chart-hdd').innerHTML = `<p class="viz-empty">${state.weather ? 'Needs at least three complete seasons.' : 'Loading weather data…'}</p>`;

    // Gantt
    const starts = seasons.filter(s => s.heatingStart).map(s => A.dayOfSeason(s.heatingStart, s.key));
    if (starts.length) {
        const avgStart = Math.round(d3.mean(starts));
        const ref = A.addDays(A.seasonStart('20/21'), avgStart);
        const lens = complete.filter(s => s.periods.length).map(s => s.periods.reduce((t, p) => t + A.daysBetween(p.start, A.periodEnd(p)) + 1, 0));
        const third = ref.getDate() <= 10 ? 'early' : ref.getDate() <= 20 ? 'mid' : 'late';
        $('#gantt-headline').textContent = `The heating usually goes on in ${third}-${MONTHS_LONG[ref.getMonth()]} and runs about ${Math.round(d3.mean(lens) / 30.4)} months`;
    }
    C.heatingGantt($('#chart-gantt'), { seasons, latestKey: latest?.key });

    // Tabella
    const avgAdj = d3.mean(adj, s => s.adjusted);
    $('#season-table').innerHTML = `<thead><tr><th>Season</th><th>Heating on</th><th>Off</th><th>Days</th><th>Readings</th><th>Units</th><th>Degree-days</th><th>Units / DD</th><th>Weather-adj.</th><th>vs. avg</th></tr></thead>
        <tbody>${seasons.slice().reverse().map(s => {
        const d = s.adjusted && avgAdj ? s.adjusted / avgAdj - 1 : null;
        return `<tr>
            <td class="strong">${s.key}${s.complete ? '' : ' <span class="badge">partial</span>'}</td>
            <td>${s.heatingStart ? dayMonth(s.heatingStart) : '–'}</td>
            <td>${s.heatingEnd ? dayMonth(s.heatingEnd) : (s.heatingStart ? '<span class="muted">open</span>' : '–')}</td>
            <td>${s.heatingDays || '–'}</td>
            <td>${s.points.length}</td>
            <td class="strong">${fmt(s.final)}</td>
            <td>${s.hdd ? fmt(s.hdd) : '–'}</td>
            <td>${s.perHdd ? fmt2(s.perHdd) : '–'}</td>
            <td>${s.adjusted ? fmt(s.adjusted) : '–'}</td>
            <td class="${d == null ? '' : d > 0 ? 'num-bad' : 'num-good'}">${d == null ? '–' : signed(d)}</td></tr>`;
    }).join('')}</tbody>`;
};

// ==========================================
// ROOMS
// ==========================================
const renderRooms = () => {
    const { seasons, complete, latestComplete, latest } = state.model;
    $('#room-key').innerHTML = ROOMS.map(k => `<span class="key-item"><i class="key-swatch" style="background:var(--room-${ROOMS.indexOf(k) + 1})"></i>${ROOM_LABELS[k]}</span>`).join('');
    C.roomShare($('#chart-share'), { seasons, latestKey: latest?.key });
    $('#multiples-dek').textContent = `Same scale in every panel. The coloured bar is ${latestComplete ? latestComplete.key : 'the latest complete season'}; change is against the average of earlier seasons.`;
    C.roomMultiples($('#multiples'), { seasons, latestKey: latestComplete?.key });
    renderRoomSignatures();

    // Insight: quote che cambiano di più tra la prima e l'ultima stagione completa
    if (complete.length < 2) { $('#share-headline').textContent = 'Each room’s share of the heat'; $('#room-insights').innerHTML = ''; return; }
    const first = complete[0], lastC = latestComplete;
    const share = (s, k) => s.finalRooms[k] / s.final;
    const changes = ROOMS.map(k => ({ k, from: share(first, k), to: share(lastC, k), d: share(lastC, k) - share(first, k) }))
        .sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    const big = changes[0];
    $('#share-headline').textContent = `The ${ROOM_LABELS[big.k].toLowerCase()}’s share ${big.d < 0 ? 'fell' : 'rose'} from ${pctAbs(big.from)} to ${pctAbs(big.to)} between ${first.key} and ${lastC.key}`;

    const cv = ROOMS.map(k => {
        const v = complete.map(s => share(s, k));
        const m = d3.mean(v);
        return { k, cv: d3.deviation(v) / m, mean: m };
    }).sort((a, b) => a.cv - b.cv);
    const rise = changes.filter(c => c.d > 0).sort((a, b) => b.d - a.d)[0];
    const fall = changes.filter(c => c.d < 0).sort((a, b) => a.d - b.d)[0];
    const peak = ROOMS.map(k => {
        const best = complete.reduce((a, b) => a.finalRooms[k] > b.finalRooms[k] ? a : b);
        return { k, s: best, v: best.finalRooms[k] };
    }).sort((a, b) => b.v - a.v)[0];
    const items = [];
    if (fall) items.push(`<li><strong>${ROOM_LABELS[fall.k]}: ${pctAbs(fall.from)} → ${pctAbs(fall.to)}</strong>The biggest drop in share since ${first.key}, ${Math.round(Math.abs(fall.d) * 100)} points less of the total.</li>`);
    if (rise) items.push(`<li><strong>${ROOM_LABELS[rise.k]}: ${pctAbs(rise.from)} → ${pctAbs(rise.to)}</strong>The biggest gain in share since ${first.key}, ${Math.round(rise.d * 100)} points more.</li>`);
    items.push(`<li><strong>${ROOM_LABELS[cv[0].k]} is the steadiest</strong>Its share barely moves from season to season, averaging ${pctAbs(cv[0].mean)} of the total.</li>`);
    items.push(`<li><strong>Record: ${ROOM_LABELS[peak.k].toLowerCase()} in ${peak.s.key}</strong>${fmt(peak.v)} units, the most any room has used in a single season.</li>`);
    $('#room-insights').innerHTML = items.join('');
};

// Firma energetica per stanza
const renderRoomSignatures = () => {
    const { seasons, latestComplete } = state.model;
    const sig = A.signaturePoints(seasons, state.periods, state.weather);
    if (sig.length < 6) {
        $('#room-sig-headline').textContent = state.weather ? 'Not enough intervals yet' : 'Loading weather data…';
        $('#room-sig-grid').innerHTML = '';
        return;
    }
    const sigs = A.roomSignatures(sig);
    const keys = [...new Set(sig.map(p => p.season))].sort(A.compareSeasons);
    if (!state.roomSigSeason || !keys.includes(state.roomSigSeason)) {
        state.roomSigSeason = keys.includes(latestComplete?.key) ? latestComplete.key : keys[keys.length - 1];
    }
    $('#room-sig-seasons').innerHTML = keys.slice().reverse().map(k => `<button class="chip ${k === state.roomSigSeason ? 'active' : ''}" data-season="${k}">${k}</button>`).join('');
    $$('#room-sig-seasons .chip').forEach(b => b.addEventListener('click', () => { state.roomSigSeason = b.dataset.season; renderRoomSignatures(); }));

    // Titolo: la stanza la cui sensibilità è cambiata di più tra le prime e le ultime stagioni
    const change = ROOMS.map(k => {
        const v = sigs[k].bySeason.filter(b => b.fit).map(b => ({ key: b.key, s: -b.fit.slope }));
        if (v.length < 4) return null;
        const early = d3.mean(v.slice(0, 3), d => d.s), late = d3.mean(v.slice(-2), d => d.s);
        return { k, early, late, ratio: late / early, from: v[0].key, to: v[v.length - 1].key };
    }).filter(Boolean).sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))[0];
    const warmest = ROOMS.map(k => ({ k, zero: sigs[k].fit?.zero })).filter(d => d.zero != null).sort((a, b) => b.zero - a.zero)[0];
    $('#room-sig-headline').textContent = change && Math.abs(Math.log(change.ratio)) > 0.35
        ? `The ${ROOM_LABELS[change.k].toLowerCase()} reacts ${change.ratio < 1 ? `${Math.round((1 - change.ratio) * 100)}% less` : `${Math.round((change.ratio - 1) * 100)}% more`} to the cold than it used to`
        : `The ${ROOM_LABELS[warmest.k].toLowerCase()} keeps heating until ${fmt1(warmest.zero)} °C — later than any other room`;
    C.roomSignatureGrid($('#room-sig-grid'), { signatures: sigs, season: state.roomSigSeason });
};

// ==========================================
// CLIMATE
// ==========================================
const renderClimate = () => {
    const { seasons, temps } = state.model;
    const choices = seasons.filter(s => s.points.length > 2).slice().reverse();
    $('#climate-seasons').innerHTML = choices.map(s => `<button class="chip ${s.key === state.climateSeason ? 'active' : ''}" data-season="${s.key}">${s.key}</button>`).join('');
    $$('#climate-seasons .chip').forEach(b => b.addEventListener('click', () => { state.climateSeason = b.dataset.season; renderClimate(); }));

    const season = seasons.find(s => s.key === state.climateSeason);
    if (!season) return;
    const daily = A.dailyEstimate(season, state.periods, state.weather);
    const weeks = A.weeklyTotals(daily).filter(w => w.value > 0);
    if (weeks.length) {
        const peak = weeks.reduce((a, b) => a.value > b.value ? a : b);
        const coldest = weeks.filter(w => w.temp != null).reduce((a, b) => (!a || b.temp < a.temp) ? b : a, null);
        $('#climate-headline').textContent = coldest && coldest.week === peak.week
            ? `In ${season.key}, the coldest week was also the hungriest: ${fmt(peak.value)} units from ${dayMonth(peak.week)}`
            : `In ${season.key}, heat use peaked the week of ${dayMonth(peak.week)} at about ${fmt(peak.value)} units`;
    } else $('#climate-headline').textContent = `Season ${season.key}`;
    C.climatePanels($('#chart-climate'), { season, daily, temps });

    // Firma energetica
    const sig = A.signaturePoints(seasons, state.periods, state.weather);
    const fit = A.linearFit(sig, 'temp', 'rate');
    if (sig.length >= 3 && fit) {
        $('#sig-headline').textContent = `Every degree colder adds about ${fmt1(Math.abs(fit.slope))} units a day`;
        C.labeledScatter($('#chart-signature'), {
            points: sig, xKey: 'temp', yKey: 'rate', hero: p => p.season === season.key,
            xLabel: 'Average outdoor temperature, °C', yLabel: 'units/day', xFormat: d => `${d}°`, yFormat: fmt, height: 360,
            fitLabel: f => `R² ${f.r2.toFixed(2)}`,
            zeroNote: f => `Heating need ends ≈ ${fmt1(f.zero)} °C`,
            tipHtml: p => `<div class="tip-title">${dayMonth(p.from)} → ${dayMonth(p.to)} · ${p.season}</div>
                <div class="tip-row"><span>Avg temperature</span><b>${fmt1(p.temp)} °C</b></div>
                <div class="tip-row is-hero"><span>Heat per day</span><b>${fmt1(p.rate)} units</b></div>
                <div class="tip-row"><span>Interval</span><b>${p.days} days</b></div>`
        });
    } else {
        $('#sig-headline').textContent = state.weather ? 'Not enough intervals yet' : 'Loading weather data…';
        $('#chart-signature').innerHTML = '';
    }

    // Calendario
    const heavy = daily.reduce((a, b) => (!a || b.value > a.value) ? b : a, null);
    $('#cal-headline').textContent = heavy && heavy.value > 0
        ? `The heaviest day of ${season.key} was ${fullDate(heavy.date)}: about ${fmt1(heavy.value)} units${heavy.temp != null ? ` at ${fmt1(heavy.temp)} °C` : ''}`
        : `Season ${season.key}`;
    C.calendarHeat($('#chart-calendar'), { season, daily });
};

// ==========================================
// REPORT di stagione
// ==========================================
const renderReport = () => {
    const { seasons, complete, latestComplete, temps } = state.model;
    const choices = seasons.filter(s => s.points.length > 2);
    if (!state.reportSeason || !choices.some(s => s.key === state.reportSeason)) state.reportSeason = (latestComplete || choices[choices.length - 1])?.key;
    $('#report-seasons').innerHTML = choices.slice().reverse().map(s => `<button class="chip ${s.key === state.reportSeason ? 'active' : ''}" data-season="${s.key}">${s.key}</button>`).join('');
    $$('#report-seasons .chip').forEach(b => b.addEventListener('click', () => { state.reportSeason = b.dataset.season; renderReport(); }));

    const S = seasons.find(s => s.key === state.reportSeason);
    const el = $('#report');
    if (!S) { el.innerHTML = '<p class="muted">Not enough readings yet.</p>'; return; }

    const others = complete.filter(s => s !== S);
    const prev = complete.filter(s => A.compareSeasons(s.key, S.key) < 0).pop() || null;
    const mean = (arr, f) => arr.length ? d3.mean(arr, f) : null;
    const avgFinal = mean(others, s => s.final);
    const avgHdd = mean(others.filter(s => s.hdd), s => s.hdd);
    const avgAdj = mean(others.filter(s => s.adjusted), s => s.adjusted);
    const pace = S.complete ? null : A.paceVsAverage(seasons, S);
    const rank = complete.slice().sort((a, b) => a.final - b.final).indexOf(S) + 1;
    const daily = A.dailyEstimate(S, state.periods, state.weather);
    const weeks = A.weeklyTotals(daily).filter(w => w.value > 0);
    const peakWeek = weeks.length ? weeks.reduce((a, b) => a.value > b.value ? a : b) : null;
    const peakDay = daily.length ? daily.reduce((a, b) => a.value > b.value ? a : b) : null;
    // Giorno più freddo durante il riscaldamento
    let coldest = null;
    S.periods.forEach(p => {
        for (let d = A.parseYMD(p.start); d <= A.periodEnd(p); d = A.addDays(d, 1)) {
            const t = temps.get(A.ymd(d));
            if (t != null && (!coldest || t < coldest.t)) coldest = { date: A.ymd(d), t };
        }
    });
    const gaps = S.points.slice(1).map((p, i) => ({ n: A.daysBetween(S.points[i].date, p.date), from: S.points[i].date, to: p.date }));
    const longest = gaps.length ? gaps.reduce((a, b) => a.n > b.n ? a : b) : null;
    const usualStart = mean(others.filter(s => s.heatingStart), s => A.dayOfSeason(s.heatingStart, s.key));
    const startShift = S.heatingStart && usualStart != null ? Math.round(A.dayOfSeason(S.heatingStart, S.key) - usualStart) : null;
    const share = (s, k) => s.finalRooms[k] / s.final;
    const topRoom = ROOMS.slice().sort((a, b) => S.finalRooms[b] - S.finalRooms[a])[0];
    const shift = prev ? ROOMS.map(k => ({ k, from: share(prev, k), to: share(S, k) })).sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))[0] : null;
    const sigs = A.roomSignatures(A.signaturePoints(seasons, state.periods, state.weather));
    const sensitive = ROOMS.map(k => ({ k, fit: sigs[k].bySeason.find(b => b.key === S.key)?.fit })).filter(d => d.fit)
        .sort((a, b) => a.fit.slope - b.fit.slope)[0];
    const rel = (v, avg) => v != null && avg ? v / avg - 1 : null;
    const word = (d, lo, hi) => d < 0 ? lo : hi;

    // ---------- Testo ----------
    const dMeasured = rel(S.final, avgFinal), dHdd = rel(S.hdd, avgHdd), dAdj = rel(S.adjusted, avgAdj);
    let headline, dek;
    if (!S.complete && pace?.delta != null) {
        headline = `${S.key}: ${pctAbs(pace.delta)} ${word(pace.delta, 'below', 'above')} the average pace`;
        dek = `${fmt(S.final)} units through ${fullDate(S.lastDate)}. A partial season, compared with the others at the same date.`;
    } else if (dAdj != null && dMeasured != null && Math.sign(dAdj) !== Math.sign(dMeasured)) {
        headline = dMeasured < 0 ? `${S.key}: a cheaper winter, thanks to the weather` : `${S.key}: a costlier winter, blame the cold`;
        dek = `${fmt(S.final)} units, ${pctAbs(dMeasured)} ${word(dMeasured, 'below', 'above')} average — but ${pctAbs(dAdj)} ${word(dAdj, 'below', 'above')} once the weather is taken into account.`;
    } else if (dMeasured != null) {
        headline = `${S.key}: ${pctAbs(dMeasured)} ${word(dMeasured, 'less', 'more')} heat than the average winter`;
        dek = `${fmt(S.final)} units over ${S.heatingDays} heating days${dAdj != null ? `, ${pctAbs(dAdj)} ${word(dAdj, 'below', 'above')} average after adjusting for the weather` : ''}.`;
    } else {
        headline = `Season ${S.key}`;
        dek = `${fmt(S.final)} units over ${S.heatingDays} heating days.`;
    }

    const paras = [];
    if (S.complete && avgFinal) {
        paras.push(`The household used <b>${fmt(S.final)} units</b> of heat in ${S.key}, over ${S.heatingDays} heating days. That is ${pctAbs(dMeasured)} ${word(dMeasured, 'less', 'more')} than the average of the other ${others.length} complete seasons, the ${ordinal(rank)} lowest of ${complete.length}.`);
    } else if (pace) {
        paras.push(`By ${fullDate(S.lastDate)} the meters had recorded <b>${fmt(S.final)} units</b>, ${pctAbs(pace.delta)} ${word(pace.delta, 'below', 'above')} where the average season stood on the same date.${S.stale ? ' Readings stopped there, so the season is incomplete.' : ''}`);
    }
    if (S.hdd && avgHdd) {
        // Fascia neutra ±3%: sotto questa soglia meteo e abitudini "non contano"
        const NEUTRAL = 0.03;
        const weather = Math.abs(dHdd) < NEUTRAL ? 0 : Math.sign(dHdd);   // -1 mite, +1 freddo
        const habits = dAdj == null || Math.abs(dAdj) < NEUTRAL ? 0 : Math.sign(dAdj); // -1 efficiente
        let p = weather === 0
            ? `Temperatures were <b>typical</b> for the season: ${fmt(S.hdd)} degree-days, within ${Math.max(1, Math.round(Math.abs(dHdd) * 100))}% of the average`
            : `It was a <b>${weather < 0 ? 'milder' : 'colder'}</b> winter than usual: ${fmt(S.hdd)} degree-days, ${pctAbs(dHdd)} ${word(dHdd, 'below', 'above')} the average`;
        p += coldest ? `. The coldest day was ${fullDate(coldest.date)}, with a mean of ${fmt1(coldest.t)} °C.` : '.';
        if (S.adjusted && avgAdj) {
            p += ` Rescaled to an average winter, the season comes to <b>${fmt(S.adjusted)} units</b> (${fmt2(S.perHdd)} per degree-day), ${habits === 0 ? 'in line with' : `${pctAbs(dAdj)} ${word(dAdj, 'below', 'above')}`} the weather-adjusted average. `;
            const verdicts = {
                '-1,-1': 'Both the mild weather and the household helped.',
                '-1,0': 'The saving came from the mild weather; the household ran the heating as usual.',
                '-1,1': 'In other words, the mild weather hid a less efficient season.',
                '0,-1': 'With ordinary weather, the saving came from the household.',
                '0,0': 'An ordinary winter, run in the ordinary way.',
                '0,1': 'With ordinary weather, the extra use came from the household.',
                '1,-1': 'The cold explains the higher demand: the house was actually run more efficiently than usual.',
                '1,0': 'The cold explains the difference; efficiency was as usual.',
                '1,1': 'It was not just the cold: use was higher than the weather explains.'
            };
            p += verdicts[`${weather},${habits}`];
        }
        paras.push(p);
    }
    if (S.heatingStart) {
        let p = `The heating went on on <b>${fullDate(S.heatingStart)}</b>${startShift != null && Math.abs(startShift) >= 3 ? `, ${Math.abs(startShift)} days ${word(startShift, 'earlier', 'later')} than usual` : ', about when it usually does'}${S.heatingEnd ? `, and off on ${fullDate(S.heatingEnd)}` : ''}.`;
        if (peakWeek) p += ` Use peaked in the week of ${fullDate(peakWeek.week)}, at about ${fmt(peakWeek.value)} units${peakWeek.temp != null ? ` with an average of ${fmt1(peakWeek.temp)} °C outside` : ''}.`;
        if (peakDay && peakDay.value > 0) p += ` The heaviest single day was ${fullDate(peakDay.date)}: roughly ${fmt1(peakDay.value)} units.`;
        paras.push(p);
    }
    {
        let p = `The <b>${ROOM_LABELS[topRoom].toLowerCase()}</b> took the largest share of the heat, ${pctAbs(share(S, topRoom))}.`;
        if (shift && Math.abs(shift.to - shift.from) >= 0.02) p += ` Compared with ${prev.key}, the biggest change was the ${ROOM_LABELS[shift.k].toLowerCase()}, from ${pctAbs(shift.from)} to ${pctAbs(shift.to)} of the total.`;
        if (sensitive) p += ` The room most sensitive to the cold was the ${ROOM_LABELS[sensitive.k].toLowerCase()}: about ${fmt2(-sensitive.fit.slope)} extra units a day for every degree colder.`;
        paras.push(p);
    }
    if (gaps.length) {
        paras.push(`${S.points.length} readings were taken, on average every ${Math.round(d3.mean(gaps, g => g.n))} days${longest && longest.n > 21 ? `; the longest gap was ${longest.n} days, from ${fullDate(longest.from)} to ${fullDate(longest.to)}` : ''}.`);
    }

    // ---------- Tabella di confronto ----------
    const rows = [
        ['Units', S.final, prev?.final, avgFinal, fmt, true],
        ['Heating days', S.heatingDays, prev?.heatingDays, mean(others, s => s.heatingDays), fmt, null],
        ['Degree-days (cold)', S.hdd, prev?.hdd, avgHdd, fmt, null],
        ['Units per degree-day', S.perHdd, prev?.perHdd, mean(others.filter(s => s.perHdd), s => s.perHdd), fmt2, true],
        ['Weather-adjusted units', S.adjusted, prev?.adjusted, avgAdj, fmt, true],
        ...ROOMS.map(k => [ROOM_LABELS[k], S.finalRooms[k], prev?.finalRooms[k], mean(others, s => s.finalRooms[k]), fmt, true])
    ];
    const cell = (v, f) => v == null ? '–' : f(v);
    const deltaCell = (v, avg, lowerIsBetter) => {
        const d = rel(v, avg);
        if (d == null) return '<td>–</td>';
        const cls = lowerIsBetter == null ? '' : (d > 0) === lowerIsBetter ? 'num-bad' : 'num-good';
        return `<td class="${cls}">${signed(d)}</td>`;
    };

    const fig = [
        { label: S.complete ? 'Units' : 'Units so far', value: fmt(S.final) },
        { label: 'vs. average', value: dMeasured != null ? signed(dMeasured) : (pace ? signed(pace.delta) : '–') },
        { label: 'Weather-adjusted', value: dAdj != null ? signed(dAdj) : '–' },
        { label: 'Heating days', value: S.heatingDays },
        { label: 'Degree-days', value: S.hdd ? fmt(S.hdd) : '–' }
    ];

    el.innerHTML = `
        <header class="report-head">
            <p class="kicker">Season report · ${A.seasonStartYear(S.key)}–${A.seasonStartYear(S.key) + 1}</p>
            <h2 class="report-title">${esc(headline)}</h2>
            <p class="report-dek">${esc(dek)}</p>
            <p class="report-byline">Heat Ledger · ${fullDate(S.firstDate)} → ${fullDate(S.lastDate)} · ${S.points.length} readings${S.complete ? '' : ' · partial season'}</p>
        </header>
        <div class="report-figures">${fig.map(f => `<div><span class="v">${f.value}</span><span class="l">${f.label}</span></div>`).join('')}</div>
        <div class="report-body">
            ${paras[0] ? `<p>${paras[0]}</p>` : ''}
            <figure class="report-fig"><figcaption><b>The season race.</b> Cumulative units since the start of each season; ${S.key} in colour.</figcaption><div class="chart" id="report-race"></div></figure>
            ${paras[1] ? `<p>${paras[1]}</p>` : ''}
            ${paras[2] ? `<p>${paras[2]}</p>` : ''}
            <figure class="report-fig"><figcaption><b>Heat and cold, week by week.</b> Estimated units per week (top) and daily mean outdoor temperature (bottom).</figcaption><div class="chart" id="report-climate"></div></figure>
            ${paras[3] ? `<p>${paras[3]}</p>` : ''}
            <figure class="report-fig"><figcaption><b>Share of heat by room</b>${prev ? `, ${prev.key} vs. ${S.key}` : ''}.</figcaption><div class="chart" id="report-share"></div></figure>
            ${paras[4] ? `<p>${paras[4]}</p>` : ''}
            <h3 class="report-h3">The numbers</h3>
            <div class="table-wrap"><table class="data-table">
                <thead><tr><th></th><th>${S.key}</th><th>${prev ? prev.key : 'Previous'}</th><th>Change</th><th>Avg. other seasons</th><th>vs. avg</th></tr></thead>
                <tbody>${rows.map(([label, v, pv, avg, f, lower]) => `<tr><td>${label}</td><td class="strong">${cell(v, f)}</td><td>${cell(pv, f)}</td>${deltaCell(v, pv, lower)}<td>${cell(avg, f)}</td>${deltaCell(v, avg, lower)}</tr>`).join('')}</tbody>
            </table></div>
            <p class="report-method">Method: heat cost allocator readings summed over five rooms. Degree-days = sum over heating days of max(0, 20 °C − daily mean temperature), from the Open-Meteo archive. Weather-adjusted units = units × average degree-days ÷ this season’s degree-days. Weekly and daily figures spread each interval’s use across its days in proportion to degree-days.${S.complete ? '' : ' Partial seasons are compared with others at the same date.'}</p>
        </div>`;

    C.seasonRace($('#report-race'), { seasons, latest: S, pace, height: 340 });
    C.climatePanels($('#report-climate'), { season: S, daily, temps });
    C.roomShare($('#report-share'), { seasons: [prev, S].filter(Boolean), latestKey: S.key });
};

// Stampa: sempre in tema chiaro, con i grafici ridisegnati
let themeBeforePrint = null;
window.addEventListener('beforeprint', () => {
    themeBeforePrint = document.documentElement.dataset.theme ?? null;
    document.documentElement.dataset.theme = 'light';
    C.redrawAll();
});
window.addEventListener('afterprint', () => {
    if (themeBeforePrint) document.documentElement.dataset.theme = themeBeforePrint;
    else delete document.documentElement.dataset.theme;
    C.redrawAll();
});
$('#btn-print').addEventListener('click', () => window.print());

// ==========================================
// Promemoria in calendario (.ics)
// ==========================================
// Un evento per ogni domenica di lettura (stesso UID → reimportando si aggiorna, non duplica)
const buildICS = () => {
    const dates = A.upcomingMeasures(state.periods, 20);
    if (!dates.length) return null;
    const appUrl = location.hostname.endsWith('github.io') || location.hostname === 'localhost'
        ? location.origin + location.pathname : PAGES_URL;
    const compact = (d) => A.ymd(d).replace(/-/g, '');
    const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const last = state.readings[state.readings.length - 1];
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Heat Ledger//Readings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'X-WR-CALNAME:Heat meter readings'
    ];
    dates.forEach(d => {
        lines.push('BEGIN:VEVENT',
            `UID:reading-${compact(d)}@heat-ledger`,
            `DTSTAMP:${now}`,
            `DTSTART;VALUE=DATE:${compact(d)}`,
            `DTEND;VALUE=DATE:${compact(A.addDays(d, 1))}`,
            'SUMMARY:🌡️ Read the heat meters',
            `DESCRIPTION:Read the five heat cost allocators (kitchen\\, living room\\, bedroom\\, kids' room\\, bathroom).${last ? `\\nLast total: ${A.total(last)} on ${fullDate(last.data)}.` : ''}\\n${appUrl}#new`,
            `URL:${appUrl}#new`,
            'TRANSP:TRANSPARENT',
            'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Read the heat meters', 'TRIGGER:PT9H', 'END:VALARM',
            'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    // Righe lunghe piegate a 74 caratteri, come richiede lo standard iCalendar
    const fold = (l) => l.length <= 74 ? l : l.match(/.{1,73}/gu).join('\r\n ');
    return { ics: lines.map(fold).join('\r\n'), count: dates.length, first: dates[0], last: dates[dates.length - 1] };
};

const downloadICS = (btn) => {
    const cal = buildICS();
    if (!cal) { if (btn) flash(btn, 'Turn the heating on first', 2200); return; }
    download('heat-meter-readings.ics', cal.ics, 'text/calendar');
    if (btn) flash(btn, `${cal.count} reminders ✓`, 2200);
};
$('#btn-ics-periods').addEventListener('click', (e) => downloadICS(e.currentTarget));

// ==========================================
// READINGS
// ==========================================
const renderPeriods = () => {
    const list = $('#period-list');
    const sorted = state.periods.map((p, i) => ({ p, i })).sort((a, b) => b.p.start.localeCompare(a.p.start));
    if (!sorted.length) { list.innerHTML = '<p class="muted">No heating periods yet.</p>'; return; }
    list.innerHTML = sorted.map(({ p, i }) => {
        const open = A.isPeriodOpen(p);
        const days = A.daysBetween(p.start, A.periodEnd(p)) + 1;
        return `<div class="period ${open ? 'open' : ''}" data-i="${i}">
            <span class="period-season">${A.seasonOf(p.start)}</span>
            <span class="period-dates">${fullDate(p.start)} → ${p.end ? fullDate(p.end) : (open ? 'on now' : 'off date missing')}
                <small>${days} days${!p.end && !open ? ' (capped)' : ''}</small></span>
            ${!p.end ? `<button class="link-btn" data-act="off">Set off date</button>` : ''}
            <span class="row-actions"><button class="del" data-act="del" aria-label="Delete period"><svg><use href="#i-trash"/></svg></button></span>
        </div>`;
    }).join('');
    $$('.period', list).forEach(row => {
        const p = state.periods[+row.dataset.i];
        row.querySelector('[data-act="del"]').addEventListener('click', async () => {
            if (!confirm(`Delete the heating period starting ${fullDate(p.start)}?`)) return;
            state.periods.splice(state.periods.indexOf(p), 1);
            if (state.firebaseOK) window.FirebaseService.deleteHeatingPeriod(p.start).catch(() => { });
            await persist();
            renderAll();
        });
        row.querySelector('[data-act="off"]')?.addEventListener('click', async () => {
            const suggestion = A.ymd(A.periodEnd(p));
            const v = prompt('Heating switched off on (YYYY-MM-DD):', suggestion);
            if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < p.start) return;
            p.end = v;
            await persist();
            renderAll();
        });
    });
};

$('#period-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const start = $('#period-start').value, end = $('#period-end').value || null;
    if (!start || (end && end < start)) return;
    state.periods.push({ start, end });
    $('#period-start').value = ''; $('#period-end').value = '';
    await persist();
    renderAll();
    flash(e.submitter, 'Added ✓');
});

const renderLog = () => {
    const { seasons, anomalies } = state.model;
    const chips = [{ key: 'all', label: 'All' }, ...seasons.slice().reverse().map(s => ({ key: s.key, label: s.key }))];
    $('#log-seasons').innerHTML = chips.map(c => `<button class="chip ${c.key === state.logSeason ? 'active' : ''}" data-season="${c.key}">${c.label}</button>`).join('');
    $$('#log-seasons .chip').forEach(b => b.addEventListener('click', () => { state.logSeason = b.dataset.season; renderLog(); }));

    const mode = state.logMode;
    const shown = seasons.slice().reverse().filter(s => state.logSeason === 'all' || s.key === state.logSeason);
    const cell = (v, cls = '') => `<td class="${v === 0 ? 'zero' : ''} ${cls}">${v == null ? '–' : (mode === 'rate' ? fmt1(v) : fmt(v))}</td>`;
    let body = '';
    shown.forEach(s => {
        body += `<tr class="group-row"><td colspan="10">Season ${s.key} · ${fmt(s.final)} units${s.complete ? '' : ' so far'}</td></tr>`;
        s.points.slice().reverse().forEach((p, ri, arr) => {
            const prev = arr[ri + 1];
            const n = prev ? A.daysBetween(prev.date, p.date) : null;
            const val = (k) => {
                const cur = k === 'total' ? p.total : p.rooms[k];
                if (mode === 'meter') return cur;
                if (!prev) return null;
                const pv = k === 'total' ? prev.total : prev.rooms[k];
                return mode === 'delta' ? cur - pv : (n ? (cur - pv) / n : null);
            };
            const flag = anomalies.get(p.date);
            const idx = state.readings.indexOf(p.raw);
            body += `<tr>
                <td>${fullDate(p.date)}${flag ? ` <span class="flag" title="${esc(flag)}">⚠︎</span>` : ''}</td>
                <td class="muted">${n == null ? '–' : `${n} d`}</td>
                ${ROOMS.map(k => cell(val(k))).join('')}
                ${cell(val('total'), 'strong')}
                <td><span class="row-actions">
                    <button data-act="edit" data-i="${idx}" aria-label="Edit reading"><svg><use href="#i-edit"/></svg></button>
                    <button class="del" data-act="del" data-i="${idx}" aria-label="Delete reading"><svg><use href="#i-trash"/></svg></button>
                </span></td></tr>`;
        });
    });
    $('#log-table').innerHTML = `<thead><tr><th>Date</th><th>Interval</th>${ROOMS.map(k => `<th>${ROOM_LABELS[k]}</th>`).join('')}<th>Total</th><th></th></tr></thead><tbody>${body}</tbody>`;
    $$('#log-table [data-act="edit"]').forEach(b => b.addEventListener('click', () => openReadingSheet(state.readings[+b.dataset.i])));
    $$('#log-table [data-act="del"]').forEach(b => b.addEventListener('click', async () => {
        const r = state.readings[+b.dataset.i];
        if (!r || !confirm(`Delete the reading of ${fullDate(r.data)}?`)) return;
        state.readings.splice(+b.dataset.i, 1);
        if (state.firebaseOK) window.FirebaseService.deleteLettura(r.data).catch(() => { });
        await persist();
        renderAll();
    }));
};
$$('#seg-log button').forEach(b => b.addEventListener('click', () => {
    state.logMode = b.dataset.mode;
    $$('#seg-log button').forEach(x => x.classList.toggle('active', x === b));
    renderLog();
}));

// ==========================================
// Sheet: nuova / modifica lettura
// ==========================================
let editing = null;
const sheet = $('#sheet-reading');

const upsertReading = (r, original = null) => {
    const n = normalizeReading(r);
    if (original) state.readings.splice(state.readings.indexOf(original), 1);
    const same = state.readings.findIndex(x => x.data === n.data);
    if (same >= 0) state.readings.splice(same, 1, n); else state.readings.push(n);
    sortReadings();
};

const openReadingSheet = (reading = null) => {
    editing = reading;
    $('#reading-title').textContent = reading ? 'Edit reading' : 'New reading';
    const date = reading ? reading.data : A.ymd(A.today());
    $('#reading-date').value = date;
    const seasonKeys = [...new Set([...state.model.seasons.map(s => s.key), A.seasonOf(date), A.seasonOf(A.today())])].sort(A.compareSeasons).reverse();
    $('#reading-season').innerHTML = seasonKeys.map(k => `<option value="${k}">${k}</option>`).join('');
    $('#reading-season').value = reading ? reading.stagione : A.seasonOf(date);
    $('#reading-rooms').innerHTML = ROOMS.map(k => `<label class="row-field room-field">
        <span class="label">${roomSwatch(k)}${ROOM_LABELS[k]}</span>
        <span class="inputs"><span class="delta" data-delta="${k}"></span>
        <input type="number" inputmode="decimal" min="0" step="any" data-room="${k}" value="${reading ? reading[k] : ''}" placeholder="0"></span></label>`).join('');
    $$('#reading-rooms input').forEach(i => i.addEventListener('input', updateReadingPreview));
    updateReadingPreview();
    sheet.showModal();
    setTimeout(() => $('#reading-rooms input')?.focus(), 50);
};

const draftReading = () => {
    const r = { data: $('#reading-date').value, stagione: $('#reading-season').value };
    $$('#reading-rooms input').forEach(i => r[i.dataset.room] = i.value === '' ? 0 : +i.value);
    return r;
};

const updateReadingPreview = () => {
    const r = draftReading();
    const others = state.readings.filter(x => x !== editing);
    const { prev, warnings } = A.validateReading(r, others);
    $('#reading-prev-note').textContent = prev
        ? `Previous reading in ${r.stagione}: ${fullDate(prev.data)} (${A.daysBetween(prev.data, r.data)} days earlier), total ${fmt(A.total(prev))}.`
        : `First reading of season ${r.stagione}.`;
    ROOMS.forEach(k => {
        const el = $(`#reading-rooms [data-delta="${k}"]`);
        const input = $(`#reading-rooms input[data-room="${k}"]`);
        if (!prev || input.value === '') { el.textContent = prev ? `prev ${prev[k]}` : ''; el.classList.remove('neg'); return; }
        const d = r[k] - prev[k];
        el.textContent = `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
        el.classList.toggle('neg', d < 0);
    });
    const tot = A.total(r);
    $('#reading-total').textContent = fmt(tot);
    $('#reading-total-delta').textContent = prev ? `${tot - A.total(prev) >= 0 ? '+' : '−'}${fmt(Math.abs(tot - A.total(prev)))} since previous` : '';
    $('#reading-warnings').innerHTML = warnings.map(w => `<li>${esc(w)}</li>`).join('');
};

$('#reading-season').addEventListener('change', () => updateReadingPreview());
$('#reading-date').addEventListener('change', () => {
    if (!editing && $('#reading-date').value) $('#reading-season').value = A.seasonOf($('#reading-date').value);
    updateReadingPreview();
});

$('#reading-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = draftReading();
    if (!r.data) return;
    upsertReading(r, editing);
    sheet.close();
    await persist();
    renderAll();
});
$$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
$$('dialog').forEach(d => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
$('#btn-new-reading').addEventListener('click', () => openReadingSheet());

// ==========================================
// Settings
// ==========================================
const applyTheme = () => {
    const t = state.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    $$('#seg-theme button').forEach(b => b.classList.toggle('active', b.dataset.theme === t));
    requestAnimationFrame(() => C.redrawAll());
};
$$('#seg-theme button').forEach(b => b.addEventListener('click', () => {
    state.theme = b.dataset.theme;
    store.set('theme', state.theme);
    applyTheme();
}));
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.theme === 'system') C.redrawAll(); });

const renderSettingsStatus = () => {
    const w = state.weather;
    $('#weather-status').textContent = w && w.time?.length
        ? `${fmt(w.time.length)} days, through ${fullDate(w.time[w.time.length - 1])}`
        : 'Not loaded (offline?)';
    $('#server-status').textContent = state.serverOK ? 'Connected · saving to letture.json' : 'Not available on this device';
    renderCloudStatus();
};

// ---------- Cloud (Firebase) ----------
const renderCloudStatus = () => {
    const el = $('#cloud-status');
    if (!el) return;
    const { status, message } = state.cloud;
    el.textContent = message || status;
    el.dataset.status = status;
    const user = FS()?.user();
    $('#cloud-signed-out').hidden = !!user;
    $('#cloud-signed-in').hidden = !user;
    if (user) {
        $('#cloud-email-label').textContent = user.email;
        $('#cloud-uid').textContent = user.uid;
    }
    // Pallino di stato nella sidebar
    $('#status-pill')?.classList.toggle('cloud-error', status === 'error');
};

$('#btn-cloud-signin').addEventListener('click', async (e) => {
    const email = $('#cloud-email').value.trim(), password = $('#cloud-password').value;
    if (!email || !password) return;
    const btn = e.currentTarget;
    btn.textContent = 'Signing in…';
    $('#cloud-error').textContent = '';
    try {
        await FS().signIn(email, password);
        $('#cloud-password').value = '';
        await reloadFromSources();
    } catch (err) {
        $('#cloud-error').textContent = FS().explain(err);
    } finally { btn.textContent = 'Sign in'; }
});
$('#btn-cloud-signout').addEventListener('click', async () => {
    await FS().signOut();
    state.firebaseOK = false;
    setCloud('signed-out', 'Not signed in');
});
$('#btn-cloud-sync').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.textContent = 'Syncing…';
    if (!state.firebaseOK) await loadCloud(null, null);
    await pushToCloud();
    btn.textContent = 'Sync now';
    renderAll();
});
$('#btn-copy-uid').addEventListener('click', (e) => {
    navigator.clipboard?.writeText($('#cloud-uid').textContent).then(() => flash(e.currentTarget, 'Copied ✓'));
});

let reloading = null;
const reloadFromSources = () => {
    if (reloading) return reloading;
    reloading = (async () => {
        state.serverOnly = null;
        await loadData();
        renderAll();
    })().finally(() => { reloading = null; });
    return reloading;
};

// Avviso: dati presenti solo sul server locale (es. inseriti dal telefono senza accesso al cloud)
const renderSyncNotice = () => {
    const el = $('#sync-notice');
    const diff = state.serverOnly;
    if (!diff) { el.hidden = true; return; }
    const n = diff.readings.length;
    el.hidden = false;
    el.innerHTML = `<div><strong>The local server and the cloud disagree.</strong>
        ${n ? `${n} reading${n > 1 ? 's' : ''} (${diff.readings.slice(0, 3).map(r => fullDate(r.data)).join(', ')}${n > 3 ? '…' : ''}) exist only on this computer or differ from the cloud.` : ''}
        ${diff.periods ? 'The heating periods differ too.' : ''}
        A backup of the server copy is kept either way.</div>
        <div class="btn-row"><button class="btn btn-primary" id="btn-merge-server">Add them to the cloud</button>
        <button class="btn btn-secondary" id="btn-keep-cloud">Keep the cloud version</button></div>`;
    $('#btn-merge-server').addEventListener('click', async () => {
        diff.readings.forEach(r => upsertReading(r));
        if (diff.periods) {
            const key = (p) => p.start;
            const have = new Set(state.periods.map(key));
            diff.periods.forEach(p => { if (!have.has(key(p))) state.periods.push(p); });
        }
        state.serverOnly = null;
        await persist();
        renderAll();
    });
    $('#btn-keep-cloud').addEventListener('click', async () => {
        state.serverOnly = null;
        await persist();
        renderAll();
    });
};

// ---------- Telefono ----------
const PAGES_URL = 'https://fedcom7.github.io/dashboard-contabilizzatori/';
const renderPhoneGrid = async () => {
    const grid = $('#phone-grid');
    const info = state.serverOK ? await fetch('/api/info').then(r => r.json()).catch(() => null) : null;
    state.lanUrls = info?.lanUrls || [];
    const online = location.hostname.endsWith('github.io') ? location.origin + location.pathname : PAGES_URL;
    const cards = [];
    if (state.lanUrls.length) cards.push({ title: 'At home · Wi-Fi', url: state.lanUrls[0], note: 'Saves to this computer’s server. Keep the server running.' });
    cards.push({ title: 'Anywhere · online', url: online, note: state.firebaseOK ? 'Uses Cloud sync.' : 'Needs Cloud sync to share data.' });
    grid.innerHTML = cards.map((c, i) => `<div class="phone-card"><div class="qr" id="qr-${i}"></div>
        <div><strong>${c.title}</strong><a class="link-btn" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url.replace(/^https?:\/\//, ''))}</a><p class="muted">${c.note}</p></div></div>`).join('');
    cards.forEach((c, i) => {
        if (typeof QRCode === 'undefined') return;
        new QRCode($(`#qr-${i}`), { text: c.url, width: 112, height: 112, colorDark: '#1d1d1f', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    });
};

// ---------- Backup ----------
const renderBackups = async () => {
    const list = $('#backup-list');
    if (!state.serverOK) { $('#backup-count').textContent = 'Only with the local server'; list.innerHTML = ''; return; }
    const backups = await fetch('/api/backups').then(r => r.json()).catch(() => []);
    $('#backup-count').textContent = backups.length ? `${backups.length} saved` : 'None yet — created on the next change';
    const label = (name) => {
        const m = name.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
        return m ? `${fullDate(`${m[1]}-${m[2]}-${m[3]}`)}, ${m[4]}:${m[5]} UTC` : name;
    };
    list.innerHTML = backups.slice(0, 6).map(b => `<div class="row-field"><span>${b.kind === 'letture' ? 'Readings' : 'Periods'} · ${label(b.name)}
        <small class="muted">${b.count ?? '?'} items</small></span><button type="button" class="link-btn" data-restore="${esc(b.name)}">Restore</button></div>`).join('');
    $$('[data-restore]', list).forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm(`Restore ${btn.dataset.restore}? The current data is backed up first.`)) return;
        const ok = await fetch('/api/backups/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: btn.dataset.restore }) }).then(r => r.ok).catch(() => false);
        if (!ok) { flash(btn, 'Failed'); return; }
        const [r, p] = await Promise.all([api.get('/api/letture'), api.get('/api/periods')]);
        if (r) state.readings = r.map(normalizeReading);
        if (p) state.periods = p.map(normalizePeriod);
        state.serverOnly = null;
        await persist(); // il ripristino vale anche per il cloud
        renderAll();
        renderBackups();
    }));
};

$('#btn-export-all').addEventListener('click', () => download(`heat-ledger-backup-${A.ymd(A.today())}.json`,
    JSON.stringify({ exportedAt: new Date().toISOString(), readings: state.readings, periods: state.periods, settings: state.settings }, null, 2), 'application/json'));

const openSettings = () => {
    $('#setting-lat').value = state.settings.lat;
    $('#setting-lng').value = state.settings.lng;
    renderSettingsStatus();
    renderPhoneGrid();
    renderBackups();
    $$('#seg-theme button').forEach(b => b.classList.toggle('active', b.dataset.theme === state.theme));
    $('#sheet-settings').showModal();
};
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-settings-m').addEventListener('click', openSettings);

$('#btn-weather-refresh').addEventListener('click', async (e) => {
    const lat = parseFloat($('#setting-lat').value), lng = parseFloat($('#setting-lng').value);
    if (isNaN(lat) || isNaN(lng)) return;
    state.settings = { lat, lng };
    store.set('settings', state.settings);
    const btn = e.currentTarget;
    btn.textContent = 'Loading…';
    await loadWeather(true);
    btn.textContent = 'Save & refresh';
    renderSettingsStatus();
    renderAll();
});

$('#btn-reset-cache').addEventListener('click', () => {
    if (!confirm('Clear this browser’s cached data? Data on the server is kept.')) return;
    try { localStorage.clear(); } catch { }
    location.reload();
});

const download = (name, content, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#btn-export-csv').addEventListener('click', () => {
    const head = ['data', 'stagione', ...ROOMS];
    download('letture.csv', [head.join(','), ...state.readings.map(r => head.map(h => r[h]).join(','))].join('\n'), 'text/csv');
});
$('#btn-export-json').addEventListener('click', () => download('letture.json', JSON.stringify(state.readings, null, 2), 'application/json'));
$('#btn-template').addEventListener('click', () => download('template_letture.csv', 'data,cucina,soggiorno,camera,cameretta,bagno,stagione\n2025-11-02,9,17,0,0,0,25/26', 'text/csv'));

// Import CSV / Excel
let pendingImport = [];
const parseImportDate = (s) => {
    s = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
    if (!m) return null;
    let [, a, b, y] = m.map(Number);
    if (y < 100) y += 2000;
    let day = a, month = b;           // default italiano: GG/MM
    if (b > 12 && a <= 12) { day = b; month = a; } // MM/GG (es. export americano)
    if (month > 12) return null;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};
const parseImport = (csv) => {
    const lines = csv.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];
    const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
    const head = lines[0].split(sep).map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    return lines.slice(1).map(line => {
        const v = line.split(sep).map(x => x.trim().replace(/^"|"$/g, ''));
        const o = {};
        head.forEach((h, i) => {
            if (h === 'data' || h === 'date') o.data = parseImportDate(v[i]);
            else if (h === 'stagione' || h === 'season') { if (/^\d{2}\/\d{2}$/.test(v[i])) o.stagione = v[i]; }
            else if (ROOMS.includes(h)) o[h] = parseFloat(String(v[i]).replace(',', '.')) || 0;
        });
        if (o.data && !o.stagione) o.stagione = A.seasonOf(o.data);
        return o;
    }).filter(o => o.data).map(normalizeReading);
};
const showImportPreview = (rows) => {
    pendingImport = rows;
    const existing = new Set(state.readings.map(r => r.data));
    const replaced = rows.filter(r => existing.has(r.data)).length;
    $('#import-summary').textContent = rows.length
        ? `${rows.length} readings found · ${rows.length - replaced} new, ${replaced} will replace existing dates.`
        : 'No valid rows found. Check the column names and date format.';
    $('#import-table').innerHTML = `<thead><tr><th>Date</th><th>Season</th>${ROOMS.map(k => `<th>${ROOM_LABELS[k]}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, 12).map(r => `<tr><td>${r.data}</td><td>${r.stagione}</td>${ROOMS.map(k => `<td>${r[k]}</td>`).join('')}</tr>`).join('')}</tbody>`;
    $('#btn-import-confirm').disabled = !rows.length;
    $('#import-preview').hidden = false;
};
const handleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    if (/\.csv$/i.test(file.name)) {
        reader.onload = (e) => showImportPreview(parseImport(e.target.result));
        reader.readAsText(file);
    } else {
        reader.onload = (e) => {
            const wb = XLSX.read(e.target.result, { type: 'array' });
            showImportPreview(parseImport(XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])));
        };
        reader.readAsArrayBuffer(file);
    }
};
const dz = $('#drop-zone');
$('#btn-browse').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); handleFile(e.dataTransfer.files[0]); });
$('#btn-import-cancel').addEventListener('click', () => { pendingImport = []; $('#import-preview').hidden = true; });
$('#btn-import-confirm').addEventListener('click', async (e) => {
    pendingImport.forEach(r => upsertReading(r));
    const n = pendingImport.length;
    pendingImport = [];
    await persist();
    renderAll();
    flash(e.currentTarget, `Imported ${n} ✓`);
    setTimeout(() => { $('#import-preview').hidden = true; }, 1600);
});

// ==========================================
// Render & init
// ==========================================
const renderAll = () => {
    buildModel();
    renderHeader();
    if (!state.model.latest) {
        $('#hero-card').innerHTML = '<p class="muted">No readings yet. Use “New reading” or import a CSV from Settings.</p>';
        renderNextCard();
        return;
    }
    renderHero();
    renderNextCard();
    renderRace();
    renderTiles();
    renderSeasonBars();
    renderRoomList();
    renderSeasons();
    renderRooms();
    renderClimate();
    renderPeriods();
    renderLog();
    renderReport();
    renderSyncNotice();
    renderCloudStatus();
};

const sameItems = (a, b, id) => {
    const m = new Map(b.map(x => [id(x), JSON.stringify(x)]));
    return a.filter(x => m.get(id(x)) !== JSON.stringify(x));
};

const loadCloud = async (serverReadings, serverPeriods) => {
    const fs = FS();
    if (!fs?.isInitialized()) { setCloud('off', 'Not available'); return; }
    await withTimeout(fs.ready, 5000).catch(() => { });
    if (!fs.isSignedIn()) { state.firebaseOK = false; setCloud('signed-out', 'Not signed in'); return; }
    try {
        setCloud('syncing', 'Loading…');
        const cloudReadings = (await withTimeout(fs.getLetture(), 8000)).map(normalizeReading);
        const cloudPeriods = (await withTimeout(fs.getHeatingPeriods(), 8000)).filter(p => p.start).map(normalizePeriod);
        state.firebaseOK = true;
        if (!cloudReadings.length) {
            // Cloud vuoto: primo caricamento dei dati esistenti
            await fs.sync(state.readings, state.periods);
            setCloud('ok', `Uploaded ${state.readings.length} readings`);
            return;
        }
        // Il cloud è la fonte principale; ciò che esiste solo sul server viene segnalato, non perso
        const onlyServer = serverReadings ? sameItems(serverReadings, cloudReadings, r => r.data) : [];
        const periodsDiffer = serverPeriods && serverPeriods.length && JSON.stringify(serverPeriods) !== JSON.stringify(cloudPeriods);
        state.readings = cloudReadings;
        if (cloudPeriods.length) state.periods = cloudPeriods;
        sortReadings();
        if (onlyServer.length || periodsDiffer) {
            state.serverOnly = { readings: onlyServer, periods: periodsDiffer ? serverPeriods : null };
        } else if (state.serverOK) {
            api.post('/api/letture', state.readings);
            api.post('/api/periods', state.periods);
        }
        setCloud('ok', 'Up to date');
    } catch (e) {
        state.firebaseOK = false;
        setCloud('error', fs.explain(e));
    }
};

const loadData = async () => {
    // 1. Server locale
    const [srvReadings, srvPeriods] = await Promise.all([api.get('/api/letture'), api.get('/api/periods')]);
    if (srvReadings) {
        state.serverOK = true;
        if (srvReadings.length) state.readings = srvReadings.map(normalizeReading);
        if (srvPeriods && srvPeriods.length) state.periods = srvPeriods.map(normalizePeriod);
    }

    // 2. Dati iniziali inclusi nel progetto (es. GitHub Pages al primo avvio)
    if (!state.readings.length && typeof INITIAL_DATA !== 'undefined') state.readings = INITIAL_DATA.map(normalizeReading);
    if (!state.periods.length && typeof INITIAL_HEATING_PERIODS !== 'undefined') state.periods = INITIAL_HEATING_PERIODS.map(normalizePeriod);
    sortReadings();

    // 3. Cloud (se l'accesso è stato fatto): diventa la fonte principale
    await loadCloud(srvReadings ? state.readings.slice() : null, srvPeriods ? state.periods.slice() : null);

    store.set('letture', state.readings);
    store.set('heatingPeriods', state.periods);
    // Primo avvio col server: salva i periodi (prima vivevano solo nel browser)
    if (state.serverOK && !(srvPeriods && srvPeriods.length) && !state.serverOnly) api.post('/api/periods', state.periods);
};

const init = async () => {
    applyTheme();
    const wantsNew = location.hash === '#new';
    showView(wantsNew ? 'overview' : (location.hash.slice(1) || 'overview'));
    state.readings = state.readings.map(normalizeReading);
    state.periods = state.periods.filter(p => p && p.start).map(normalizePeriod);
    state.weather = store.get('weather_v2');
    if (state.readings.length) renderAll(); // render immediato dalla cache locale
    if (wantsNew && state.model) openReadingSheet();

    await loadData();
    renderAll();
    if (wantsNew && state.model && !$('#sheet-reading').open) openReadingSheet();
    await loadWeather();
    renderAll();

    // Se l'accesso al cloud cambia (es. sessione ripristinata in ritardo), ricarica i dati
    FS()?.onAuthChange?.((u) => { if (u && !state.firebaseOK) reloadFromSources(); });
};

// App installabile: service worker solo in contesti sicuri (https o localhost)
if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.info('SW not registered', e)));
}

document.addEventListener('DOMContentLoaded', init);
