// ==========================================
// Dashboard Contabilizzatori - Main Application
// ==========================================

// Utility Functions
const formatDate = (date) => {
    const d = new Date(date);
    return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

const parseDate = (str) => {
    if (!str) return null;
    if (str instanceof Date) return str;
    // Handle DD/MM/YYYY
    if (str.includes('/')) {
        const [d, m, y] = str.split('/');
        return new Date(y, m - 1, d);
    }
    return new Date(str);
};

const getStagione = (date) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth();
    // Stagione riscaldamento: 15 Ottobre - 15 Aprile
    if (month >= 9) { // Ottobre-Dicembre
        return `${year % 100}/${(year + 1) % 100}`;
    } else if (month <= 3) { // Gennaio-Aprile
        return `${(year - 1) % 100}/${year % 100}`;
    }
    return `${(year - 1) % 100}/${year % 100}`;
};

const getStagioneColor = (stagione) => {
    const colors = {
        '18/19': '#ec4899',
        '19/20': '#a855f7',
        '20/21': '#6366f1',
        '21/22': '#0ea5e9',
        '22/23': '#8b5cf6',
        '23/24': '#3b82f6',
        '24/25': '#22c55e',
        '25/26': '#f97316',
        '26/27': '#ef4444'
    };
    return colors[stagione] || '#64748b';
};

const stanze = ['cucina', 'soggiorno', 'camera', 'cameretta', 'bagno'];

// API URL (per server locale)
const API_URL = '/api/letture';

// Storage Functions (localStorage come fallback)
const storage = {
    get: (key, defaultValue = null) => {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch { return defaultValue; }
    },
    set: (key, value) => {
        localStorage.setItem(key, JSON.stringify(value));
    }
};

// Salva letture sul server
const saveToServer = async () => {
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(letture)
        });
        if (response.ok) {
            console.log('✅ Dati salvati su server');
            return true;
        }
    } catch (e) {
        console.log('⚠️ Server non disponibile, salvato solo in localStorage');
    }
    return false;
};

// Salva e sincronizza
const saveLetture = async () => {
    storage.set('letture', letture);
    await saveToServer();

    // Firebase Sync (Save All / Update)
    if (window.FirebaseService && window.FirebaseService.isInitialized()) {
        try {
            // Salva tutte le letture presenti
            // Nota: per 100-200 letture è accettabile, per migliaia servirebbe logica diff
            const promises = letture.map(l => window.FirebaseService.saveLettura(l));
            await Promise.all(promises);
        } catch (e) {
            console.warn('Errore salvataggio Firebase:', e);
        }
    }
};



// State
let letture = storage.get('letture', []);
let heatingPeriods = storage.get('heatingPeriods', []); // { start: date, end: date }
let heatingEvents = storage.get('heatingEvents', []); // Legacy for toggle
let heatingOn = storage.get('heatingOn', false);
let weatherCache = storage.get('weatherCache', {});
let settings = storage.get('settings', { lat: 45.5962, lng: 8.9167 });

let currentChartType = 'confronto-anni';
let selectedAnni = [];
let selectedStanze = [...stanze];
let showTotale = true;
let mainChart = null;

// Toast Notification
const showToast = (message, type = 'success') => {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
};

// Navigation
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.section).classList.add('active');
    });
});

// Theme Toggle (Light/Dark Mode)
const savedTheme = storage.get('theme', 'light');
document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('theme-icon').textContent = savedTheme === 'dark' ? '☀️' : '🌙';

document.getElementById('btn-toggle-theme').addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    document.getElementById('theme-icon').textContent = newTheme === 'dark' ? '☀️' : '🌙';
    storage.set('theme', newTheme);
    showToast(newTheme === 'dark' ? 'Tema scuro attivato' : 'Tema chiaro attivato');
});

// Heating Toggle
const updateHeatingUI = () => {
    const dot = document.getElementById('heating-dot');
    const btn = document.getElementById('btn-toggle-heating-topbar');
    // Safe access - these elements may have been removed from HTML
    if (dot) {
        heatingOn ? dot.classList.add('on') : dot.classList.remove('on');
    }
    if (btn) {
        heatingOn ? btn.classList.add('active') : btn.classList.remove('active');
    }
};

const heatingToggleBtn = document.getElementById('btn-toggle-heating-topbar');
if (heatingToggleBtn) {
    heatingToggleBtn.addEventListener('click', () => {
        heatingOn = !heatingOn;
        storage.set('heatingOn', heatingOn);
        heatingEvents.push({ date: new Date().toISOString(), type: heatingOn ? 'on' : 'off' });
        storage.set('heatingEvents', heatingEvents);
        updateHeatingUI();
        showToast(heatingOn ? 'Riscaldamento acceso' : 'Riscaldamento spento');
    });
}

// Calculate consumption between readings
const calcConsumo = (lettura, prevLettura) => {
    if (!prevLettura) return { totale: 0, stanze: {} };
    const consumo = { stanze: {} };
    let totale = 0;
    stanze.forEach(s => {
        const diff = (lettura[s] || 0) - (prevLettura[s] || 0);
        consumo.stanze[s] = diff > 0 ? diff : 0;
        totale += consumo.stanze[s];
    });
    consumo.totale = totale;
    return consumo;
};

// Get unique seasons
const getStagioni = () => {
    const set = new Set(letture.map(l => l.stagione || getStagione(l.data)));
    return [...set].sort();
};

// Populate Filters
const populateFilters = () => {
    const stagioni = getStagioni();
    if (selectedAnni.length === 0) selectedAnni = [...stagioni];

    // Anni/Stagioni filter (if element exists)
    const anniList = document.getElementById('filter-anni-list');
    if (anniList) {
        anniList.innerHTML = stagioni.map(s => `
            <div class="filter-item ${selectedAnni.includes(s) ? 'active' : ''}" data-anno="${s}">
                <span class="anno-color" style="background: ${getStagioneColor(s)}"></span>
                <span class="filter-item-label">${s}</span>
            </div>
        `).join('');

        anniList.querySelectorAll('.filter-item').forEach(item => {
            item.addEventListener('click', () => {
                const anno = item.dataset.anno;
                if (selectedAnni.includes(anno)) {
                    selectedAnni = selectedAnni.filter(a => a !== anno);
                } else {
                    selectedAnni.push(anno);
                }
                item.classList.toggle('active');
                updateChart();
            });
        });
    }

    // Stanze filter (if element exists)
    const stanzeList = document.getElementById('filter-stanze-list');
    if (stanzeList) {
        stanzeList.innerHTML = stanze.map(s => `
            <div class="filter-item ${selectedStanze.includes(s) ? 'active' : ''}" data-stanza="${s}">
                <div class="filter-item-check">✓</div>
                <span class="filter-item-label">${s.charAt(0).toUpperCase() + s.slice(1)}</span>
            </div>
        `).join('');

        stanzeList.querySelectorAll('.filter-item').forEach(item => {
            item.addEventListener('click', () => {
                const stanza = item.dataset.stanza;
                if (selectedStanze.includes(stanza)) {
                    selectedStanze = selectedStanze.filter(s => s !== stanza);
                } else {
                    selectedStanze.push(stanza);
                }
                item.classList.toggle('active');
                updateChart();
            });
        });
    }

    // Totale filter
    const totaleItem = document.querySelector('.filter-item[data-stanza="totale"]');
    if (totaleItem) {
        totaleItem.classList.toggle('active', showTotale);
        totaleItem.addEventListener('click', () => {
            showTotale = !showTotale;
            totaleItem.classList.toggle('active', showTotale);
            updateChart();
        });
    }
};

// Chart Type Selection
let showStimaInDashboard = false; // Toggle between confronto and stima
let selectedStimaAnno = null;

document.querySelectorAll('.filter-btn[data-chart-type]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn[data-chart-type]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentChartType = btn.dataset.chartType;

        // Populate clima year selector
        if (currentChartType === 'clima') {
            const select = document.getElementById('clima-anno-select');
            const stagioni = getStagioni();
            select.innerHTML = stagioni.map(s =>
                `<option value="${s}" ${s === selectedClimaAnno ? 'selected' : ''}>${s}</option>`
            ).join('');
            if (!selectedClimaAnno && stagioni.length > 0) {
                selectedClimaAnno = stagioni[stagioni.length - 1]; // Default: most recent
            }
        }

        // Show/hide confronto toggle in chart header
        const chartViewToggle = document.getElementById('chart-view-toggle');
        if (currentChartType === 'confronto-anni') {
            chartViewToggle.style.display = 'flex';
        } else {
            chartViewToggle.style.display = 'none';
        }

        updateChart();
    });
});

