// ==========================================
// Charts — componenti D3 in stile editoriale (NYT):
// una serie protagonista in colore, il contesto in grigio, etichette dirette,
// griglie a filo, annotazioni con linee guida. Nessun doppio asse.
// ==========================================

const Charts = (() => {
    const A = window.Analytics;
    const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const fmt = d3.format(',.0f');
    const fmt1 = d3.format(',.1f');
    const fmt2 = d3.format(',.2f');
    const pct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}%`;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const shortDate = (s) => { const d = A.parseYMD(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
    const longDate = (s) => { const d = A.parseYMD(s); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
    const roomColor = (k) => css(`--room-${A.ROOMS.indexOf(k) + 1}`);

    // ---------- Montaggio responsivo ----------
    const registry = new Set();
    const mount = (el, draw) => {
        if (!el) return;
        el.__draw = draw;
        el.__w = 0;
        registry.add(el);
        const run = (force) => {
            const w = Math.floor(el.clientWidth);
            if (!w || (!force && w === el.__w)) return;
            el.__w = w;
            el.innerHTML = '';
            el.__draw(w);
        };
        if (!el.__ro) {
            el.__ro = new ResizeObserver(() => {
                cancelAnimationFrame(el.__raf);
                el.__raf = requestAnimationFrame(() => run(false));
            });
            el.__ro.observe(el);
        }
        run(true);
    };
    const redrawAll = () => registry.forEach(el => {
        if (!el.isConnected) { el.__ro?.disconnect(); registry.delete(el); return; }
        if (!el.clientWidth) { el.__w = 0; return; }
        el.innerHTML = '';
        el.__w = Math.floor(el.clientWidth);
        el.__draw(el.__w);
    });

    // ---------- Tooltip condiviso ----------
    const tip = (() => {
        let node;
        const ensure = () => {
            if (!node) { node = document.createElement('div'); node.className = 'viz-tip'; document.body.appendChild(node); }
            return node;
        };
        return {
            show(html, event) {
                const n = ensure();
                n.innerHTML = html;
                n.classList.add('show');
                const pad = 14, r = n.getBoundingClientRect();
                let x = event.clientX + pad, y = event.clientY + pad;
                if (x + r.width > window.innerWidth - 8) x = event.clientX - r.width - pad;
                if (y + r.height > window.innerHeight - 8) y = event.clientY - r.height - pad;
                n.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
            },
            hide() { if (node) node.classList.remove('show'); }
        };
    })();

    const svgFor = (el, w, h) => d3.select(el).append('svg')
        .attr('width', w).attr('height', h).attr('viewBox', `0 0 ${w} ${h}`)
        .attr('class', 'viz').attr('role', 'img');

    // Griglia orizzontale NYT: etichette sopra la linea, a sinistra; unità sull'ultima tacca
    const yGrid = (g, y, x0, x1, { ticks = 5, format = fmt, unit = '' } = {}) => {
        const t = y.ticks(ticks);
        g.selectAll('line.grid').data(t).join('line')
            .attr('class', d => d === 0 ? 'grid base' : 'grid')
            .attr('x1', x0).attr('x2', x1).attr('y1', d => Math.round(y(d)) + 0.5).attr('y2', d => Math.round(y(d)) + 0.5);
        g.selectAll('text.tick').data(t).join('text')
            .attr('class', 'tick').attr('x', x0).attr('y', d => y(d) - 5)
            .text((d, i) => format(d) + (unit && i === t.length - 1 ? ` ${unit}` : ''));
    };

    // Asse mesi su scala "giorno della stagione" (0 = 1 agosto)
    const monthTicks = (key, d0, d1) => {
        const out = [];
        const start = A.seasonStart(key);
        for (let m = 0; m < 13; m++) {
            const date = new Date(start.getFullYear(), start.getMonth() + m, 1);
            const day = A.daysBetween(start, date);
            if (day >= d0 && day <= d1) out.push({ day, label: MONTHS[date.getMonth()] });
        }
        return out;
    };
    const xMonths = (g, x, key, y0, d0, d1, { every = 1 } = {}) => {
        const t = monthTicks(key, d0, d1).filter((_, i) => i % every === 0);
        g.selectAll('line').data(t).join('line').attr('class', 'xtick')
            .attr('x1', d => x(d.day)).attr('x2', d => x(d.day)).attr('y1', y0).attr('y2', y0 + 5);
        g.selectAll('text').data(t).join('text').attr('class', 'tick xlabel')
            .attr('x', d => x(d.day) + 3).attr('y', y0 + 17).text(d => d.label);
    };

    // Evita sovrapposizioni tra etichette (posizioni verticali), mantenendo l'ordine
    const dodge = (items, minGap, lo, hi) => {
        const s = items.slice().sort((a, b) => a.y - b.y);
        s.forEach((d, i) => { d.ly = i ? Math.max(d.y, s[i - 1].ly + minGap) : Math.max(d.y, lo); });
        for (let i = s.length - 1; i >= 0; i--) {
            const max = i === s.length - 1 ? hi : s[i + 1].ly - minGap;
            if (s[i].ly > max) s[i].ly = max;
        }
        return s;
    };

    // ==========================================
    // 1. La corsa delle stagioni — consumo cumulato
    // ==========================================
    const seasonRace = (el, { seasons, latest, pace, note = null, height = 380 }) => mount(el, (w) => {
        const narrow = w < 560;
        const m = { top: 24, right: narrow ? 58 : 96, bottom: 28, left: 0 };
        const h = height;
        const iw = w - m.left - m.right, ih = h - m.top - m.bottom;
        const D0 = 31, D1 = 304; // 1 set → 1 giu
        const x = d3.scaleLinear().domain([D0, D1]).range([0, iw]);
        const yMax = d3.max(seasons, s => Math.max(s.final, pace?.projection?.high || 0)) || 1;
        const y = d3.scaleLinear().domain([0, yMax * 1.05]).nice().range([ih, 0]);

        const svg = svgFor(el, w, h);
        svg.attr('aria-label', 'Cumulative heat units by day of season, one line per season');
        const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
        yGrid(g.append('g'), y, 0, iw, { unit: 'units' });
        xMonths(g.append('g'), x, latest.key, ih, D0, D1);

        // Serie: punti reali, agganciati ai bordi del dominio
        const seriesOf = (s) => {
            const pts = s.points.filter(p => p.day > D0 && p.day < D1).map(p => ({ day: p.day, v: p.total }));
            const v0 = A.valueAtDay(s, D0);
            if (v0 != null && s.points[0].day <= D0) pts.unshift({ day: D0, v: v0 });
            if (s.complete) pts.push({ day: D1, v: A.valueAtDay(s, D1) ?? s.final });
            return pts;
        };
        const line = d3.line().x(d => x(d.day)).y(d => y(d.v)).curve(d3.curveMonotoneX);
        const others = seasons.filter(s => s.key !== latest.key && s.complete);
        const lines = g.append('g');
        const otherPaths = lines.selectAll('path.ctx').data(others).join('path')
            .attr('class', 'line ctx').attr('d', s => line(seriesOf(s)));

        // Proiezione (solo stagione in corso, non ferma)
        if (pace?.projection && !latest.stale) {
            const endDay = d3.median(others.map(s => Math.min(D1, s.lastDay))) || 270;
            const lx = x(latest.lastDay), ly = y(latest.final);
            g.append('path').attr('class', 'proj-band')
                .attr('d', `M${lx},${ly}L${x(endDay)},${y(pace.projection.high)}L${x(endDay)},${y(pace.projection.low)}Z`);
            g.append('line').attr('class', 'line proj')
                .attr('x1', lx).attr('y1', ly).attr('x2', x(endDay)).attr('y2', y(pace.projection.mid));
            g.append('text').attr('class', 'annot').attr('x', x(endDay) - 4).attr('y', y(pace.projection.high) - 8)
                .attr('text-anchor', 'end').text(`Projected ≈ ${fmt(pace.projection.mid)}`);
        }

        const latestPts = seriesOf(latest);
        const latestPath = lines.append('path').attr('class', 'line hero').attr('d', line(latestPts));
        const lastP = latestPts[latestPts.length - 1] || { day: latest.lastDay, v: latest.final };
        g.append('circle').attr('class', 'dot hero').attr('r', 5).attr('cx', x(lastP.day)).attr('cy', y(lastP.v));

        // Annotazione sulla stagione protagonista (personalizzabile con `note`: { day, lines })
        const annotate = (day, v, l1, l2) => {
            const ax = x(day), ay = y(v);
            const leftSide = ax > iw * 0.55;
            const tx = leftSide ? ax - 14 : ax + 14;
            const ty = Math.max(14, ay - 54);
            g.append('path').attr('class', 'leader').attr('d', `M${ax},${ay - 8}L${ax},${ty + 6}`);
            const t = g.append('text').attr('class', 'annot').attr('x', tx).attr('y', ty).attr('text-anchor', leftSide ? 'end' : 'start');
            t.append('tspan').attr('class', 'annot-strong').text(l1);
            if (l2) t.append('tspan').attr('x', tx).attr('dy', 16).text(l2);
        };
        if (note) {
            const v = A.valueAtDay(latest, note.day);
            if (v != null) {
                g.append('circle').attr('class', 'dot hero').attr('r', 4).attr('cx', x(note.day)).attr('cy', y(v));
                annotate(note.day, v, note.lines[0], note.lines[1]);
            }
        } else if (pace && pace.delta != null) {
            const ax = x(lastP.day), ay = y(lastP.v);
            const leftSide = ax > iw * 0.55;
            const tx = leftSide ? ax - 14 : ax + 14;
            const ty = Math.max(14, ay - 54);
            g.append('path').attr('class', 'leader').attr('d', `M${ax},${ay - 8}L${ax},${ty + 6}`);
            const t = g.append('text').attr('class', 'annot').attr('x', tx).attr('y', ty)
                .attr('text-anchor', leftSide ? 'end' : 'start');
            t.append('tspan').attr('class', 'annot-strong').text(`${latest.key}: ${fmt(latest.final)} units by ${shortDate(latest.lastDate)}`);
            t.append('tspan').attr('x', tx).attr('dy', 16).text(`${pct(pace.delta)} vs. the average of ${pace.count} winters`);
        }

        // Etichette finali con linee guida
        const labelItems = (latest.complete ? [...others, latest] : others).map(s => ({ s, y: y(s.final), text: s.key, val: fmt(s.final) }));
        const placed = dodge(labelItems, 14, 6, ih - 4);
        const lg = g.append('g').attr('class', 'end-labels');
        placed.forEach(d => {
            lg.append('path').attr('class', 'leader faint').attr('d', `M${iw + 3},${d.y}L${iw + 10},${d.ly}`);
            const t = lg.append('text').attr('class', `end-label ${d.s === latest ? 'emph' : ''}`).attr('x', iw + 13).attr('y', d.ly + 4).attr('data-key', d.s.key);
            t.append('tspan').text(d.text);
            if (!narrow) t.append('tspan').attr('class', 'muted').attr('dx', 6).text(d.val);
        });

        // Hover: righello verticale, serie più vicina evidenziata, tooltip con classifica
        const rule = g.append('line').attr('class', 'rule').attr('y1', 0).attr('y2', ih).style('opacity', 0);
        const focus = g.append('circle').attr('class', 'dot focus').attr('r', 4).style('opacity', 0);
        g.append('rect').attr('width', iw).attr('height', ih).attr('fill', 'transparent')
            .on('pointermove', (ev) => {
                const [px, py] = d3.pointer(ev);
                const day = Math.round(x.invert(px));
                const date = A.ymd(A.addDays(A.seasonStart(latest.key), day));
                const rows = [...others, latest].map(s => ({ s, v: A.valueAtDay(s, day) })).filter(r => r.v != null)
                    .sort((a, b) => b.v - a.v);
                const near = rows.reduce((best, r) => !best || Math.abs(y(r.v) - py) < Math.abs(y(best.v) - py) ? r : best, null);
                rule.attr('x1', px).attr('x2', px).style('opacity', 1);
                otherPaths.classed('emph', s => near && s === near.s);
                lg.selectAll('text').classed('emph', function () { return this.dataset.key === latest.key || (near && this.dataset.key === near.s.key); });
                if (near) focus.attr('cx', px).attr('cy', y(near.v)).style('opacity', 1).classed('hero', near.s === latest);
                tip.show(`<div class="tip-title">${shortDate(date)}</div>` + rows.map(r =>
                    `<div class="tip-row ${r.s === latest ? 'is-hero' : ''} ${near && r.s === near.s ? 'is-near' : ''}"><span class="tip-key"><i style="background:${r.s === latest ? css('--accent') : css('--context-strong')}"></i>${r.s.key}</span><b>${fmt(r.v)}</b></div>`).join(''), ev);
            })
            .on('pointerleave', () => {
                rule.style('opacity', 0); focus.style('opacity', 0); tip.hide();
                otherPaths.classed('emph', false);
                lg.selectAll('text').classed('emph', function () { return this.dataset.key === latest.key; });
            });
        latestPath.raise();
    });

    // ==========================================
    // 2. Barre stagioni (misurato / corretto per il clima)
    // ==========================================
    const seasonBars = (el, { seasons, latestComplete, mode = 'measured' }) => mount(el, (w) => {
        const rows = seasons.filter(s => mode === 'measured' ? true : s.adjusted != null);
        const valueOf = (s) => mode === 'measured' ? s.final : s.adjusted;
        const rowH = 30, m = { top: 6, right: 64, bottom: 6, left: 64 };
        const h = m.top + m.bottom + rows.length * rowH;
        const iw = w - m.left - m.right;
        const x = d3.scaleLinear().domain([0, d3.max(seasons, s => Math.max(s.final, s.adjusted || 0))]).nice().range([0, iw]);
        const svg = svgFor(el, w, h).attr('aria-label', `Season totals, ${mode}`);
        const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
        const avg = d3.mean(rows.filter(s => s.complete), valueOf);
        const r = g.selectAll('g.row').data(rows).join('g').attr('class', 'row')
            .attr('transform', (_, i) => `translate(0,${i * rowH})`);
        r.append('text').attr('class', 'row-label').attr('x', -12).attr('y', rowH / 2 + 4).attr('text-anchor', 'end')
            .text(s => s.key);
        r.append('rect').attr('class', 'track').attr('x', 0).attr('y', rowH / 2 - 5).attr('width', iw).attr('height', 10).attr('rx', 5);
        r.append('path').attr('class', s => `bar ${s.key === latestComplete?.key ? 'hero' : ''} ${!s.complete ? 'partial' : ''}`)
            .attr('d', s => {
                const bw = Math.max(2, x(valueOf(s))), y0 = rowH / 2 - 5, rr = 5;
                return `M0,${y0}H${bw - rr}a${rr},${rr} 0 0 1 ${rr},${rr}a${rr},${rr} 0 0 1 -${rr},${rr}H0Z`;
            });
        r.append('text').attr('class', 'bar-value').attr('x', s => x(valueOf(s)) + 8).attr('y', rowH / 2 + 4)
            .text(s => fmt(valueOf(s)) + (s.complete ? '' : ' so far'));
        if (avg) {
            g.append('line').attr('class', 'avg-rule').attr('x1', x(avg)).attr('x2', x(avg)).attr('y1', -2).attr('y2', rows.length * rowH);
            g.append('text').attr('class', 'tick').attr('x', x(avg) + 4).attr('y', rows.length * rowH + 2).text('avg');
        }
        r.append('rect').attr('x', -m.left).attr('width', w).attr('height', rowH).attr('fill', 'transparent')
            .on('pointermove', (ev, s) => tip.show(`<div class="tip-title">Season ${s.key}${s.complete ? '' : ' (partial)'}</div>
                <div class="tip-row"><span>Measured</span><b>${fmt(s.final)}</b></div>
                ${s.adjusted ? `<div class="tip-row"><span>Weather-adjusted</span><b>${fmt(s.adjusted)}</b></div>` : ''}
                ${s.hdd ? `<div class="tip-row"><span>Degree-days</span><b>${fmt(s.hdd)}</b></div>` : ''}
                <div class="tip-row"><span>Heating days</span><b>${s.heatingDays}</b></div>`, ev))
            .on('pointerleave', tip.hide);
    });

    // ==========================================
    // 3. Dumbbell — misurato → corretto per il clima
    // ==========================================
    const dumbbell = (el, { seasons }) => mount(el, (w) => {
        const rows = seasons.filter(s => s.adjusted != null);
        if (!rows.length) { el.innerHTML = '<p class="viz-empty">Weather data not available yet.</p>'; return; }
        const rowH = 38, m = { top: 30, right: 24, bottom: 8, left: 56 };
        const h = m.top + m.bottom + rows.length * rowH;
        const iw = w - m.left - m.right;
        const lo = d3.min(rows, s => Math.min(s.final, s.adjusted)), hi = d3.max(rows, s => Math.max(s.final, s.adjusted));
        const x = d3.scaleLinear().domain([lo * 0.9, hi * 1.04]).nice().range([0, iw]);
        const svg = svgFor(el, w, h).attr('aria-label', 'Measured vs weather-adjusted season totals');
        const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
        const ticks = x.ticks(w < 500 ? 4 : 6);
        g.selectAll('line.v').data(ticks).join('line').attr('class', 'grid')
            .attr('x1', x).attr('x2', x).attr('y1', -8).attr('y2', rows.length * rowH);
        g.selectAll('text.t').data(ticks).join('text').attr('class', 'tick').attr('x', d => x(d)).attr('y', -14)
            .attr('text-anchor', 'middle').text(fmt);
        const avgAdj = d3.mean(rows, s => s.adjusted);
        const best = rows.reduce((a, b) => a.adjusted < b.adjusted ? a : b);
        const r = g.selectAll('g.row').data(rows).join('g').attr('transform', (_, i) => `translate(0,${i * rowH + rowH / 2})`);
        r.append('text').attr('class', 'row-label').attr('x', -14).attr('y', 4).attr('text-anchor', 'end').text(s => s.key);
        r.append('line').attr('class', 'db-line').attr('x1', s => x(s.final)).attr('x2', s => x(s.adjusted));
        r.append('circle').attr('class', 'db-measured').attr('r', 5).attr('cx', s => x(s.final));
        r.append('circle').attr('class', s => `db-adjusted ${s.adjusted > avgAdj ? 'over' : 'under'}`).attr('r', 6).attr('cx', s => x(s.adjusted));
        r.append('text').attr('class', 'bar-value')
            .attr('x', s => x(s.adjusted) + (s.adjusted >= s.final ? 12 : -12))
            .attr('text-anchor', s => s.adjusted >= s.final ? 'start' : 'end').attr('y', 4)
            .text(s => fmt(s.adjusted) + (s === best ? '  · most efficient' : ''));
        r.append('rect').attr('x', -m.left).attr('y', -rowH / 2).attr('width', w).attr('height', rowH).attr('fill', 'transparent')
            .on('pointermove', (ev, s) => tip.show(`<div class="tip-title">Season ${s.key}</div>
                <div class="tip-row"><span>Measured</span><b>${fmt(s.final)}</b></div>
                <div class="tip-row"><span>Degree-days</span><b>${fmt(s.hdd)}</b></div>
                <div class="tip-row"><span>Units per degree-day</span><b>${fmt2(s.perHdd)}</b></div>
                <div class="tip-row is-hero"><span>At an average winter</span><b>${fmt(s.adjusted)}</b></div>`, ev))
            .on('pointerleave', tip.hide);
    });

    // ==========================================
    // 4. Scatter con etichette dirette e retta di regressione
    // ==========================================
    const labeledScatter = (el, { points, xKey, yKey, label, xLabel, yLabel, xFormat = fmt, yFormat = fmt, hero, fitLabel, tipHtml, height = 340, zeroNote }) => mount(el, (w) => {
        const m = { top: 28, right: 22, bottom: 40, left: 8 };
        const h = height, iw = w - m.left - m.right, ih = h - m.top - m.bottom;
        const xs = points.map(p => p[xKey]), ys = points.map(p => p[yKey]);
        const xPad = (d3.max(xs) - d3.min(xs)) * 0.08 || 1;
        const fit = A.linearFit(points, xKey, yKey);
        let xDom = [d3.min(xs) - xPad, d3.max(xs) + xPad];
        if (zeroNote && fit?.zero != null && fit.zero > xDom[1] && fit.zero < xDom[1] + 8) xDom[1] = fit.zero + 1;
        const x = d3.scaleLinear().domain(xDom).nice().range([0, iw]);
        const y = d3.scaleLinear().domain([Math.min(0, d3.min(ys)), d3.max(ys) * 1.1]).nice().range([ih, 0]);
        const svg = svgFor(el, w, h).attr('aria-label', `${yLabel} against ${xLabel}`);
        const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
        yGrid(g.append('g'), y, 0, iw, { format: yFormat, unit: yLabel });
        const xt = x.ticks(w < 500 ? 4 : 7);
        g.selectAll('text.xt').data(xt).join('text').attr('class', 'tick').attr('x', x).attr('y', ih + 18)
            .attr('text-anchor', 'middle').text(xFormat);
        g.append('text').attr('class', 'axis-title').attr('x', iw).attr('y', ih + 36).attr('text-anchor', 'end').text(`${xLabel} →`);

        if (fit) {
            const [a, b] = x.domain();
            const ya = Math.max(y.domain()[0], Math.min(y.domain()[1], fit.at(a)));
            const xa = fit.at(a) > y.domain()[1] ? (y.domain()[1] - fit.intercept) / fit.slope : a;
            const xb = zeroNote && fit.zero != null && fit.zero < b ? fit.zero : b;
            g.append('line').attr('class', 'fit').attr('x1', x(xa)).attr('y1', y(fit.at(xa))).attr('x2', x(xb)).attr('y2', y(fit.at(xb)));
            if (fitLabel) {
                const fx = x(a + (b - a) * 0.66), fy = y(fit.at(a + (b - a) * 0.66));
                g.append('text').attr('class', 'annot').attr('x', fx + 8).attr('y', fy - 10).text(fitLabel(fit));
            }
            if (zeroNote && fit.zero != null && fit.zero > a && fit.zero <= b + 0.01) {
                const zx = x(fit.zero);
                g.append('circle').attr('class', 'dot ink').attr('r', 4).attr('cx', zx).attr('cy', y(0));
                g.append('path').attr('class', 'leader').attr('d', `M${zx},${y(0) - 7}L${zx},${y(0) - 46}`);
                g.append('text').attr('class', 'annot').attr('x', zx - 6).attr('y', y(0) - 52).attr('text-anchor', 'end')
                    .append('tspan').attr('class', 'annot-strong').text(zeroNote(fit));
            }
        }

        const dots = g.append('g');
        const sorted = points.slice().sort((p, q) => (hero && hero(p) ? 1 : 0) - (hero && hero(q) ? 1 : 0));
        dots.selectAll('circle').data(sorted).join('circle')
            .attr('class', p => `dot ${hero && hero(p) ? 'hero' : 'ctx'}`)
            .attr('r', p => hero && hero(p) ? 5.5 : 4.5)
            .attr('cx', p => x(p[xKey])).attr('cy', p => y(p[yKey]));
        if (label) {
            const items = points.filter(p => label(p)).map(p => ({ p, y: y(p[yKey]) }));
            items.forEach(d => {
                g.append('text').attr('class', `point-label ${hero && hero(d.p) ? 'strong' : ''}`)
                    .attr('x', x(d.p[xKey]) + 9).attr('y', d.y + 4).text(label(d.p));
            });
        }
        // Voronoi per hover sul punto più vicino
        const delaunay = d3.Delaunay.from(points, p => x(p[xKey]), p => y(p[yKey]));
        const ring = g.append('circle').attr('class', 'hover-ring').attr('r', 9).style('opacity', 0);
        g.append('rect').attr('width', iw).attr('height', ih).attr('fill', 'transparent')
            .on('pointermove', (ev) => {
                const [px, py] = d3.pointer(ev);
                const i = delaunay.find(px, py);
                const p = points[i];
                if (!p || Math.hypot(x(p[xKey]) - px, y(p[yKey]) - py) > 40) { ring.style('opacity', 0); tip.hide(); return; }
                ring.attr('cx', x(p[xKey])).attr('cy', y(p[yKey])).style('opacity', 1);
                tip.show(tipHtml(p), ev);
            })
            .on('pointerleave', () => { ring.style('opacity', 0); tip.hide(); });
    });

    // ==========================================
    // 5. Gantt dei periodi di riscaldamento
    // ==========================================
    const heatingGantt = (el, { seasons, latestKey }) => mount(el, (w) => {
        const rows = seasons.filter(s => s.periods.length);
        const rowH = 34, m = { top: 8, right: w < 520 ? 52 : 80, bottom: 26, left: 56 };
        const h = m.top + m.bottom + rows.length * rowH;
        const iw = w - m.left - m.right;
        const D0 = 31, D1 = 334;
        const x = d3.scaleLinear().domain([D0, D1]).range([0, iw]).clamp(true);
        const svg = svgFor(el, w, h).attr('aria-label', 'Heating periods by season');
        const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
        const mt = monthTicks(rows[0]?.key || latestKey, D0, D1);
        g.selectAll('line.m').data(mt).join('line').attr('class', 'grid').attr('x1', d => x(d.day)).attr('x2', d => x(d.day))
            .attr('y1', 0).attr('y2', rows.length * rowH);
        xMonths(g.append('g'), x, rows[0]?.key || latestKey, rows.length * rowH, D0, D1, { every: w < 520 ? 2 : 1 });

        const r = g.selectAll('g.row').data(rows).join('g').attr('transform', (_, i) => `translate(0,${i * rowH + rowH / 2})`);
        r.append('text').attr('class', s => `row-label ${s.key === latestKey ? 'strong' : ''}`).attr('x', -14).attr('y', 4).attr('text-anchor', 'end').text(s => s.key);
        r.each(function (s) {
            const row = d3.select(this);
            s.periods.forEach(p => {
                const a = x(A.dayOfSeason(p.start, s.key));
                const b = x(A.dayOfSeason(A.ymd(A.periodEnd(p)), s.key));
                // Spegnimento non registrato: pieno fino all'ultima lettura, poi sbiadito
                const unknownEnd = !p.end && !A.isPeriodOpen(p);
                const solidEnd = unknownEnd ? Math.min(b, Math.max(a, x(s.lastDay))) : b;
                if (unknownEnd && b > solidEnd) {
                    row.append('rect').attr('class', `gantt-bar unknown ${s.key === latestKey ? 'hero' : ''}`)
                        .attr('x', a).attr('y', -6).attr('width', Math.max(4, b - a)).attr('height', 12).attr('rx', 6);
                }
                row.append('rect').attr('class', `gantt-bar ${s.key === latestKey ? 'hero' : ''} ${A.isPeriodOpen(p) ? 'open' : ''}`)
                    .attr('x', a).attr('y', -6).attr('width', Math.max(4, solidEnd - a)).attr('height', 12).attr('rx', 6)
                    .on('pointermove', (ev) => tip.show(`<div class="tip-title">Season ${s.key}</div>
                        <div class="tip-row"><span>On</span><b>${longDate(p.start)}</b></div>
                        <div class="tip-row"><span>Off</span><b>${p.end ? longDate(p.end) : 'not recorded'}</b></div>
                        <div class="tip-row"><span>Days</span><b>${A.daysBetween(p.start, A.periodEnd(p)) + 1}</b></div>`, ev))
                    .on('pointerleave', tip.hide);
            });
            // Letture come puntini sul binario
            row.selectAll('circle.rd').data(s.points.filter(p => p.day >= D0 && p.day <= D1)).join('circle')
                .attr('class', 'gantt-reading').attr('r', 2).attr('cx', p => x(p.day)).attr('cy', 0);
            const days = s.periods.reduce((t, p) => t + A.daysBetween(p.start, A.periodEnd(p)) + 1, 0);
            const open = s.periods.some(A.isPeriodOpen);
            const unknown = s.periods.some(p => !p.end && !A.isPeriodOpen(p));
            row.append('text').attr('class', 'bar-value').attr('x', iw + 10).attr('y', 4)
                .text(unknown ? 'off date ?' : `${days} d${open ? ' · on' : ''}`);
        });
    });

    // ==========================================
    // 6. Quote per stanza — barre 100% impilate
    // ==========================================
    const roomShare = (el, { seasons, latestKey }) => mount(el, (w) => {
        const rows = seasons.filter(s => s.final > 0);
        const rowH = 32, m = { top: 4, right: 8, bottom: 4, left: 92 };
        const h = m.top + m.bottom + rows.length * rowH;
        const iw = w - m.left - m.right;
        const svg = svgFor(el, w, h).attr('aria-label', 'Share of heat by room, per season');
        const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
        const GAP = 2;
        const r = g.selectAll('g.row').data(rows).join('g').attr('transform', (_, i) => `translate(0,${i * rowH})`);
        r.append('text').attr('class', s => `row-label ${s.key === latestKey ? 'strong' : ''}`).attr('x', -12).attr('y', rowH / 2 + 4).attr('text-anchor', 'end')
            .text(s => s.complete ? s.key : `${s.key} so far`);
        r.each(function (s) {
            const row = d3.select(this);
            let acc = 0;
            const usable = iw - GAP * (A.ROOMS.length - 1);
            A.ROOMS.forEach((k, i) => {
                const share = s.finalRooms[k] / s.final;
                const bw = usable * share;
                const x0 = acc;
                acc += bw + GAP;
                if (bw <= 0) return;
                const fill = roomColor(k);
                row.append('rect').attr('x', x0).attr('y', 6).attr('width', bw).attr('height', rowH - 12)
                    .attr('rx', bw > 8 ? 4 : 1).attr('fill', fill).attr('class', 'share-seg')
                    .on('pointermove', (ev) => tip.show(`<div class="tip-title">${A.ROOM_LABELS[k]} · ${s.key}</div>
                        <div class="tip-row"><span>Share</span><b>${Math.round(share * 100)}%</b></div>
                        <div class="tip-row"><span>Units</span><b>${fmt(s.finalRooms[k])}</b></div>`, ev))
                    .on('pointerleave', tip.hide);
                const label = `${Math.round(share * 100)}%`;
                if (bw > 38) {
                    // Testo dentro il colore: bianco o inchiostro in base alla luminosità del riempimento
                    row.append('text').attr('class', 'seg-label').attr('x', x0 + 8).attr('y', rowH / 2 + 4)
                        .style('fill', d3.lab(fill).l > 66 ? '#1d1d1f' : '#ffffff').text(label);
                }
            });
        });
    });

    // ==========================================
    // 7. Small multiples — una stanza per pannello
    // ==========================================
    const roomMultiples = (el, { seasons, latestKey }) => {
        el.innerHTML = '';
        const complete = seasons.filter(s => s.complete);
        const maxV = d3.max(complete, s => d3.max(A.ROOMS, k => s.finalRooms[k])) || 1;
        A.ROOMS.forEach(k => {
            const panel = document.createElement('div');
            panel.className = 'multiple';
            const latest = complete.find(s => s.key === latestKey) || complete[complete.length - 1];
            const others = complete.filter(s => s !== latest);
            const avg = d3.mean(others, s => s.finalRooms[k]);
            const delta = latest && avg ? latest.finalRooms[k] / avg - 1 : null;
            panel.innerHTML = `<div class="multiple-head">
                    <span class="swatch" style="background:${roomColor(k)}"></span>
                    <span class="multiple-name">${A.ROOM_LABELS[k]}</span>
                </div>
                <div class="multiple-value">${latest ? fmt(latest.finalRooms[k]) : '–'}</div>
                <div class="multiple-delta ${delta == null ? '' : delta > 0 ? 'up' : 'down'}">${delta == null ? '' : `${pct(delta)} vs. avg · ${latest.key}`}</div>
                <div class="multiple-chart"></div>`;
            el.appendChild(panel);
            const chartEl = panel.querySelector('.multiple-chart');
            mount(chartEl, (w) => {
                const h = 84, m = { top: 4, right: 0, bottom: 16, left: 0 };
                const ih = h - m.top - m.bottom;
                const x = d3.scaleBand().domain(complete.map(s => s.key)).range([0, w]).paddingInner(0.3);
                const y = d3.scaleLinear().domain([0, maxV]).range([ih, 0]);
                const g = svgFor(chartEl, w, h).append('g').attr('transform', `translate(${m.left},${m.top})`);
                g.append('line').attr('class', 'grid base').attr('x1', 0).attr('x2', w).attr('y1', ih + 0.5).attr('y2', ih + 0.5);
                const bw = Math.min(14, x.bandwidth());
                g.selectAll('path').data(complete).join('path')
                    .attr('class', s => s === latest ? 'col-hero' : 'col-ctx')
                    .attr('fill', s => s === latest ? roomColor(k) : null)
                    .attr('d', s => {
                        const v = s.finalRooms[k], x0 = x(s.key) + (x.bandwidth() - bw) / 2, y0 = y(v), r = Math.min(3, (ih - y0) / 2);
                        return `M${x0},${ih}V${y0 + r}a${r},${r} 0 0 1 ${r},-${r}H${x0 + bw - r}a${r},${r} 0 0 1 ${r},${r}V${ih}Z`;
                    })
                    .on('pointermove', (ev, s) => tip.show(`<div class="tip-title">${A.ROOM_LABELS[k]} · ${s.key}</div>
                        <div class="tip-row"><span>Units</span><b>${fmt(s.finalRooms[k])}</b></div>
                        <div class="tip-row"><span>Share</span><b>${Math.round(s.finalRooms[k] / s.final * 100)}%</b></div>`, ev))
                    .on('pointerleave', tip.hide);
                const ends = [complete[0], complete[complete.length - 1]].filter(Boolean);
                g.selectAll('text').data(ends).join('text').attr('class', 'tick')
                    .attr('x', s => x(s.key) + x.bandwidth() / 2).attr('y', ih + 13).attr('text-anchor', 'middle').text(s => s.key);
            });
        });
    };

    // ==========================================
    // 8. Pannelli clima: consumo settimanale sopra, temperatura sotto (stesso asse x)
    // ==========================================
    const climatePanels = (el, { season, daily, temps }) => mount(el, (w) => {
        if (!daily.length) { el.innerHTML = '<p class="viz-empty">Not enough readings in this season.</p>'; return; }
        const key = season.key;
        const startDay = Math.max(31, Math.min(61, d3.min(daily, d => A.dayOfSeason(d.date, key))));
        const endDay = Math.min(334, Math.max(273, d3.max(daily.filter(d => d.value > 0), d => A.dayOfSeason(d.date, key)) + 7));
        const m = { top: 24, right: 12, bottom: 24, left: 0 };
        const h1 = 190, gap = 46, h2 = 150;
        const h = m.top + h1 + gap + h2 + m.bottom;
        const iw = w - m.left - m.right;
        const x = d3.scaleLinear().domain([startDay, endDay]).range([0, iw]);

        // Settimane (lun → dom)
        const weeks = A.weeklyTotals(daily.filter(d => { const dd = A.dayOfSeason(d.date, key); return dd >= startDay && dd <= endDay; }))
            .map(w => ({ ...w, wk: w.week, day: A.dayOfSeason(w.week, key) }));

        const svg = svgFor(el, w, h).attr('aria-label', `Weekly heat use and daily temperature, season ${key}`);
        const g1 = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
        const y1 = d3.scaleLinear().domain([0, d3.max(weeks, d => d.value) * 1.1 || 1]).nice().range([h1, 0]);
        yGrid(g1.append('g'), y1, 0, iw, { ticks: 4, unit: 'units / week' });
        const bw = Math.max(2, Math.min(14, x(startDay + 7) - x(startDay) - 3));
        g1.selectAll('path.col').data(weeks).join('path').attr('class', 'col-accent')
            .attr('d', d => {
                const x0 = x(d.day + 3.5) - bw / 2, y0 = y1(d.value), r = Math.min(3, (h1 - y0) / 2);
                if (d.value <= 0) return '';
                return `M${x0},${h1}V${y0 + r}a${r},${r} 0 0 1 ${r},-${r}H${x0 + bw - r}a${r},${r} 0 0 1 ${r},${r}V${h1}Z`;
            });
        // Letture: tacche sull'asse
        g1.selectAll('line.rd').data(season.points.filter(p => p.day >= startDay && p.day <= endDay)).join('line')
            .attr('class', 'reading-tick').attr('x1', p => x(p.day)).attr('x2', p => x(p.day)).attr('y1', h1 + 3).attr('y2', h1 + 9);

        // Temperatura giornaliera, area dei gradi-giorno sotto i 20 °C
        const g2 = svg.append('g').attr('transform', `translate(${m.left},${m.top + h1 + gap})`);
        const tSeries = [];
        for (let d = startDay; d <= endDay; d++) {
            const date = A.ymd(A.addDays(A.seasonStart(key), d));
            const t = temps.get(date);
            if (t != null) tSeries.push({ day: d, t, date });
        }
        const tMin = Math.min(-2, d3.min(tSeries, d => d.t) ?? 0), tMax = Math.max(22, d3.max(tSeries, d => d.t) ?? 20);
        const y2 = d3.scaleLinear().domain([tMin, tMax]).nice().range([h2, 0]);
        yGrid(g2.append('g'), y2, 0, iw, { ticks: 4, format: d => `${d}°`, unit: 'C' });
        xMonths(svg.append('g').attr('transform', `translate(${m.left},${m.top + h1 + gap})`), x, key, h2, startDay, endDay, { every: w < 520 ? 2 : 1 });
        if (tSeries.length) {
            g2.append('path').attr('class', 'hdd-area').attr('d', d3.area().x(d => x(d.day)).y0(y2(A.HDD_BASE))
                .y1(d => y2(Math.min(d.t, A.HDD_BASE))).curve(d3.curveMonotoneX)(tSeries));
            g2.append('line').attr('class', 'ref-line').attr('x1', 0).attr('x2', iw).attr('y1', y2(A.HDD_BASE)).attr('y2', y2(A.HDD_BASE));
            g2.append('text').attr('class', 'annot').attr('x', iw).attr('y', y2(A.HDD_BASE) - 6).attr('text-anchor', 'end').text('20 °C base · shaded = degree-days');
            g2.append('path').attr('class', 'line cold').attr('d', d3.line().x(d => x(d.day)).y(d => y2(d.t)).curve(d3.curveMonotoneX)(tSeries));
            const coldest = tSeries.reduce((a, b) => a.t < b.t ? a : b);
            g2.append('circle').attr('class', 'dot cold').attr('r', 4).attr('cx', x(coldest.day)).attr('cy', y2(coldest.t));
            g2.append('text').attr('class', 'annot').attr('x', x(coldest.day) + 8).attr('y', y2(coldest.t) + 4)
                .text(`Coldest: ${fmt1(coldest.t)}° on ${shortDate(coldest.date)}`);
        } else {
            g2.append('text').attr('class', 'annot').attr('x', iw / 2).attr('y', h2 / 2).attr('text-anchor', 'middle').text('Temperature data unavailable');
        }

        // Etichette pannelli
        svg.append('text').attr('class', 'panel-label').attr('x', m.left).attr('y', 12).text('Estimated heat use per week');
        svg.append('text').attr('class', 'panel-label').attr('x', m.left).attr('y', m.top + h1 + gap - 12).text('Daily mean outdoor temperature');

        // Hover condiviso sui due pannelli
        const rule = svg.append('line').attr('class', 'rule').attr('y1', m.top).attr('y2', m.top + h1 + gap + h2).style('opacity', 0);
        svg.append('rect').attr('x', m.left).attr('y', m.top).attr('width', iw).attr('height', h1 + gap + h2).attr('fill', 'transparent')
            .on('pointermove', (ev) => {
                const [px] = d3.pointer(ev);
                const day = x.invert(px - m.left);
                const wk = weeks.find(d => day >= d.day && day < d.day + 7);
                const td = tSeries.find(d => d.day === Math.round(day));
                rule.attr('x1', px).attr('x2', px).style('opacity', 1);
                const date = A.ymd(A.addDays(A.seasonStart(key), Math.round(day)));
                tip.show(`<div class="tip-title">${shortDate(date)}</div>
                    ${td ? `<div class="tip-row"><span>Mean temp</span><b>${fmt1(td.t)} °C</b></div>` : ''}
                    ${wk ? `<div class="tip-row is-hero"><span>Week of ${shortDate(wk.wk)}</span><b>${fmt(wk.value)} units</b></div>` : ''}`, ev);
            })
            .on('pointerleave', () => { rule.style('opacity', 0); tip.hide(); });
    });

    // ==========================================
    // 9. Calendario a mappa di calore (stima giornaliera)
    // ==========================================
    const calendarHeat = (el, { season, daily }) => mount(el, (w) => {
        const key = season.key;
        const y0 = A.seasonStartYear(key);
        const from = new Date(y0, 9, 1), to = new Date(y0 + 1, 4, 31);
        const byDate = new Map(daily.map(d => [d.date, d]));
        const readingDates = new Set(season.points.map(p => p.date));
        const startMonday = A.addDays(from, -((from.getDay() + 6) % 7));
        const weeksN = Math.ceil((A.daysBetween(startMonday, to) + 1) / 7);
        const left = 22, top = 18;
        const cell = Math.max(8, Math.min(18, Math.floor((w - left) / weeksN) - 2));
        const step = cell + 2;
        const h = top + step * 7 + 34;
        const max = d3.quantile(daily.map(d => d.value).filter(v => v > 0).sort(d3.ascending), 0.97) || 1;
        const ramp = d3.scaleSequential(d3.interpolateRgbBasis([css('--seq-1'), css('--seq-2'), css('--seq-3'), css('--seq-4'), css('--seq-5')])).domain([0, max]).clamp(true);
        const svg = svgFor(el, Math.min(w, left + weeksN * step + 4), h).attr('aria-label', `Daily heat use calendar, season ${key}`);
        const g = svg.append('g').attr('transform', `translate(${left},${top})`);
        ['M', '', 'W', '', 'F', '', 'S'].forEach((d, i) => g.append('text').attr('class', 'tick').attr('x', -left).attr('y', i * step + cell - 1).text(d));
        const days = [];
        for (let d = new Date(from); d <= to; d = A.addDays(d, 1)) days.push(new Date(d));
        days.forEach(d => {
            const k = A.ymd(d);
            const wi = Math.floor(A.daysBetween(startMonday, d) / 7), di = (d.getDay() + 6) % 7;
            const e = byDate.get(k);
            const rect = g.append('rect').attr('x', wi * step).attr('y', di * step).attr('width', cell).attr('height', cell).attr('rx', 3)
                .attr('class', e && e.value > 0.05 ? 'cal-cell' : 'cal-cell empty')
                .attr('fill', e && e.value > 0.05 ? ramp(e.value) : null);
            rect.on('pointermove', (ev) => tip.show(`<div class="tip-title">${longDate(k)}</div>
                ${e ? `<div class="tip-row is-hero"><span>Estimated use</span><b>${fmt1(e.value)} units</b></div>` : '<div class="tip-row"><span>No estimate</span></div>'}
                ${e && e.temp != null ? `<div class="tip-row"><span>Mean temp</span><b>${fmt1(e.temp)} °C</b></div>` : ''}
                ${readingDates.has(k) ? '<div class="tip-row"><span>Meter reading taken</span></div>' : ''}`, ev))
                .on('pointerleave', tip.hide);
            if (readingDates.has(k)) g.append('circle').attr('class', 'cal-reading').attr('r', Math.max(1.5, cell / 7)).attr('cx', wi * step + cell / 2).attr('cy', di * step + cell / 2).style('pointer-events', 'none');
            if (d.getDate() === 1) g.append('text').attr('class', 'tick').attr('x', wi * step).attr('y', -6).text(MONTHS[d.getMonth()]);
        });
        // Legenda della scala
        const lg = svg.append('g').attr('transform', `translate(${left},${top + step * 7 + 14})`);
        lg.append('text').attr('class', 'tick').attr('x', 0).attr('y', 9).text('Less');
        d3.range(5).forEach(i => lg.append('rect').attr('x', 30 + i * (cell + 2)).attr('y', 0).attr('width', cell).attr('height', Math.min(cell, 11)).attr('rx', 2).attr('fill', ramp(max * (i + 0.5) / 5)));
        lg.append('text').attr('class', 'tick').attr('x', 34 + 5 * (cell + 2)).attr('y', 9).text('More   ·  ● reading day');
    });

    // ==========================================
    // 10. Sparkline per le stat tile
    // ==========================================
    const sparkline = (el, { values, heroIndex }) => mount(el, (w) => {
        const h = 34, pad = 5;
        const pts = values.map((v, i) => ({ i, v })).filter(p => p.v != null);
        if (pts.length < 2) return;
        const x = d3.scaleLinear().domain([0, values.length - 1]).range([pad, w - pad]);
        const y = d3.scaleLinear().domain(d3.extent(pts, p => p.v)).range([h - pad, pad]);
        const svg = svgFor(el, w, h).attr('aria-hidden', 'true');
        svg.append('path').attr('class', 'spark').attr('d', d3.line().x(p => x(p.i)).y(p => y(p.v)).curve(d3.curveMonotoneX)(pts));
        const hp = pts.find(p => p.i === heroIndex) || pts[pts.length - 1];
        svg.append('circle').attr('class', 'dot hero').attr('r', 3.5).attr('cx', x(hp.i)).attr('cy', y(hp.v));
    });

    // ==========================================
    // 11. Firme per stanza — small multiples di scatter + sensibilità per stagione
    // ==========================================
    const roomSignatureGrid = (el, { signatures, season }) => {
        el.innerHTML = '';
        const maxRate = d3.max(A.ROOMS, k => d3.max(signatures[k].points, p => p.rate)) || 1;
        const temps = A.ROOMS.flatMap(k => signatures[k].points.map(p => p.temp));
        const tDom = [Math.floor(d3.min(temps)) - 1, Math.max(20, Math.ceil(d3.max(temps)) + 1)];
        const maxSlope = d3.max(A.ROOMS, k => d3.max(signatures[k].bySeason, b => b.fit ? -b.fit.slope : 0)) || 1;
        A.ROOMS.forEach(k => {
            const sig = signatures[k];
            const sel = sig.bySeason.find(b => b.key === season);
            const shown = sel?.fit || sig.fit;
            const panel = document.createElement('div');
            panel.className = 'multiple sig-panel';
            panel.innerHTML = `<div class="multiple-head"><span class="swatch" style="background:${roomColor(k)}"></span><span class="multiple-name">${A.ROOM_LABELS[k]}</span></div>
                <div class="sig-stats">
                    <div><span class="sig-v">${shown ? fmt2(-shown.slope) : '–'}</span><span class="sig-l">per °C colder</span></div>
                    <div><span class="sig-v">${shown?.zero != null ? `${fmt1(shown.zero)}°` : '–'}</span><span class="sig-l">heat off at</span></div>
                </div>
                <div class="sig-scatter"></div>
                <div class="sig-trend"></div>`;
            el.appendChild(panel);

            const scatterEl = panel.querySelector('.sig-scatter');
            mount(scatterEl, (w) => {
                const h = 150, m = { top: 8, right: 4, bottom: 18, left: 0 };
                const iw = w - m.left - m.right, ih = h - m.top - m.bottom;
                const x = d3.scaleLinear().domain(tDom).range([0, iw]);
                const y = d3.scaleLinear().domain([0, maxRate * 1.05]).nice().range([ih, 0]);
                const g = svgFor(scatterEl, w, h).attr('aria-label', `${A.ROOM_LABELS[k]}: heat per day vs outdoor temperature`)
                    .append('g').attr('transform', `translate(${m.left},${m.top})`);
                yGrid(g.append('g'), y, 0, iw, { ticks: 3 });
                g.selectAll('text.xt').data(x.ticks(4)).join('text').attr('class', 'tick').attr('x', x).attr('y', ih + 14)
                    .attr('text-anchor', 'middle').text(d => `${d}°`);
                const line = (f, cls) => {
                    if (!f) return;
                    const x0 = tDom[0], x1 = f.zero != null ? Math.min(tDom[1], f.zero) : tDom[1];
                    g.append('line').attr('class', cls).attr('x1', x(x0)).attr('y1', y(Math.max(0, f.at(x0))))
                        .attr('x2', x(x1)).attr('y2', y(Math.max(0, f.at(x1))));
                };
                const pts = sig.points.slice().sort((a, b) => (a.season === season) - (b.season === season));
                g.selectAll('circle').data(pts).join('circle')
                    .attr('class', p => p.season === season ? 'dot sig-hero' : 'dot ctx')
                    .attr('fill', p => p.season === season ? roomColor(k) : null)
                    .attr('r', p => p.season === season ? 4 : 2.6)
                    .attr('cx', p => x(p.temp)).attr('cy', p => y(p.rate));
                line(sig.fit, 'fit');
                if (sel?.fit) line(sel.fit, 'fit-room');
                g.select('.fit-room').style('stroke', roomColor(k));
                const delaunay = d3.Delaunay.from(pts, p => x(p.temp), p => y(p.rate));
                g.append('rect').attr('width', iw).attr('height', ih).attr('fill', 'transparent')
                    .on('pointermove', (ev) => {
                        const [px, py] = d3.pointer(ev);
                        const p = pts[delaunay.find(px, py)];
                        if (!p) return;
                        tip.show(`<div class="tip-title">${A.ROOM_LABELS[k]} · ${p.season}</div>
                            <div class="tip-row"><span>${shortDate(p.from)} → ${shortDate(p.to)}</span></div>
                            <div class="tip-row"><span>Avg temperature</span><b>${fmt1(p.temp)} °C</b></div>
                            <div class="tip-row is-hero"><span>Heat per day</span><b>${fmt1(p.rate)}</b></div>`, ev);
                    })
                    .on('pointerleave', tip.hide);
            });

            // Sensibilità stagione per stagione (stessa scala in tutti i pannelli)
            const trendEl = panel.querySelector('.sig-trend');
            mount(trendEl, (w) => {
                const h = 46, m = { top: 8, right: 4, bottom: 14, left: 0 };
                const iw = w - m.left - m.right, ih = h - m.top - m.bottom;
                const rows = sig.bySeason;
                const x = d3.scalePoint().domain(rows.map(b => b.key)).range([4, iw - 4]);
                const y = d3.scaleLinear().domain([0, maxSlope]).range([ih, 0]);
                const g = svgFor(trendEl, w, h).attr('aria-label', `${A.ROOM_LABELS[k]} sensitivity by season`)
                    .append('g').attr('transform', `translate(${m.left},${m.top})`);
                const valid = rows.filter(b => b.fit);
                g.append('path').attr('class', 'spark').attr('d', d3.line().x(b => x(b.key)).y(b => y(-b.fit.slope)).curve(d3.curveMonotoneX)(valid));
                g.selectAll('circle').data(valid).join('circle')
                    .attr('class', b => b.key === season ? 'dot hero-room' : 'dot ctx')
                    .attr('fill', b => b.key === season ? roomColor(k) : null)
                    .attr('r', b => b.key === season ? 4 : 2.5).attr('cx', b => x(b.key)).attr('cy', b => y(-b.fit.slope))
                    .on('pointermove', (ev, b) => tip.show(`<div class="tip-title">${A.ROOM_LABELS[k]} · ${b.key}</div>
                        <div class="tip-row is-hero"><span>Per °C colder</span><b>${fmt2(-b.fit.slope)}</b></div>
                        <div class="tip-row"><span>Heat off at</span><b>${fmt1(b.fit.zero)} °C</b></div>
                        <div class="tip-row"><span>Intervals</span><b>${b.n}</b></div>`, ev))
                    .on('pointerleave', tip.hide);
                const ends = [rows[0], rows[rows.length - 1]];
                g.selectAll('text.e').data(ends).join('text').attr('class', 'tick')
                    .attr('x', b => x(b.key)).attr('y', ih + 12).attr('text-anchor', (_, i) => i ? 'end' : 'start').text(b => b.key);
            });
        });
    };

    return {
        roomSignatureGrid,
        mount, redrawAll, tip, fmt, fmt1, fmt2, pct, shortDate, longDate, roomColor,
        seasonRace, seasonBars, dumbbell, labeledScatter, heatingGantt, roomShare, roomMultiples,
        climatePanels, calendarHeat, sparkline
    };
})();

window.Charts = Charts;