// Confronto/Stima toggle buttons
document.getElementById('btn-view-confronto').addEventListener('click', () => {
    showStimaInDashboard = false;
    document.getElementById('btn-view-confronto').classList.add('active');
    document.getElementById('btn-view-stima').classList.remove('active');
    updateChart();
});

document.getElementById('btn-view-stima').addEventListener('click', () => {
    showStimaInDashboard = true;
    document.getElementById('btn-view-stima').classList.add('active');
    document.getElementById('btn-view-confronto').classList.remove('active');
    updateChart();
});

// Clima year selector change
document.getElementById('clima-anno-select').addEventListener('change', (e) => {
    selectedClimaAnno = e.target.value;
    updateChart();
});

// Update Widgets
const updateWidgets = () => {
    if (letture.length === 0) return;

    const sorted = [...letture].sort((a, b) => new Date(b.data) - new Date(a.data));
    const ultima = sorted[0];
    const prevLettura = sorted[1];

    // Ultima lettura
    const totUltima = stanze.reduce((sum, s) => sum + (ultima[s] || 0), 0);
    document.getElementById('ultima-lettura-valore').textContent = totUltima.toFixed(1);
    document.getElementById('ultima-lettura-data').textContent = formatDate(ultima.data);

    // Consumo anno corrente
    const currentStagione = getStagione(new Date());
    const stagLetture = sorted.filter(l => (l.stagione || getStagione(l.data)) === currentStagione);
    if (stagLetture.length >= 2) {
        const first = stagLetture[stagLetture.length - 1];
        const last = stagLetture[0];
        const consumo = stanze.reduce((sum, s) => sum + ((last[s] || 0) - (first[s] || 0)), 0);
        document.getElementById('consumo-anno-corrente').textContent = consumo.toFixed(1);
    }
    document.getElementById('label-anno-corrente').textContent = `Stagione ${currentStagione}`;

    // Giorni riscaldamento
    const onEvents = heatingEvents.filter(e => e.type === 'on' && (getStagione(e.date) === currentStagione));
    let giorni = 0;
    onEvents.forEach((ev, i) => {
        const offEvent = heatingEvents.find((e, j) => j > heatingEvents.indexOf(ev) && e.type === 'off');
        const endDate = offEvent ? new Date(offEvent.date) : new Date();
        giorni += Math.ceil((endDate - new Date(ev.date)) / (1000 * 60 * 60 * 24));
    });
    document.getElementById('giorni-riscaldamento').textContent = giorni;
    document.getElementById('label-stagione').textContent = `Stagione ${currentStagione}`;

    // Media giornaliera
    if (stagLetture.length >= 2 && giorni > 0) {
        const first = stagLetture[stagLetture.length - 1];
        const last = stagLetture[0];
        const consumo = stanze.reduce((sum, s) => sum + ((last[s] || 0) - (first[s] || 0)), 0);
        const media = consumo / giorni;
        document.getElementById('media-giornaliera').textContent = media.toFixed(2);
    }
};

// Chart rendering
const MONTHS = ['Ott', 'Nov', 'Dic', 'Gen', 'Feb', 'Mar', 'Apr', 'Mag'];
let selectedClimaAnno = null;
let temperaturesCache = {};

// Fetch temperature data from Open-Meteo API
const fetchTemperatures = async (year) => {
    const cacheKey = `temp_${year}`;
    if (temperaturesCache[cacheKey]) return temperaturesCache[cacheKey];

    try {
        // Stagione va da Ottobre a Aprile
        const startYear = parseInt('20' + year.split('/')[0]);
        const endYear = parseInt('20' + year.split('/')[1]);
        const startDate = `${startYear}-10-01`;
        const endDate = `${endYear}-04-30`;

        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${settings.lat}&longitude=${settings.lng}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean&timezone=Europe/Rome`;

        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            temperaturesCache[cacheKey] = data.daily;
            return data.daily;
        }
    } catch (e) {
        console.log('Errore fetch temperature:', e);
    }
    return null;
};

// Extended MONTHS array for full year (Aug to Jul)
const MONTHS_FULL = ['Ago', 'Set', 'Ott', 'Nov', 'Dic', 'Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug'];

// Get month index for full year (Aug=0, Sep=1, ..., Jul=11)
const getSeasonMonth = (date) => {
    const d = new Date(date);
    const month = d.getMonth(); // 0-11 (Jan=0, ..., Dec=11)
    // Remap to Aug=0: Aug(7)->0, Sep(8)->1, ..., Jul(6)->11
    return (month - 7 + 12) % 12;
};

// Generate daily stima for dashboard (line chart version)
const generateDailyStimaLine = async (stagione) => {
    const yearData = letture.filter(l => (l.stagione || getStagione(l.data)) === stagione);
    if (yearData.length < 2) return null;

    const sorted = [...yearData].sort((a, b) => new Date(a.data) - new Date(b.data));

    // Try temperature-weighted
    let temps = null;
    try {
        temps = await fetchTemperatures(stagione);
    } catch (e) { }

    const dailyData = [];
    const useWeighted = temps && temps.time && temps.temperature_2m_mean;

    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        const prevDate = new Date(prev.data);
        const currDate = new Date(curr.data);
        const days = Math.ceil((currDate - prevDate) / (1000 * 60 * 60 * 24));
        if (days <= 0) continue;

        const totalPrev = stanze.reduce((sum, s) => sum + (prev[s] || 0), 0);
        const totalCurr = stanze.reduce((sum, s) => sum + (curr[s] || 0), 0);
        const totalDiff = totalCurr - totalPrev;

        if (useWeighted && totalDiff > 0) {
            const dayTemps = [];
            for (let d = 0; d < days; d++) {
                const date = new Date(prevDate);
                date.setDate(date.getDate() + d);
                const dateStr = date.toISOString().split('T')[0];
                const tempIdx = temps.time.indexOf(dateStr);
                let temp = tempIdx >= 0 ? temps.temperature_2m_mean[tempIdx] : 10;
                dayTemps.push({ date, temp: temp !== null ? temp : 10 });
            }
            const weights = dayTemps.map(d => Math.max(0.1, 20 - d.temp));
            const totalWeight = weights.reduce((s, w) => s + w, 0);
            dayTemps.forEach((d, idx) => {
                // Solo giorni dentro periodo riscaldamento
                const dateStr = d.date.toISOString().split('T')[0];
                if (isInHeatingPeriod(dateStr)) {
                    dailyData.push({
                        date: d.date,
                        value: totalDiff * (weights[idx] / totalWeight)
                    });
                }
            });
        } else {
            const dailyRate = totalDiff / days;
            for (let d = 0; d < days; d++) {
                const date = new Date(prevDate);
                date.setDate(date.getDate() + d);
                // Solo giorni dentro periodo riscaldamento
                const dateStr = date.toISOString().split('T')[0];
                if (isInHeatingPeriod(dateStr)) {
                    dailyData.push({ date, value: dailyRate });
                }
            }
        }
    }

    return dailyData;
};

// Render Calendar View
let selectedCalendarioYear = new Date().getFullYear();

const renderCalendario = (year = selectedCalendarioYear) => {
    const container = document.getElementById('calendario-container');
    if (!container) return;

    const monthNames = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
        'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
    const weekDays = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];

    // Get readings by date for quick lookup
    const readingsByDate = {};
    letture.forEach(l => {
        const stagione = l.stagione || getStagione(l.data);
        readingsByDate[l.data] = { stagione, color: getStagioneColor(stagione) };
    });

    const today = new Date().toISOString().split('T')[0];

    // Get all available years
    const years = new Set();
    letture.forEach(l => years.add(new Date(l.data).getFullYear()));
    years.add(new Date().getFullYear());
    const sortedYears = [...years].sort((a, b) => b - a);

    // Build legend - show all seasons that have readings in this year
    const legendColors = {};
    letture.forEach(l => {
        const lYear = new Date(l.data).getFullYear();
        if (lYear === year) {
            const stagione = l.stagione || getStagione(l.data);
            legendColors[stagione] = getStagioneColor(stagione);
        }
    });

    // Year selector at top center
    let html = `
    <div class="calendario-year-selector">
        <button class="calendario-nav-btn" id="btn-prev-year">◀</button>
        <select id="calendario-anno-inline" class="calendario-year-select">
            ${sortedYears.map(y => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
        <button class="calendario-nav-btn" id="btn-next-year">▶</button>
    </div>`;

    // Legend
    html += `<div class="calendario-legend">
        <span style="font-weight: 600; margin-right: 8px;">Legenda:</span>
        ${Object.entries(legendColors).map(([stagione, color]) =>
        `<div class="legend-item">
                <div class="legend-dot" style="background: ${color}"></div>
                <span>${stagione}</span>
            </div>`
    ).join('')}
    </div>`;

    // Build calendar for the selected year
    html += '<div class="calendario-grid">';

    for (let month = 0; month < 12; month++) {
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const daysInMonth = lastDay.getDate();

        // Get day of week for first day (0 = Sunday, convert to Monday-based)
        let startDay = firstDay.getDay();
        startDay = startDay === 0 ? 6 : startDay - 1; // Convert to Monday = 0

        html += `
        <div class="calendario-month">
            <div class="calendario-month-header">${monthNames[month]}</div>
            <div class="calendario-weekdays">
                ${weekDays.map(d => `<div class="calendario-weekday">${d}</div>`).join('')}
            </div>
            <div class="calendario-days">`;

        // Empty cells before first day
        for (let i = 0; i < startDay; i++) {
            html += '<div class="calendario-day empty"></div>';
        }

        // Days of the month
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const reading = readingsByDate[dateStr];
            const isToday = dateStr === today;

            let classes = 'calendario-day';
            if (isToday && !reading) classes += ' today';
            if (reading) classes += ' has-reading';

            html += `<div class="${classes}"`;
            if (reading) {
                html += ` style="--dot-color: ${reading.color}"`;
            }
            html += `>${day}</div>`;
        }

        html += '</div></div>';
    }

    html += '</div>';
    container.innerHTML = html;

    // Attach event listeners for navigation
    document.getElementById('btn-prev-year')?.addEventListener('click', () => {
        const idx = sortedYears.indexOf(selectedCalendarioYear);
        if (idx < sortedYears.length - 1) {
            selectedCalendarioYear = sortedYears[idx + 1];
            renderCalendario(selectedCalendarioYear);
            updateCalendarioStats();
        }
    });

    document.getElementById('btn-next-year')?.addEventListener('click', () => {
        const idx = sortedYears.indexOf(selectedCalendarioYear);
        if (idx > 0) {
            selectedCalendarioYear = sortedYears[idx - 1];
            renderCalendario(selectedCalendarioYear);
            updateCalendarioStats();
        }
    });

    document.getElementById('calendario-anno-inline')?.addEventListener('change', (e) => {
        selectedCalendarioYear = parseInt(e.target.value);
        renderCalendario(selectedCalendarioYear);
        updateCalendarioStats();
    });
};

// Update stats for calendario
const updateCalendarioStats = () => {
    const yearReadings = letture.filter(l => new Date(l.data).getFullYear() === selectedCalendarioYear);
    document.getElementById('stat-letture').textContent = yearReadings.length;
};

const updateChart = async () => {
    const ctx = document.getElementById('chart-main').getContext('2d');
    if (mainChart) mainChart.destroy();

    // Show/hide clima selector
    const climaSelector = document.getElementById('clima-anno-selector');
    climaSelector.style.display = currentChartType === 'clima' ? 'block' : 'none';

    // Show/hide canvas vs calendario
    const canvas = document.getElementById('chart-main');
    const calendarioContainer = document.getElementById('calendario-container');
    if (currentChartType === 'calendario') {
        canvas.style.display = 'none';
        calendarioContainer.style.display = 'block';
        renderCalendario(selectedCalendarioYear);
        updateCalendarioStats();
        document.getElementById('stat-totale').textContent = '-';
        document.getElementById('stat-media').textContent = '-';
        return;
    } else {
        canvas.style.display = 'block';
        calendarioContainer.style.display = 'none';
    }

    const filtered = letture.filter(l => selectedAnni.includes(l.stagione || getStagione(l.data)));
    if (filtered.length === 0) {
        document.getElementById('stat-totale').textContent = '0';
        document.getElementById('stat-media').textContent = '0';
        document.getElementById('stat-letture').textContent = '0';
        return;
    }

    // Per confronto-anni, filtra solo le letture dentro i periodi di riscaldamento
    const filteredForChart = currentChartType === 'confronto-anni'
        ? filtered.filter(l => isInHeatingPeriod(l.data))
        : filtered;

    const sorted = [...filteredForChart].sort((a, b) => new Date(a.data) - new Date(b.data));

    // Calculate cumulative consumption per season (reset per stagione)
    const byStagione = {};
    selectedAnni.forEach(s => byStagione[s] = []);

    let prevByStagione = {};
    sorted.forEach(l => {
        const stag = l.stagione || getStagione(l.data);
        if (!byStagione[stag]) return;

        const prev = prevByStagione[stag];
        const consumo = calcConsumo(l, prev);
        byStagione[stag].push({ ...l, consumo, monthIdx: getSeasonMonth(l.data) });
        prevByStagione[stag] = l;
    });

    let datasets = [];
    let labels = MONTHS_FULL;

    // Common options for lines (no points)
    const lineOptions = {
        tension: 0.4,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 6,
        borderWidth: 3
    };

    if (currentChartType === 'confronto-anni') {
        if (showStimaInDashboard) {
            // Show daily stima as line charts for ALL selected years overlaid
            // Same data as Dettaglio but with lines instead of bars

            // Find the max number of days across all seasons
            let maxDays = 0;
            const allDailyData = {};

            for (const anno of selectedAnni) {
                const dailyData = await generateDailyStimaLine(anno);
                if (dailyData && dailyData.length > 0) {
                    allDailyData[anno] = dailyData;
                    maxDays = Math.max(maxDays, dailyData.length);
                }
            }

            // Create labels based on days of season (using first season's dates as reference)
            // Sample for readability - show ~100 labels
            const sampleRate = Math.max(1, Math.floor(maxDays / 100));
            const firstAnno = Object.keys(allDailyData)[0];
            if (firstAnno && allDailyData[firstAnno]) {
                const sampleIndices = [];
                for (let i = 0; i < maxDays; i += sampleRate) {
                    sampleIndices.push(i);
                }

                labels = sampleIndices.map(i => {
                    const d = allDailyData[firstAnno][i];
                    if (d) {
                        return d.date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' });
                    }
                    return '';
                });

                // Build datasets for each year
                for (const [anno, dailyData] of Object.entries(allDailyData)) {
                    const sampledValues = sampleIndices.map(i => {
                        if (i < dailyData.length) {
                            return dailyData[i].value;
                        }
                        return null;
                    });

                    datasets.push({
                        label: anno,
                        data: sampledValues,
                        borderColor: getStagioneColor(anno),
                        backgroundColor: getStagioneColor(anno) + '33',
                        fill: true,
                        ...lineOptions
                    });
                }
            }
        } else {
            // Normal confronto-anni by month (12 months)
            Object.entries(byStagione).forEach(([stag, data]) => {
                if (data.length === 0) return;

                // Accumulate consumption by month (12 months)
                const monthlyData = new Array(12).fill(null);
                let cumulative = 0;

                data.forEach(l => {
                    if (l.monthIdx >= 0 && l.monthIdx < 12) {
                        cumulative += l.consumo.totale;
                        monthlyData[l.monthIdx] = cumulative;
                    }
                });

                // Fill gaps with previous values
                for (let i = 1; i < 12; i++) {
                    if (monthlyData[i] === null && monthlyData[i - 1] !== null) {
                        monthlyData[i] = monthlyData[i - 1];
                    }
                }

                datasets.push({
                    label: stag,
                    data: monthlyData,
                    borderColor: getStagioneColor(stag),
                    backgroundColor: getStagioneColor(stag) + '33',
                    ...lineOptions
                });
            });
        }

    } else if (currentChartType === 'andamento') {
        const allData = Object.values(byStagione).flat().sort((a, b) => new Date(a.data) - new Date(b.data));
        labels = allData.map(l => formatDate(l.data));

        // Calculate daily average consumption (consumo / giorni tra letture)
        const dailyAverage = allData.map((l, i) => {
            if (i === 0) return 0;
            const prevDate = new Date(allData[i - 1].data);
            const currDate = new Date(l.data);
            const days = Math.max(1, Math.ceil((currDate - prevDate) / (1000 * 60 * 60 * 24)));
            return l.consumo.totale / days;
        });

        datasets.push({
            label: 'Media Giornaliera',
            data: dailyAverage,
            borderColor: '#e8673c',
            backgroundColor: 'rgba(232, 103, 60, 0.1)',
            fill: true,
            ...lineOptions
        });

    } else if (currentChartType === 'stanze') {
        const allData = Object.values(byStagione).flat().sort((a, b) => new Date(a.data) - new Date(b.data));
        labels = allData.map(l => formatDate(l.data));
        const colors = ['#e8673c', '#3b82f6', '#22c55e', '#f97316', '#8b5cf6'];

        selectedStanze.forEach((s, i) => {
            datasets.push({
                label: s.charAt(0).toUpperCase() + s.slice(1),
                data: allData.map(l => l.consumo.stanze[s] || 0),
                borderColor: colors[i % colors.length],
                ...lineOptions
            });
        });

    } else if (currentChartType === 'variazione') {
        const allData = Object.values(byStagione).flat().sort((a, b) => new Date(a.data) - new Date(b.data));
        labels = allData.map(l => formatDate(l.data));

        const variazioni = allData.map((l, i) => {
            if (i === 0) return 0;
            const prev = allData[i - 1].consumo.totale;
            return prev ? ((l.consumo.totale - prev) / prev * 100) : 0;
        });

        datasets.push({
            label: 'Variazione %',
            data: variazioni,
            borderColor: '#3b82f6',
            backgroundColor: variazioni.map(v => v >= 0 ? 'rgba(239, 68, 68, 0.6)' : 'rgba(34, 197, 94, 0.6)'),
            type: 'bar'
        });

    } else if (currentChartType === 'clima') {
        // Clima: Mixed chart - temperature curve + daily consumption estimation bars
        const anno = selectedClimaAnno || selectedAnni[0];

        // Get readings for this season
        const yearData = letture.filter(l => (l.stagione || getStagione(l.data)) === anno);
        const sortedReadings = [...yearData].sort((a, b) => new Date(a.data) - new Date(b.data));

        // Fetch temperatures for this season
        const temps = await fetchTemperatures(anno);

        if (temps && temps.time) {
            // Determine if this is the current season
            const currentStagione = getStagione(new Date());
            const isCurrentYear = anno === currentStagione;
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Find the last reading date for this season
            const lastReadingDate = sortedReadings.length > 0
                ? new Date(sortedReadings[sortedReadings.length - 1].data)
                : null;
            if (lastReadingDate) lastReadingDate.setHours(0, 0, 0, 0);

            // Generate daily stima data (same logic as updateStimaChart)
            const dailyData = [];

            for (let i = 1; i < sortedReadings.length; i++) {
                const prev = sortedReadings[i - 1];
                const curr = sortedReadings[i];
                const prevDate = new Date(prev.data);
                const currDate = new Date(curr.data);
                const days = Math.ceil((currDate - prevDate) / (1000 * 60 * 60 * 24));

                if (days <= 0) continue;

                const totalPrev = stanze.reduce((sum, s) => sum + (prev[s] || 0), 0);
                const totalCurr = stanze.reduce((sum, s) => sum + (curr[s] || 0), 0);
                const totalDiff = totalCurr - totalPrev;

                if (temps && temps.time && temps.temperature_2m_mean && totalDiff > 0) {
                    // Temperature-weighted interpolation
                    const dayTemps = [];
                    for (let d = 0; d < days; d++) {
                        const date = new Date(prevDate);
                        date.setDate(date.getDate() + d);
                        const dateStr = date.toISOString().split('T')[0];
                        const tempIdx = temps.time.indexOf(dateStr);
                        let temp = tempIdx >= 0 ? temps.temperature_2m_mean[tempIdx] : 10;
                        dayTemps.push({ date, dateStr, temp: temp !== null ? temp : 10 });
                    }

                    const weights = dayTemps.map(d => Math.max(0.1, 20 - d.temp));
                    const totalWeight = weights.reduce((s, w) => s + w, 0);

                    dayTemps.forEach((d, idx) => {
                        dailyData.push({
                            date: d.date,
                            dateStr: d.dateStr,
                            value: totalDiff * (weights[idx] / totalWeight)
                        });
                    });
                } else {
                    // Linear interpolation
                    const dailyRate = totalDiff / days;
                    for (let d = 0; d < days; d++) {
                        const date = new Date(prevDate);
                        date.setDate(date.getDate() + d);
                        dailyData.push({
                            date,
                            dateStr: date.toISOString().split('T')[0],
                            value: dailyRate
                        });
                    }
                }
            }

            // Create weekly sampled labels and data for temperature (all available)
            // But for current year, limit temperature to today
            const tempLabels = [];
            const tempData = [];
            const consumoData = [];

            for (let i = 0; i < temps.time.length; i += 7) {
                const date = new Date(temps.time[i]);

                // For current year, stop temperature at today
                if (isCurrentYear && date > today) break;

                tempLabels.push(date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' }));

                // Average of the week
                let weekSum = 0, weekCount = 0;
                for (let j = i; j < Math.min(i + 7, temps.time.length); j++) {
                    const dayDate = new Date(temps.time[j]);
                    // For current year, don't include days after today
                    if (isCurrentYear && dayDate > today) break;

                    if (temps.temperature_2m_mean[j] !== null) {
                        weekSum += temps.temperature_2m_mean[j];
                        weekCount++;
                    }
                }
                tempData.push(weekCount > 0 ? weekSum / weekCount : null);

                // Sum daily consumption for this week
                // For current year, only include days up to last reading
                let weekConsumo = 0;
                let hasData = false;
                for (let j = i; j < Math.min(i + 7, temps.time.length); j++) {
                    const dayDateStr = temps.time[j];
                    const dayDate = new Date(dayDateStr);

                    // For current year, stop at last reading date
                    if (isCurrentYear && lastReadingDate && dayDate > lastReadingDate) break;

                    const dayData = dailyData.find(d => d.dateStr === dayDateStr);
                    if (dayData) {
                        weekConsumo += dayData.value;
                        hasData = true;
                    }
                }
                consumoData.push(hasData ? weekConsumo : null);
            }

            labels = tempLabels;

            // Temperature line
            datasets.push({
                type: 'line',
                label: `Temperatura ${anno}`,
                data: tempData,
                borderColor: '#0ea5e9',
                backgroundColor: 'rgba(14, 165, 233, 0.1)',
                fill: true,
                yAxisID: 'y1',
                tension: 0.4,
                pointRadius: 0,
                borderWidth: 2,
                order: 1
            });

            // Daily consumption estimation bars (weekly aggregated)
            datasets.push({
                type: 'bar',
                label: `Stima Consumo ${anno}`,
                data: consumoData,
                backgroundColor: getStagioneColor(anno) + 'aa',
                borderColor: getStagioneColor(anno),
                borderWidth: 1,
                yAxisID: 'y',
                order: 0,
                barPercentage: 0.9,
                categoryPercentage: 0.95
            });
        }

    } else if (currentChartType === 'periodi') {
        // Horizontal bar chart showing heating periods for each season
        // X axis: months from August to August (13 months)
        // Y axis: seasons
        const monthLabels = ['Ago', 'Set', 'Ott', 'Nov', 'Dic', 'Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago'];
        labels = monthLabels;

        // Get all seasons from heating periods
        const seasonSet = new Set();
        heatingPeriods.forEach(p => {
            const startStagione = getStagione(p.start);
            seasonSet.add(startStagione);
        });

        // Also add selected seasons
        selectedAnni.forEach(s => seasonSet.add(s));

        const seasons = [...seasonSet].sort((a, b) => {
            // Sort by year extracted from season (e.g., "24-25" -> 24)
            const aYear = parseInt(a.split('-')[0]);
            const bYear = parseInt(b.split('-')[0]);
            return aYear - bYear;
        });

        // For each season, create bars for each month where heating was on
        seasons.forEach((stagione, idx) => {
            const seasonPeriods = heatingPeriods.filter(p => getStagione(p.start) === stagione);
            const monthData = new Array(13).fill(0);

            seasonPeriods.forEach(period => {
                const start = new Date(period.start);
                const end = new Date(period.end);

                // Get the base year for this season (August start year)
                const match = stagione.match(/(\d{2})-(\d{2})/);
                const baseYear = match ? 2000 + parseInt(match[1]) : start.getFullYear();

                // For each day in the period, mark the corresponding month
                let current = new Date(start);
                while (current <= end) {
                    const month = current.getMonth();
                    const year = current.getFullYear();

                    // Calculate month index (0 = August of start year, 12 = August of end year)
                    let monthIdx;
                    if (month >= 7) { // Aug-Dec (7-11) -> indices 0-4
                        monthIdx = month - 7;
                    } else { // Jan-Aug (0-7) -> indices 5-12
                        monthIdx = month + 5;
                    }

                    if (monthIdx >= 0 && monthIdx < 13) {
                        monthData[monthIdx] = 1; // Mark this month as having heating
                    }

                    current.setDate(current.getDate() + 1);
                }
            });

            datasets.push({
                label: stagione,
                data: monthData,
                backgroundColor: getStagioneColor(stagione),
                borderColor: getStagioneColor(stagione),
                borderWidth: 1,
                barPercentage: 0.8,
                categoryPercentage: 0.9
            });
        });
    }

    // Update stats
    const allConsumo = Object.values(byStagione).flat();
    const totConsumo = allConsumo.reduce((sum, l) => sum + l.consumo.totale, 0);
    document.getElementById('stat-totale').textContent = totConsumo.toFixed(1);
    document.getElementById('stat-media').textContent = allConsumo.length ? (totConsumo / allConsumo.length).toFixed(1) : '0';
    document.getElementById('stat-letture').textContent = allConsumo.length;

    let chartType = 'line';
    if (currentChartType === 'variazione' || currentChartType === 'periodi') chartType = 'bar';

    const chartOptions = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
            legend: { position: 'top' },
            tooltip: {
                callbacks: {
                    label: (ctx) => {
                        if (currentChartType === 'clima') {
                            const val = ctx.parsed.y;
                            if (ctx.dataset.yAxisID === 'y1') {
                                return `${ctx.dataset.label}: ${val?.toFixed(1)}°C`;
                            }
                            return `${ctx.dataset.label}: ${val?.toFixed(1) || '-'}`;
                        }
                        return `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) || '-'}`;
                    }
                }
            }
        },
        scales: {
            y: {
                display: currentChartType !== 'periodi',
                beginAtZero: true,
                grid: { color: 'rgba(0,0,0,0.05)' },
                title: { display: currentChartType === 'clima', text: 'Consumo' },
                position: 'left',
                max: currentChartType === 'periodi' ? 1.5 : undefined
            },
            x: {
                grid: { display: false },
                stacked: currentChartType === 'periodi'
            }
        }
    };

    // For periodi chart, stack bars and customize
    if (currentChartType === 'periodi') {
        chartOptions.indexAxis = 'x'; // Vertical bars (one per month)
        chartOptions.scales.y.stacked = false;
        chartOptions.plugins.tooltip.callbacks.label = (ctx) => {
            return ctx.parsed.y > 0 ? `${ctx.dataset.label}: Riscaldamento ACCESO` : '';
        };
    }

    // Add second Y axis for temperature in clima mode
    if (currentChartType === 'clima') {
        chartOptions.scales.y1 = {
            position: 'right',
            grid: { display: false },
            title: { display: true, text: '°C' }
        };
    }

    mainChart = new Chart(ctx, {
        type: chartType,
        data: { labels, datasets },
        options: chartOptions
    });
};

// Render Readings Table
const renderTable = () => {
    const tbody = document.getElementById('tabella-letture-body');
    const sorted = [...letture].sort((a, b) => new Date(b.data) - new Date(a.data));

    tbody.innerHTML = sorted.map((l, idx) => {
        const prev = sorted[idx + 1];
        const consumo = calcConsumo(l, prev);
        const stagione = l.stagione || getStagione(l.data);
        const giorni = prev ? Math.ceil((new Date(l.data) - new Date(prev.data)) / (1000 * 60 * 60 * 24)) : '-';
        const totale = stanze.reduce((sum, s) => sum + (l[s] || 0), 0);
        const media = giorni !== '-' && giorni > 0 ? (consumo.totale / giorni).toFixed(2) : '-';
        const isHeating = isInHeatingPeriod(l.data);

        return `
        <tr data-idx="${letture.indexOf(l)}">
            <td class="heating-status-cell"><div class="heating-bar ${isHeating ? 'on' : 'off'}"></div></td>
            <td class="col-stagione"><span class="stagione-badge" style="background: ${getStagioneColor(stagione)}">${stagione}</span></td>
            <td class="col-data">${formatDate(l.data)}</td>
            <td class="col-durata">${giorni}g</td>
            <td class="col-temp">${l.tempExt ? l.tempExt.toFixed(1) + '°' : '-'}</td>
            ${stanze.map(s => `<td class="col-stanza">${(l[s] || 0).toFixed(1)}</td>`).join('')}
            <td class="col-tot">${totale.toFixed(1)}</td>
            <td class="col-parziali">${consumo.totale.toFixed(1)}</td>
            <td class="col-media">${media}</td>
            <td class="col-actions">
                <button class="btn-icon btn-delete" data-idx="${letture.indexOf(l)}">🗑️</button>
            </td>
        </tr>`;
    }).join('');

    // Delete handlers
    tbody.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (confirm('Eliminare questa lettura?')) {
                const idx = parseInt(btn.dataset.idx);
                const deletedItem = letture[idx];

                letture.splice(idx, 1);
                await saveLetture();

                // Elimina da Firebase
                if (window.FirebaseService && window.FirebaseService.isInitialized()) {
                    await window.FirebaseService.deleteLettura(deletedItem.data);
                }

                renderTable();
                updateChart();
                updateWidgets();
                showToast('Lettura eliminata');
            }
        });
    });
};

// Add New Reading
document.getElementById('btn-nuova-riga').addEventListener('click', async () => {
    const nuova = {
        data: new Date().toISOString().split('T')[0],
        stagione: getStagione(new Date()),
        cucina: 0, soggiorno: 0, camera: 0, cameretta: 0, bagno: 0
    };
    letture.push(nuova);
    await saveLetture();
    renderTable();
    showToast('Nuova riga aggiunta');
});

// Settings Modal
document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('modal-settings').classList.add('show');
    document.getElementById('setting-lat').value = settings.lat;
    document.getElementById('setting-lng').value = settings.lng;
});

document.getElementById('close-settings').addEventListener('click', () => {
    document.getElementById('modal-settings').classList.remove('show');
});

document.getElementById('btn-salva-posizione').addEventListener('click', () => {
    settings.lat = parseFloat(document.getElementById('setting-lat').value);
    settings.lng = parseFloat(document.getElementById('setting-lng').value);
    storage.set('settings', settings);
    showToast('Posizione salvata');
});

document.getElementById('btn-pulisci-cache-meteo').addEventListener('click', () => {
    weatherCache = {};
    storage.set('weatherCache', weatherCache);
    showToast('Cache meteo pulita');
});

document.getElementById('btn-elimina-tutti').addEventListener('click', () => {
    if (confirm('Eliminare TUTTI i dati? Questa azione è irreversibile!')) {
        localStorage.clear();
        location.reload();
    }
});

// Export Functions
document.getElementById('btn-esporta-csv').addEventListener('click', () => {
    const headers = ['data', 'stagione', ...stanze];
    const rows = letture.map(l => [l.data, l.stagione, ...stanze.map(s => l[s] || 0)]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'letture.csv';
    a.click();
});

document.getElementById('btn-esporta-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(letture, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'letture.json';
    a.click();
});

// Manual Sync Handler
document.getElementById('btn-sync-firebase').addEventListener('click', async () => {
    if (!window.FirebaseService || !window.FirebaseService.isInitialized()) {
        showToast('Firebase non configurato o non inizializzato', 'error');
        return;
    }

    const btn = document.getElementById('btn-sync-firebase');
    const originalText = btn.textContent;
    btn.textContent = '⏳ Sincronizzazione...';
    btn.disabled = true;

    try {
        // Sync Letture
        const promises = letture.map(l => window.FirebaseService.saveLettura(l));
        await Promise.all(promises);

        // Sync Heating Periods
        const hpPromises = heatingPeriods.map(p => window.FirebaseService.saveHeatingPeriod(p));
        await Promise.all(hpPromises);

        showToast(`Sincronizzati ${letture.length} letture e ${heatingPeriods.length} periodi`);
    } catch (e) {
        console.error(e);
        showToast('Errore durante la sincronizzazione', 'error');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});

// Heating History Modal


document.getElementById('btn-heating-history').addEventListener('click', () => {
    document.getElementById('modal-heating').classList.add('show');
    renderHeatingHistory();
});

document.getElementById('close-heating').addEventListener('click', () => {
    document.getElementById('modal-heating').classList.remove('show');
});

const renderHeatingHistory = () => {
    const tbody = document.getElementById('heating-history-body');
    const sorted = [...heatingEvents].sort((a, b) => new Date(b.date) - new Date(a.date));

    tbody.innerHTML = sorted.map((ev, i) => {
        const nextOff = ev.type === 'on' ? sorted.slice(0, i).reverse().find(e => e.type === 'off') : null;
        const durata = nextOff ? Math.ceil((new Date(nextOff.date) - new Date(ev.date)) / (1000 * 60 * 60 * 24)) : '-';
        return `
        <tr>
            <td>${formatDate(ev.date)}</td>
            <td><span class="event-badge ${ev.type}">${ev.type === 'on' ? '🔥 Acceso' : '❄️ Spento'}</span></td>
            <td>${ev.type === 'on' ? durata + ' giorni' : '-'}</td>
            <td><button class="btn-icon btn-delete-event" data-idx="${heatingEvents.indexOf(ev)}">🗑️</button></td>
        </tr>`;
    }).join('');

    // Stats
    const currentStagione = getStagione(new Date());
    document.getElementById('heating-total-days').textContent = heatingEvents.filter(e => e.type === 'on').length * 15; // Approx
    document.getElementById('heating-periods').textContent = heatingEvents.filter(e => e.type === 'on').length;
    document.getElementById('heating-current-season').textContent = heatingEvents.filter(e => e.type === 'on' && getStagione(e.date) === currentStagione).length;
};

// Import File
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

document.getElementById('btn-sfoglia').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFile(e.dataTransfer.files[0]);
});

const handleFile = (file) => {
    if (!file) return;
    const reader = new FileReader();

    if (file.name.endsWith('.csv')) {
        reader.onload = (e) => parseCSV(e.target.result);
        reader.readAsText(file);
    } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        reader.onload = (e) => {
            const workbook = XLSX.read(e.target.result, { type: 'binary' });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const csv = XLSX.utils.sheet_to_csv(sheet);
            parseCSV(csv);
        };
        reader.readAsBinaryString(file);
    }
};

let pendingImport = [];

const parseCSV = (csv) => {
    const lines = csv.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

    pendingImport = lines.slice(1).map(line => {
        const values = line.split(',');
        const obj = {};
        headers.forEach((h, i) => {
            if (h === 'data') obj.data = values[i];
            else if (h === 'stagione') obj.stagione = values[i];
            else if (stanze.includes(h)) obj[h] = parseFloat(values[i]) || 0;
        });
        if (!obj.stagione && obj.data) obj.stagione = getStagione(obj.data);
        return obj;
    }).filter(o => o.data);

    // Show preview
    document.getElementById('preview-import').style.display = 'block';
    document.getElementById('preview-righe').textContent = `${pendingImport.length} righe`;

    const table = document.getElementById('tabella-preview');
    table.querySelector('thead').innerHTML = `<tr>${['Data', 'Stagione', ...stanze.map(s => s.charAt(0).toUpperCase() + s.slice(1))].map(h => `<th>${h}</th>`).join('')}</tr>`;
    table.querySelector('tbody').innerHTML = pendingImport.slice(0, 10).map(l => `
        <tr>
            <td>${l.data}</td>
            <td>${l.stagione}</td>
            ${stanze.map(s => `<td>${l[s] || 0}</td>`).join('')}
        </tr>
    `).join('');
};

document.getElementById('btn-conferma-import').addEventListener('click', async () => {
    const count = pendingImport.length;
    letture = [...letture, ...pendingImport];
    await saveLetture();
    pendingImport = [];
    document.getElementById('preview-import').style.display = 'none';
    populateFilters();
    updateChart();
    updateWidgets();
    renderTable();
    showToast(`${count} letture importate`);
});

document.getElementById('btn-annulla-import').addEventListener('click', () => {
    pendingImport = [];
    document.getElementById('preview-import').style.display = 'none';
});

document.getElementById('btn-scarica-template').addEventListener('click', () => {
    const csv = 'data,cucina,soggiorno,camera,cameretta,bagno,stagione\n01/11/2024,100,150,80,60,40,24/25';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'template_letture.csv';
    a.click();
});

// Modal click outside to close
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('show');
    });
});

// ==========================================
// Heating Periods Management
// ==========================================

// Check if a date falls within any heating period
const isInHeatingPeriod = (dateStr) => {
    const date = new Date(dateStr);
    return heatingPeriods.some(p => {
        const start = new Date(p.start);
        // Se end è null, il periodo è ancora in corso (usa oggi come fine)
        const end = p.end ? new Date(p.end) : new Date();
        return date >= start && date <= end;
    });
};

// Get heating period for a date
const getHeatingPeriod = (dateStr) => {
    const date = new Date(dateStr);
    return heatingPeriods.find(p => {
        const start = new Date(p.start);
        // Se end è null, il periodo è ancora in corso (usa oggi come fine)
        const end = p.end ? new Date(p.end) : new Date();
        return date >= start && date <= end;
    });
};

// Render heating periods list
const renderHeatingPeriods = () => {
    const list = document.getElementById('heating-periods-list');
    if (!list) return;

    if (heatingPeriods.length === 0) {
        list.innerHTML = '<div class="heating-periods-empty">Nessun periodo di riscaldamento inserito</div>';
        return;
    }

    const sorted = [...heatingPeriods].sort((a, b) => new Date(b.start) - new Date(a.start));

    list.innerHTML = sorted.map((p, idx) => {
        const stagione = getStagione(p.start);
        const startDate = new Date(p.start);
        // Se end è null, il periodo è in corso
        const endDate = p.end ? new Date(p.end) : new Date();
        const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
        const endLabel = p.end ? formatDate(p.end) : '🔥 In corso';

        return `
        <div class="heating-period-item">
            <span class="period-season" style="background: ${getStagioneColor(stagione)}">${stagione}</span>
            <span class="period-dates">${formatDate(p.start)} → ${endLabel}</span>
            <span style="color: var(--text-muted)">(${days} giorni)</span>
            <button class="btn-delete-period" data-idx="${heatingPeriods.indexOf(p)}">✕</button>
        </div>`;
    }).join('');

    // Delete handlers
    list.querySelectorAll('.btn-delete-period').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.idx);
            const deleted = heatingPeriods[idx];

            heatingPeriods.splice(idx, 1);
            storage.set('heatingPeriods', heatingPeriods);

            // Elimina da Firebase
            if (window.FirebaseService && window.FirebaseService.isInitialized()) {
                await window.FirebaseService.deleteHeatingPeriod(deleted.start);
            }

            renderHeatingPeriods();
            renderScatterChart();
            renderTable();
            showToast('Periodo eliminato');
        });
    });
};

// Add heating period handler
const addHeatingPeriodBtn = document.getElementById('btn-add-heating-period');
if (addHeatingPeriodBtn) {
    addHeatingPeriodBtn.addEventListener('click', async () => {
        const startInput = document.getElementById('heating-start-date');
        const endInput = document.getElementById('heating-end-date');

        if (!startInput.value || !endInput.value) {
            showToast('Inserisci entrambe le date', 'error');
            return;
        }

        if (new Date(startInput.value) > new Date(endInput.value)) {
            showToast('La data di accensione deve essere prima dello spegnimento', 'error');
            return;
        }

        const newPeriod = {
            start: startInput.value,
            end: endInput.value
        };
        heatingPeriods.push(newPeriod);

        storage.set('heatingPeriods', heatingPeriods);

        // Salva su Firebase
        if (window.FirebaseService && window.FirebaseService.isInitialized()) {
            await window.FirebaseService.saveHeatingPeriod(newPeriod);
        }
        startInput.value = '';
        endInput.value = '';
        renderHeatingPeriods();
        renderScatterChart();
        renderTable();
        showToast('Periodo aggiunto');
    });
}

// ==========================================
// Scatter Chart with Heating Bands
// ==========================================

let scatterChart = null;

const renderScatterChart = () => {
    const canvas = document.getElementById('chart-scatter-registro');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Destroy existing chart
    if (scatterChart) {
        scatterChart.destroy();
    }

    // Get all readings sorted by date
    const sortedLetture = [...letture].sort((a, b) => new Date(a.data) - new Date(b.data));

    if (sortedLetture.length === 0) {
        return;
    }

    // Calculate total consumption for each reading
    const data = sortedLetture.map(l => ({
        x: new Date(l.data),
        y: stanze.reduce((sum, s) => sum + (l[s] || 0), 0),
        heating: isInHeatingPeriod(l.data)
    }));

    // Build datasets - one for heating on, one for heating off
    const heatingOnData = data.filter(d => d.heating);
    const heatingOffData = data.filter(d => !d.heating);

    // Create annotation boxes for heating periods
    const annotations = {};

    heatingPeriods.forEach((period, idx) => {
        const stagione = getStagione(period.start);
        // Se end è null, il periodo è in corso - usa oggi come fine
        const endDate = period.end ? new Date(period.end) : new Date();
        annotations[`heating-${idx}`] = {
            type: 'box',
            xMin: new Date(period.start),
            xMax: endDate,
            backgroundColor: getStagioneColor(stagione) + '22',
            borderColor: getStagioneColor(stagione) + '88',
            borderWidth: 1,
            label: {
                display: true,
                content: stagione,
                position: { x: 'start', y: 'start' },
                color: getStagioneColor(stagione),
                font: { weight: 'bold', size: 10 },
                yAdjust: 8,
                xAdjust: 8
            }
        };
    });

    // Render season badges
    const badgesContainer = document.getElementById('scatter-season-badges');
    if (badgesContainer) {
        const uniqueSeasons = [...new Set(heatingPeriods.map(p => getStagione(p.start)))];
        badgesContainer.innerHTML = uniqueSeasons.map(s =>
            `<span class="season-badge" style="background: ${getStagioneColor(s)}">${s}</span>`
        ).join('');
    }

    scatterChart = new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Con Riscaldamento',
                    data: heatingOnData,
                    backgroundColor: '#22c55e',
                    borderColor: '#16a34a',
                    pointRadius: 6,
                    pointHoverRadius: 8
                },
                {
                    label: 'Senza Riscaldamento',
                    data: heatingOffData,
                    backgroundColor: '#ef4444',
                    borderColor: '#dc2626',
                    pointRadius: 6,
                    pointHoverRadius: 8
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    labels: { usePointStyle: true, padding: 16 }
                },
                annotation: {
                    annotations: annotations
                },
                tooltip: {
                    callbacks: {
                        title: (ctx) => formatDate(ctx[0].raw.x),
                        label: (ctx) => `Totale: ${ctx.raw.y.toFixed(1)}`
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'month',
                        displayFormats: { month: 'MMM yy' }
                    },
                    grid: { color: 'rgba(0,0,0,0.05)' }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Lettura Totale'
                    },
                    grid: { color: 'rgba(0,0,0,0.05)' }
                }
            }
        }
    });
};

// Initialize
const init = async () => {
    updateHeatingUI();
    let loadedFromFirebase = false;

    // 1. Prova a caricare da Firebase
    if (window.FirebaseService && window.FirebaseService.isInitialized()) {
        try {
            const fbData = await window.FirebaseService.getLetture();
            console.log('Firebase data:', fbData);
            if (fbData && fbData.length > 0) {
                letture = fbData;
                storage.set('letture', letture);
                loadedFromFirebase = true;
                showToast(`Caricate ${letture.length} letture da Firebase`);
            }

            const fbHeating = await window.FirebaseService.getHeatingPeriods();
            if (fbHeating && fbHeating.length > 0) {
                heatingPeriods = fbHeating;
                storage.set('heatingPeriods', heatingPeriods);
            }
        } catch (e) {
            console.warn('Errore caricamento Firebase:', e);
        }
    }

    // 2. Se Firebase fallisce o è vuoto, prova API server
    if (!loadedFromFirebase) {
        try {
            const response = await fetch(API_URL);
            if (response.ok) {
                const data = await response.json();
                if (data.length > 0) {
                    letture = data;
                    storage.set('letture', letture);
                    showToast(`Caricate ${letture.length} letture dal server`);
                }
            }
        } catch (e) {
            console.log('Server non disponibile, uso localStorage');
        }
    }

    // 3. Se ancora vuoto, usa dati inline/localStorage
    if (letture.length === 0) {
        // ... esistente ...
        if (typeof INITIAL_DATA !== 'undefined') {
            letture = INITIAL_DATA;
            storage.set('letture', letture);
            // Se Firebase è attivo ma vuoto, potremmo migrare i dati qui...
        }
    }

    // Carica periodi riscaldamento iniziali se vuoti
    if (heatingPeriods.length === 0 && typeof INITIAL_HEATING_PERIODS !== 'undefined') {
        heatingPeriods = INITIAL_HEATING_PERIODS;
        storage.set('heatingPeriods', heatingPeriods);
    }

    populateFilters();
    updateChart();
    updateWidgets();
    renderTable();
    renderHeatingPeriods();
    renderScatterChart();
    initDettaglio();
};

// ==========================================
// Dettaglio Section
// ==========================================
let dettaglioAnno = null;
let dettaglioMostraAssoluti = true;
let stimaChart = null;

const initDettaglio = () => {
    const select = document.getElementById('dettaglio-anno-select');
    const stagioni = getStagioni();

    select.innerHTML = stagioni.map(s => `<option value="${s}">${s}</option>`).join('');
    dettaglioAnno = stagioni[stagioni.length - 1]; // Default: most recent
    select.value = dettaglioAnno;

    renderDettaglio();
};

// Year selector change
document.getElementById('dettaglio-anno-select').addEventListener('change', (e) => {
    dettaglioAnno = e.target.value;
    renderDettaglio();
});

// Toggle buttons
document.getElementById('btn-valori-assoluti').addEventListener('click', () => {
    dettaglioMostraAssoluti = true;
    document.getElementById('btn-valori-assoluti').classList.add('active');
    document.getElementById('btn-differenze').classList.remove('active');
    renderDettaglio();
});

document.getElementById('btn-differenze').addEventListener('click', () => {
    dettaglioMostraAssoluti = false;
    document.getElementById('btn-differenze').classList.add('active');
    document.getElementById('btn-valori-assoluti').classList.remove('active');
    renderDettaglio();
});

const renderDettaglio = () => {
    if (!dettaglioAnno) return;

    const tbody = document.getElementById('dettaglio-table-body');
    const tfoot = document.getElementById('dettaglio-table-footer');

    // Filter readings for selected year
    const yearData = letture.filter(l => (l.stagione || getStagione(l.data)) === dettaglioAnno);
    const sorted = [...yearData].sort((a, b) => new Date(a.data) - new Date(b.data));

    if (sorted.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;">Nessuna lettura per questa stagione</td></tr>';
        tfoot.innerHTML = '';
        return;
    }

    // Calculate totals
    let totGiorni = 0;
    let totConsumo = { cucina: 0, soggiorno: 0, camera: 0, cameretta: 0, bagno: 0, totale: 0 };

    tbody.innerHTML = sorted.map((l, idx) => {
        const prev = idx > 0 ? sorted[idx - 1] : null;
        const giorni = prev ? Math.ceil((new Date(l.data) - new Date(prev.data)) / (1000 * 60 * 60 * 24)) : 0;

        let displayValues = {};
        if (dettaglioMostraAssoluti) {
            stanze.forEach(s => displayValues[s] = l[s] || 0);
            displayValues.totale = stanze.reduce((sum, s) => sum + (l[s] || 0), 0);
        } else {
            stanze.forEach(s => {
                const diff = prev ? (l[s] || 0) - (prev[s] || 0) : 0;
                displayValues[s] = diff;
                if (idx > 0) totConsumo[s] += diff;
            });
            displayValues.totale = stanze.reduce((sum, s) => sum + displayValues[s], 0);
            if (idx > 0) {
                totConsumo.totale += displayValues.totale;
                totGiorni += giorni;
            }
        }

        const media = (idx > 0 && giorni > 0 && !dettaglioMostraAssoluti) ? (displayValues.totale / giorni).toFixed(2) : '-';

        return `<tr>
            <td>${formatDate(l.data)}</td>
            <td>${idx > 0 ? giorni + 'g' : '-'}</td>
            <td>${displayValues.cucina.toFixed(1)}</td>
            <td>${displayValues.soggiorno.toFixed(1)}</td>
            <td>${displayValues.camera.toFixed(1)}</td>
            <td>${displayValues.cameretta.toFixed(1)}</td>
            <td>${displayValues.bagno.toFixed(1)}</td>
            <td><strong>${displayValues.totale.toFixed(1)}</strong></td>
            <td>${media}</td>
        </tr>`;
    }).join('');

    // Footer with totals (only for differences mode)
    if (!dettaglioMostraAssoluti && sorted.length > 1) {
        const mediaGiornaliera = totGiorni > 0 ? (totConsumo.totale / totGiorni).toFixed(2) : '-';
        tfoot.innerHTML = `<tr style="font-weight: bold; background: var(--bg-card-hover);">
            <td>TOTALE</td>
            <td>${totGiorni}g</td>
            <td>${totConsumo.cucina.toFixed(1)}</td>
            <td>${totConsumo.soggiorno.toFixed(1)}</td>
            <td>${totConsumo.camera.toFixed(1)}</td>
            <td>${totConsumo.cameretta.toFixed(1)}</td>
            <td>${totConsumo.bagno.toFixed(1)}</td>
            <td>${totConsumo.totale.toFixed(1)}</td>
            <td>${mediaGiornaliera}</td>
        </tr>`;
    } else {
        tfoot.innerHTML = '';
    }

    // Update daily estimation chart
    updateStimaChart(sorted);
};

const updateStimaChart = async (readings) => {
    const ctx = document.getElementById('chart-stima');
    if (!ctx) return;

    if (stimaChart) stimaChart.destroy();

    if (readings.length < 2) {
        document.getElementById('stima-media').textContent = '-';
        document.getElementById('stima-max').textContent = '-';
        document.getElementById('stima-totale').textContent = '-';
        document.getElementById('stima-info').textContent = 'Dati insufficienti';
        return;
    }

    const sorted = [...readings].sort((a, b) => new Date(a.data) - new Date(b.data));

    // Try to fetch temperature data for weighted interpolation
    let temps = null;
    const anno = sorted[0].stagione || getStagione(sorted[0].data);

    try {
        temps = await fetchTemperatures(anno);
    } catch (e) {
        console.log('Temperature non disponibili, uso interpolazione lineare');
    }

    const dailyData = [];
    const useWeighted = temps && temps.time && temps.temperature_2m_mean;

    document.getElementById('stima-info').textContent = useWeighted
        ? 'Interpolazione pesata su temperatura'
        : 'Interpolazione lineare tra letture';

    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const curr = sorted[i];
        const prevDate = new Date(prev.data);
        const currDate = new Date(curr.data);
        const days = Math.ceil((currDate - prevDate) / (1000 * 60 * 60 * 24));

        if (days <= 0) continue;

        const totalPrev = stanze.reduce((sum, s) => sum + (prev[s] || 0), 0);
        const totalCurr = stanze.reduce((sum, s) => sum + (curr[s] || 0), 0);
        const totalDiff = totalCurr - totalPrev;

        if (useWeighted && totalDiff > 0) {
            // Temperature-weighted interpolation
            // Collect temperatures for each day in the period
            const dayTemps = [];
            for (let d = 0; d < days; d++) {
                const date = new Date(prevDate);
                date.setDate(date.getDate() + d);
                const dateStr = date.toISOString().split('T')[0];

                const tempIdx = temps.time.indexOf(dateStr);
                let temp = tempIdx >= 0 ? temps.temperature_2m_mean[tempIdx] : null;

                // Fallback: find closest date
                if (temp === null) {
                    for (let offset = 1; offset <= 3; offset++) {
                        const before = new Date(date);
                        before.setDate(before.getDate() - offset);
                        const after = new Date(date);
                        after.setDate(after.getDate() + offset);

                        const beforeIdx = temps.time.indexOf(before.toISOString().split('T')[0]);
                        const afterIdx = temps.time.indexOf(after.toISOString().split('T')[0]);

                        if (beforeIdx >= 0 && temps.temperature_2m_mean[beforeIdx] !== null) {
                            temp = temps.temperature_2m_mean[beforeIdx];
                            break;
                        }
                        if (afterIdx >= 0 && temps.temperature_2m_mean[afterIdx] !== null) {
                            temp = temps.temperature_2m_mean[afterIdx];
                            break;
                        }
                    }
                }

                dayTemps.push({
                    date: dateStr,
                    label: date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' }),
                    temp: temp !== null ? temp : 10, // Default 10°C if unknown
                    isReading: d === days - 1
                });
            }

            // Calculate weights inversely proportional to temperature
            // Lower temp = higher weight = more consumption
            // Using formula: weight = max(0, 20 - temp) where 20°C is "no heating" threshold
            const weights = dayTemps.map(d => Math.max(0.1, 20 - d.temp));
            const totalWeight = weights.reduce((s, w) => s + w, 0);

            // Distribute consumption based on weights
            dayTemps.forEach((d, idx) => {
                const proportion = weights[idx] / totalWeight;
                dailyData.push({
                    ...d,
                    value: totalDiff * proportion,
                    weight: weights[idx]
                });
            });
        } else {
            // Linear interpolation (fallback)
            const dailyRate = totalDiff / days;

            for (let d = 0; d < days; d++) {
                const date = new Date(prevDate);
                date.setDate(date.getDate() + d);
                dailyData.push({
                    date: date.toISOString().split('T')[0],
                    label: date.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' }),
                    value: dailyRate,
                    isReading: d === days - 1
                });
            }
        }
    }

    if (dailyData.length === 0) return;

    // Calculate stats
    const values = dailyData.map(d => d.value).filter(v => v > 0);
    const total = values.reduce((s, v) => s + v, 0);
    const avg = values.length > 0 ? total / values.length : 0;
    const max = values.length > 0 ? Math.max(...values) : 0;
    const maxEntry = dailyData.find(d => d.value === max);

    document.getElementById('stima-media').textContent = avg.toFixed(2);
    document.getElementById('stima-max').textContent = max > 0 ? `${max.toFixed(1)} (${maxEntry?.label || '-'})` : '-';
    document.getElementById('stima-totale').textContent = total.toFixed(1);

    // Show all days (no sampling)

    stimaChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: dailyData.map(d => d.label),
            datasets: [{
                label: 'Consumo Giornaliero Stimato',
                data: dailyData.map(d => d.value),
                backgroundColor: dailyData.map(d => {
                    if (d.isReading) return 'rgba(232, 103, 60, 1)';
                    // Color intensity based on value
                    const intensity = Math.min(0.9, 0.3 + (d.value / (max || 1)) * 0.6);
                    return `rgba(232, 103, 60, ${intensity})`;
                }),
                borderColor: '#e8673c',
                borderWidth: 0.5,
                barPercentage: 1.0,
                categoryPercentage: 1.0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const d = dailyData[ctx.dataIndex];
                            let label = `${ctx.parsed.y.toFixed(2)} unità`;
                            if (d.temp !== undefined) {
                                label += ` @ ${d.temp.toFixed(1)}°C`;
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Consumo/giorno' }
                },
                x: {
                    grid: { display: false },
                    ticks: { maxRotation: 45, maxTicksLimit: 30 }
                }
            }
        }
    });
};

document.addEventListener('DOMContentLoaded', init);

