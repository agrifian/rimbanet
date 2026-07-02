/**
 * RimbaNet Neural Engine v2.0 — script.js
 * Handles: Leaflet map, SSE scanning, report rendering,
 *          minimap interaction, sector crop, satellite modal
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const WARNA_KELAS = {
    'Plantation':             '#10b981',
    'Smallholder agriculture':'#eab308',
    'Grassland shrubland':    '#f97316',
    'Other':                  '#ef4444',
};

const LABEL_SINGKAT = {
    'Plantation':             'PLT',
    'Smallholder agriculture':'SHF',
    'Grassland shrubland':    'GRS',
    'Other':                  'OTH',
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. STATE
// ═══════════════════════════════════════════════════════════════════════════════
const state = {
    rgbFull:      null,   // base64 full-area RGB image (for crop endpoint)
    irFull:       null,   // base64 full-area IR image
    gridN:        3,
    scanAbort:    null,   // EventSource reference
    activeReport: null,   // current report ID
    activeMmCell: null,   // currently selected minimap cell element
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. DOM REFERENCES
// ═══════════════════════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

const els = {
    coordInput:   $('input-coordinates'),
    luasSlider:   $('input-luas'),
    luasDisplay:  $('luas-display'),
    gridWarning:  $('grid-warning'),
    btnScan:      $('btn-scan'),
    btnReset:     $('btn-reset'),
    reportOut:    $('output-report'),
    imgRgb:       $('img-rgb'),
    imgIr:        $('img-ir'),
    rgbPlaceholder: $('rgb-placeholder'),
    irPlaceholder:  $('ir-placeholder'),
    mapToast:     $('map-toast'),
    satModal:     $('sat-modal'),
    satModalImg:  $('sat-modal-img'),
    satModalCaption: $('sat-modal-caption'),
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LEAFLET MAP
// ═══════════════════════════════════════════════════════════════════════════════
const map = L.map('map-container', {
    center:   [-0.5, 114.5],
    zoom:     5,
    minZoom:  4,
    maxZoom:  18,
    maxBounds: [[-11.0, 95.0], [6.0, 141.0]],
    maxBoundsViscosity: 0.9,
});

L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Esri Satellite', maxZoom: 18 }
).addTo(map);

// Click → fill coordinate input + toast
map.on('click', function (e) {
    const lat = e.latlng.lat.toFixed(4);
    const lon = e.latlng.lng.toFixed(4);
    const coordStr = `${lat}, ${lon}`;

    setNativeValue(els.coordInput, coordStr);
    showMapToast(`COORDINATES SET — ${coordStr}`);

    if (navigator.clipboard) {
        navigator.clipboard.writeText(coordStr).catch(() => {});
    }
});

function setNativeValue(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input), 'value'
    ).set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

let toastTimer = null;
function showMapToast(msg) {
    const t = els.mapToast;
    t.textContent = '✓  ' + msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. MAP OVERLAY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
let gridLayers = [];

function clearMapOverlay() {
    gridLayers.forEach(l => map.removeLayer(l));
    gridLayers = [];
}

/**
 * Draw coloured sector rectangles on the Leaflet map.
 * @param {number} lat  Centre latitude
 * @param {number} lon  Centre longitude
 * @param {number} luasKm  Scan radius in km
 * @param {number} gridN  Grid dimension (1,2,3,4)
 * @param {Object} gridResults  { "i,j": { class, conf, color, label } }
 */
function drawMapGrid(lat, lon, luasKm, gridN, gridResults) {
    clearMapOverlay();

    const radiusM  = (luasKm * 1000) / 2;
    const offsetDeg = radiusM / 111320;

    const latMax = lat + offsetDeg;
    const lonMin = lon - offsetDeg;
    const tileLat = (2 * offsetDeg) / gridN;
    const tileLon = (2 * offsetDeg) / gridN;

    for (let i = 0; i < gridN; i++) {
        for (let j = 0; j < gridN; j++) {
            const cellLatMax = latMax - i * tileLat;
            const cellLatMin = latMax - (i + 1) * tileLat;
            const cellLonMin = lonMin + j * tileLon;
            const cellLonMax = lonMin + (j + 1) * tileLon;

            const key = `${i},${j}`;
            const res = gridResults[key];

            const color   = res ? res.color : '#64748b';
            const opacity = res ? 0.28 : 0.04;
            const weight  = res ? 2.5 : 1;
            const dash    = res ? null : '6 4';
            const popup   = res
                ? `<b>${res.class}</b><br>Conf: ${res.conf}%<br>${gridN === 1 ? 'Full Area' : `Sector [${i},${j}]`}`
                : `Pending — ${gridN === 1 ? 'Full Area' : `Sector [${i},${j}]`}`;

            const rect = L.rectangle(
                [[cellLatMin, cellLonMin], [cellLatMax, cellLonMax]],
                {
                    color,
                    weight,
                    fill: true,
                    fillColor: color,
                    fillOpacity: opacity,
                    dashArray: dash,
                }
            ).bindPopup(popup);

            rect.addTo(map);
            gridLayers.push(rect);
        }
    }

    // Centre marker
    const markerHtml = '<div style="width:12px;height:12px;background:#fff;border:2.5px solid #06b6d4;border-radius:50%;margin:-6px 0 0 -6px;box-shadow:0 0 8px rgba(6,182,212,0.5);"></div>';
    const marker = L.marker([lat, lon], {
        icon: L.divIcon({ html: markerHtml, className: '' })
    }).bindPopup('Analysis Center');

    marker.addTo(map);
    gridLayers.push(marker);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. CONTROLS — slider, radio, warning
// ═══════════════════════════════════════════════════════════════════════════════
els.luasSlider.addEventListener('input', () => {
    const v = parseFloat(els.luasSlider.value).toFixed(2);
    els.luasDisplay.textContent = `${v} km`;
    updateWarning();
});

document.querySelectorAll('input[name="grid"]').forEach(r => {
    r.addEventListener('change', () => {
        state.gridN = parseInt(r.value);
        updateWarning();
    });
});

function getGridN() {
    const checked = document.querySelector('input[name="grid"]:checked');
    return checked ? parseInt(checked.value) : 3;
}

function updateWarning() {
    const luas   = parseFloat(els.luasSlider.value);
    const gridN  = getGridN();
    const warn   = els.gridWarning;

    if (luas < 1.5 && gridN >= 3) {
        const pxPerSector = Math.round((luas * 1000 / 10) / gridN);
        warn.style.display = 'flex';
        warn.innerHTML = `
            <span style="font-size:1rem;line-height:1.4;">⚠️</span>
            <div>
                <span class="grid-warning-title">RESOLUTION WARNING</span>
                Radius <strong>${luas} km</strong> yields ~${pxPerSector}×${pxPerSector}px per sector at ${gridN}×${gridN}.
                Upscaling to 384px may reduce accuracy.
                Consider <strong>1×1</strong> or increasing radius to ≥ 1.5 km.
            </div>
        `;
    } else {
        warn.style.display = 'none';
        warn.innerHTML = '';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. SCANNING — SSE stream from /api/scan
// ═══════════════════════════════════════════════════════════════════════════════
els.btnScan.addEventListener('click', startScan);

function startScan() {
    const coords  = els.coordInput.value.trim();
    const luasKm  = parseFloat(els.luasSlider.value);
    const gridN   = getGridN();

    if (!coords) {
        showError('Please enter or click to select coordinates.');
        return;
    }

    // Abort any ongoing scan
    if (state.scanAbort) {
        state.scanAbort.close();
        state.scanAbort = null;
    }

    state.gridN = gridN;
    state.rgbFull = null;
    state.irFull  = null;

    els.btnScan.disabled = true;
    els.btnScan.textContent = 'SCANNING...';

    // Fly map to coords
    const nums = coords.match(/-?\d+\.\d+/g);
    if (nums && nums.length >= 2) {
        const lat = parseFloat(nums[0]);
        const lon = parseFloat(nums[1]);
        const zoom = luasKm <= 1.5 ? 15 : luasKm <= 3.0 ? 14 : 13;
        map.flyTo([lat, lon], zoom, { duration: 1.2 });
        drawMapGrid(lat, lon, luasKm, gridN, {});
    }

    // Show initial scanning UI
    showScanningUI(gridN, {}, -1, -1, 'INITIALIZING...');

    // POST to /api/scan, receive SSE
    fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coordinates: coords, luas_km: luasKm, grid_n: gridN }),
    }).then(response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function read() {
            reader.read().then(({ done, value }) => {
                if (done) {
                    resetScanBtn();
                    return;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop(); // keep incomplete chunk

                lines.forEach(chunk => {
                    if (chunk.startsWith('data: ')) {
                        try {
                            const payload = JSON.parse(chunk.slice(6));
                            handleStreamEvent(payload, coords, luasKm, gridN);
                        } catch (e) {
                            console.warn('JSON parse error:', e, chunk);
                        }
                    }
                });

                read();
            }).catch(err => {
                console.error('Stream read error:', err);
                resetScanBtn();
                showError('Connection to server lost. Is app.py running?');
            });
        }

        read();
    }).catch(err => {
        resetScanBtn();
        showError(`Cannot connect to Flask server: ${err.message}. Make sure app.py is running on port 5000.`);
    });
}

function handleStreamEvent(payload, coords, luasKm, gridN) {
    const nums = coords.match(/-?\d+\.\d+/g);
    const lat  = nums ? parseFloat(nums[0]) : 0;
    const lon  = nums ? parseFloat(nums[1]) : 0;

    if (payload.type === 'status') {
        // Update scan status message
        const msgEl = document.querySelector('.scan-status-msg');
        if (msgEl) msgEl.textContent = payload.message;
        return;
    }

    if (payload.type === 'scanning') {
        const sectorLabel = gridN === 1
            ? 'FULL AREA SCAN'
            : `SECTOR ${payload.done}/${payload.total} [${payload.i},${payload.j}]`;

        showScanningUI(gridN, payload.grid_results, payload.i, payload.j, sectorLabel);
        drawMapGrid(lat, lon, luasKm, gridN, payload.grid_results);
        return;
    }

    if (payload.type === 'done') {
        // Store full images for crop
        state.rgbFull = payload.rgb_pure;
        state.irFull  = payload.ir_pure;

        // Update map with final results
        drawMapGrid(lat, lon, luasKm, gridN, payload.grid_results);

        // Update imagery panels
        setImage(els.imgRgb, els.rgbPlaceholder, payload.rgb_overlay || payload.rgb_pure);
        setImage(els.imgIr,  els.irPlaceholder,  payload.ir_pure);

        // Render analysis report
        renderAnalysisReport(payload);

        resetScanBtn();
        return;
    }

    if (payload.type === 'error') {
        showError(payload.message);
        resetScanBtn();
        return;
    }
}

function resetScanBtn() {
    els.btnScan.disabled = false;
    els.btnScan.textContent = 'INITIALIZE SCAN';
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. RESET
// ═══════════════════════════════════════════════════════════════════════════════
els.btnReset.addEventListener('click', () => {
    if (state.scanAbort) {
        state.scanAbort.close();
        state.scanAbort = null;
    }
    resetScanBtn();

    els.coordInput.value = '';
    els.reportOut.innerHTML = '<div class="empty-state animate-fade">AWAITING SYSTEM INPUT. SELECT COORDINATES TO BEGIN...</div>';

    // Reset imagery
    els.imgRgb.classList.add('hidden');
    els.imgIr.classList.add('hidden');
    els.rgbPlaceholder.style.display = '';
    els.irPlaceholder.style.display  = '';

    clearMapOverlay();
    map.setView([-0.5, 114.5], 5);

    state.rgbFull = null;
    state.irFull  = null;
    state.activeMmCell = null;
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. UI BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Show the scanning grid progress card */
function showScanningUI(gridN, gridResults, currentI, currentJ, sectorLabel) {
    const total = gridN * gridN;
    const done  = Object.keys(gridResults).length;
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

    let cellsHtml = '';

    if (gridN === 1) {
        const key = '0,0';
        if (gridResults[key]) {
            const r = gridResults[key];
            cellsHtml = `<div class="scan-cell done"
                style="background:${r.color}28;border-color:${r.color};color:${r.color};
                       font-size:0.9rem;min-height:56px;"
                >${r.label}</div>`;
        } else {
            cellsHtml = `<div class="scan-cell active" style="min-height:56px;">
                <span class="scan-pulse">···</span></div>`;
        }
    } else {
        for (let i = 0; i < gridN; i++) {
            for (let j = 0; j < gridN; j++) {
                const key = `${i},${j}`;
                const r   = gridResults[key];
                if (r) {
                    cellsHtml += `<div class="scan-cell done"
                        style="background:${r.color}28;border-color:${r.color};color:${r.color};"
                        >${r.label}</div>`;
                } else if (i === currentI && j === currentJ) {
                    cellsHtml += `<div class="scan-cell active">
                        <span class="scan-pulse">···</span></div>`;
                } else {
                    cellsHtml += `<div class="scan-cell pending"></div>`;
                }
            }
        }
    }

    const legend = Object.entries(WARNA_KELAS).map(([k, c]) =>
        `<span class="scan-legend-item" style="color:${c};">■ ${k}</span>`
    ).join('');

    const gridCss = gridN === 1
        ? 'grid-template-columns:1fr;max-width:90px;'
        : `grid-template-columns:repeat(${gridN},1fr);`;

    els.reportOut.innerHTML = `
        <div class="scan-report">
            <div class="scan-header">
                <h2 class="text-shine" style="font-size:1.3rem;">SCANNING IN PROGRESS</h2>
                <span class="scan-sector-label">${sectorLabel || 'INITIALIZING...'}</span>
            </div>
            <div class="panel-divider"></div>
            <div class="scan-grid-container">
                <div class="scan-grid" style="${gridCss}">${cellsHtml}</div>
            </div>
            <div class="scan-progress-bar">
                <div class="scan-progress-fill" style="width:${pct}%;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:6px;">
                <span class="scan-status-msg">
                    ${gridN === 1 ? 'ANALYZING FULL-AREA SINGLE SECTOR...' : 'ANALYZING MULTI-SECTOR GRID...'}
                </span>
                <span style="font-size:0.7rem;font-weight:900;font-family:var(--font-mono);">${pct}%</span>
            </div>
            <div class="scan-legend" style="margin-top:12px;">${legend}</div>
        </div>
    `;
}

/** Render the final analysis report */
function renderAnalysisReport(payload) {
    const {
        lat, lon, luas_km, grid_n, grid_results,
        rgb_overlay, dom_cls, dom_color, avg_conf, counts, warna_kelas
    } = payload;

    const reportId  = `rpt_${Date.now()}`;
    const total     = Object.keys(grid_results).length;
    const isSingle  = grid_n === 1;
    const gridLabel = isSingle ? '1×1 SINGLE SECTOR' : `${grid_n}×${grid_n} · ${total} SECTORS`;

    // Distribution bars
    const sortedCounts = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const barsHtml = sortedCounts.map(([cls, cnt]) => {
        const pct   = (cnt / total * 100).toFixed(0);
        const color = (warna_kelas || WARNA_KELAS)[cls];
        return `
            <div class="dist-bar-row">
                <span class="dist-bar-label" style="color:${color};">${cls.toUpperCase()}</span>
                <div class="dist-bar-track">
                    <div class="dist-bar-fill" style="width:${pct}%;background:${color};"></div>
                </div>
                <span class="dist-bar-pct" style="color:${color};">${pct}% (${cnt})</span>
            </div>
        `;
    }).join('');

    // Minimap cells
    const CELL_PX = 32;
    const GAP     = 3;
    const minimapW = isSingle ? 72 : grid_n * CELL_PX + (grid_n - 1) * GAP;
    const minimapGridCss = isSingle
        ? `grid-template-columns:1fr;width:${minimapW}px;`
        : `grid-template-columns:repeat(${grid_n},1fr);gap:${GAP}px;width:${minimapW}px;`;

    let mmCells = '';
    for (let i = 0; i < grid_n; i++) {
        for (let j = 0; j < grid_n; j++) {
            const key = `${i},${j}`;
            const r   = grid_results[key];
            if (r) {
                const cellSizeStyle = isSingle ? 'font-size:1rem;min-height:54px;' : '';
                mmCells += `
                    <div class="mm-cell"
                        data-report="${reportId}"
                        data-sector="${key}"
                        data-class="${r.class}"
                        data-label="${r.label}"
                        data-conf="${r.conf}"
                        data-color="${r.color}"
                        data-desc="${(r.desc || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}"
                        style="background:${r.color}33;border:2px solid ${r.color};
                               color:${r.color};cursor:pointer;${cellSizeStyle}"
                        title="${r.class} (${r.conf}%) — Sector [${key}]"
                    >${r.label}</div>
                `;
            } else {
                mmCells += `<div style="background:rgba(100,116,139,0.1);border:1.5px dashed #64748b;
                    border-radius:4px;aspect-ratio:1;"></div>`;
            }
        }
    }

    // Satellite thumbnail
    const imgSrc     = rgb_overlay;
    const thumbBlock = imgSrc ? `
        <div>
            <div class="report-label" style="margin-bottom:6px;">
                RGB + GRID OVERLAY &nbsp;
                <span style="opacity:0.6;font-size:0.58rem;">(click to enlarge)</span>
            </div>
            <div class="sat-thumb-wrapper"
                 data-sat-modal="${reportId}"
                 data-sat-src="${imgSrc}"
                 data-sat-caption="${lat.toFixed(4)}, ${lon.toFixed(4)} · ${luas_km}km · ${isSingle ? '1×1' : `${grid_n}×${grid_n}`} · COPERNICUS S2 RGB">
                <img class="sat-thumb-img" src="${imgSrc}" alt="Satellite RGB overlay" />
                <span class="sat-thumb-icon">⛶</span>
            </div>
        </div>
    ` : '';

    // Diversity note
    const uniqueCount = sortedCounts.length;
    let diversityNote = '';
    if (isSingle) {
        diversityNote = `Full-area single sector scan. Dominant land use: ${dom_cls}.`;
    } else if (uniqueCount > 1) {
        diversityNote = `${uniqueCount} land-use types detected across ${total} sectors.`;
    } else {
        diversityNote = `Uniform ${dom_cls} coverage across all ${total} sectors.`;
    }

    els.reportOut.innerHTML = `
        <div class="analysis-report" id="${reportId}"
             style="border-top:5px solid ${dom_color};box-shadow:0 10px 28px ${dom_color}20;">
            <h2 class="text-shine" style="font-size:1.5rem;margin-bottom:5px;">
                ${isSingle ? 'SINGLE-SECTOR ANALYSIS' : 'MULTI-SECTOR ANALYSIS'}
            </h2>
            <div class="panel-divider"></div>

            <div class="report-meta">
                <div class="report-meta-left">
                    <span class="report-label">TARGET COORDINATES</span>
                    <span class="report-value">${lat.toFixed(4)}, ${lon.toFixed(4)}</span>
                    <span class="report-label" style="margin-top:10px;">GRID CONFIGURATION</span>
                    <span class="report-value">${gridLabel}</span>
                </div>
                <div class="report-meta-right">
                    <span class="report-label" id="hdr-label-${reportId}">
                        ${isSingle ? 'LAND USE' : 'DOMINANT LAND USE'}
                    </span>
                    <span class="report-dom-cls" id="hdr-value-${reportId}"
                          style="color:${dom_color};-webkit-text-stroke:1px ${dom_color};">
                        ${dom_cls.toUpperCase()}
                    </span>
                    <span class="report-desc-text" id="hdr-desc-${reportId}"></span>
                    <span class="report-label" id="hdr-conflabel-${reportId}" style="margin-top:8px;">
                        ${isSingle ? 'CONFIDENCE' : 'AVG CONFIDENCE'}
                    </span>
                    <span class="report-conf" id="hdr-conf-${reportId}"
                          style="color:${dom_color};">${avg_conf}%</span>
                    <button class="report-reset-btn" id="hdr-reset-${reportId}"
                            data-reset-report="${reportId}">
                        ↩ VIEW OVERALL AVERAGE
                    </button>
                </div>
            </div>

            <span class="report-label" style="display:block;margin-bottom:10px;">
                ${isSingle ? 'CLASSIFICATION RESULT' : 'LAND USE DISTRIBUTION'}
            </span>
            <div class="dist-bars">${barsHtml}</div>

            <div class="report-bottom">
                <div class="minimap-wrapper">
                    <span class="report-label" style="display:block;margin-bottom:6px;">
                        SECTOR MAP (${isSingle ? '1×1' : `${grid_n}×${grid_n}`})
                        ${!isSingle ? '<span style="font-size:0.58rem;opacity:0.5;"> CLICK TO INSPECT</span>' : ''}
                    </span>
                    <div class="minimap-grid" style="${minimapGridCss}">${mmCells}</div>
                </div>
                ${thumbBlock}
            </div>

            <p class="report-note">
                ${diversityNote} &nbsp;·&nbsp; Dual-Stream SwinV2 &nbsp;·&nbsp; 10m/px native Sentinel-2
            </p>
        </div>
    `;

    // Register new active report
    state.activeReport = reportId;
    state.activeMmCell = null;
}

/** Show error card */
function showError(msg) {
    els.reportOut.innerHTML = `
        <div class="error-report">
            <div class="error-title">⚠ SYSTEM ERROR</div>
            <div class="panel-divider"></div>
            <p class="error-msg">${msg}</p>
        </div>
    `;
}

/** Show/hide imagery panels */
function setImage(imgEl, placeholderEl, src) {
    if (src) {
        imgEl.src = src;
        imgEl.classList.remove('hidden');
        placeholderEl.style.display = 'none';
    } else {
        imgEl.classList.add('hidden');
        placeholderEl.style.display = '';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. MINIMAP INTERACTION (Event Delegation)
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('click', function (e) {

    // ── Minimap cell click ───────────────────────────────────────────────────
    const cell = e.target.closest('.mm-cell');
    if (cell) {
        const reportId = cell.dataset.report;
        if (reportId) {
            toggleSectorInfo(cell, reportId);
            // Request cropped imagery from server
            const sector = cell.dataset.sector;
            requestCrop(sector);
        }
        return;
    }

    // ── Reset button click ───────────────────────────────────────────────────
    const resetBtn = e.target.closest('[data-reset-report]');
    if (resetBtn) {
        const reportId = resetBtn.dataset.resetReport;
        if (reportId) {
            resetSectorInfo(reportId);
            requestCrop('ALL');
        }
        return;
    }

    // ── Satellite thumbnail click (open modal) ───────────────────────────────
    const satThumb = e.target.closest('[data-sat-modal]');
    if (satThumb) {
        els.satModalImg.src            = satThumb.dataset.satSrc;
        els.satModalCaption.textContent = satThumb.dataset.satCaption;
        els.satModal.style.display      = 'flex';
        return;
    }

    // ── Modal backdrop click (close) ─────────────────────────────────────────
    if (e.target === els.satModal) {
        els.satModal.style.display = 'none';
        return;
    }

}, false);

// Hover effects for minimap cells
document.addEventListener('mouseover', function (e) {
    const cell = e.target.closest('.mm-cell');
    if (!cell) return;
    if (cell !== state.activeMmCell) {
        cell.style.transform = 'scale(1.1)';
        cell.style.boxShadow = `0 0 8px ${cell.dataset.color}66`;
    }
}, false);

document.addEventListener('mouseout', function (e) {
    const cell = e.target.closest('.mm-cell');
    if (!cell) return;
    if (cell !== state.activeMmCell) {
        cell.style.transform = 'scale(1)';
        cell.style.boxShadow = 'none';
    }
}, false);

/** Toggle sector-specific detail in report header */
function toggleSectorInfo(cell, reportId) {
    if (state.activeMmCell === cell) {
        resetSectorInfo(reportId);
        return;
    }

    // Deactivate previous cell
    if (state.activeMmCell) {
        state.activeMmCell.style.transform   = 'scale(1)';
        state.activeMmCell.style.boxShadow   = 'none';
        state.activeMmCell.style.borderWidth = '2px';
    }

    state.activeMmCell = cell;

    cell.style.transform   = 'scale(1.18)';
    cell.style.boxShadow   = `0 0 0 3px ${cell.dataset.color}, 0 0 14px ${cell.dataset.color}88`;
    cell.style.borderWidth = '2.5px';

    const isSingle  = document.querySelectorAll(`.mm-cell[data-report="${reportId}"]`).length === 1;
    const labelEl   = $(`hdr-label-${reportId}`);
    const valueEl   = $(`hdr-value-${reportId}`);
    const confEl    = $(`hdr-conf-${reportId}`);
    const confLbl   = $(`hdr-conflabel-${reportId}`);
    const descEl    = $(`hdr-desc-${reportId}`);
    const resetBtn  = $(`hdr-reset-${reportId}`);

    if (!labelEl || !valueEl) return;

    const { sector, class: cls, conf, color, desc } = cell.dataset;

    labelEl.textContent = isSingle ? 'LAND USE' : `SECTOR [${sector}] LAND USE`;
    valueEl.textContent = cls.toUpperCase();
    valueEl.style.color = color;
    valueEl.style.webkitTextStroke = `1px ${color}`;
    confLbl.textContent = 'CONFIDENCE';
    confEl.textContent  = `${conf}%`;
    confEl.style.color  = color;

    if (descEl)  { descEl.textContent = desc; descEl.style.opacity = '1'; }
    if (resetBtn) resetBtn.classList.add('visible');
}

/** Reset report header to overall summary */
function resetSectorInfo(reportId) {
    if (state.activeMmCell) {
        state.activeMmCell.style.transform   = 'scale(1)';
        state.activeMmCell.style.boxShadow   = 'none';
        state.activeMmCell.style.borderWidth = '2px';
        state.activeMmCell = null;
    }

    const cells    = document.querySelectorAll(`.mm-cell[data-report="${reportId}"]`);
    const isSingle = cells.length === 1;

    // Recalculate dom class and avg conf from current cells
    const classCounts = {};
    let totalConf = 0, n = 0;
    cells.forEach(c => {
        const k = c.dataset.class;
        classCounts[k] = (classCounts[k] || 0) + 1;
        totalConf += parseFloat(c.dataset.conf);
        n++;
    });

    let domCls = '', domColor = '#10b981', maxCnt = 0;
    cells.forEach(c => {
        const k = c.dataset.class;
        if (classCounts[k] > maxCnt) {
            maxCnt   = classCounts[k];
            domCls   = k;
            domColor = c.dataset.color;
        }
    });

    const avgConf = n > 0 ? (totalConf / n).toFixed(1) : '—';

    const labelEl  = $(`hdr-label-${reportId}`);
    const valueEl  = $(`hdr-value-${reportId}`);
    const confEl   = $(`hdr-conf-${reportId}`);
    const confLbl  = $(`hdr-conflabel-${reportId}`);
    const descEl   = $(`hdr-desc-${reportId}`);
    const resetBtn = $(`hdr-reset-${reportId}`);

    if (!labelEl || !valueEl) return;

    labelEl.textContent = isSingle ? 'LAND USE' : 'DOMINANT LAND USE';
    valueEl.textContent = domCls.toUpperCase();
    valueEl.style.color = domColor;
    valueEl.style.webkitTextStroke = `1px ${domColor}`;
    confLbl.textContent = isSingle ? 'CONFIDENCE' : 'AVG CONFIDENCE';
    confEl.textContent  = `${avgConf}%`;
    confEl.style.color  = domColor;

    if (descEl)  { descEl.textContent = ''; descEl.style.opacity = '0'; }
    if (resetBtn) resetBtn.classList.remove('visible');
}

// ═══════════════════════════════════════════════════════════════════════════════
// 11. CROP REQUEST → update imagery panels
// ═══════════════════════════════════════════════════════════════════════════════
function requestCrop(sector) {
    if (!state.rgbFull || !state.irFull) return;

    fetch('/api/crop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sector:   sector,
            grid_n:   state.gridN,
            rgb_full: state.rgbFull,
            ir_full:  state.irFull,
        }),
    })
    .then(r => r.json())
    .then(data => {
        if (data.rgb) setImage(els.imgRgb, els.rgbPlaceholder, data.rgb);
        if (data.ir)  setImage(els.imgIr,  els.irPlaceholder,  data.ir);
    })
    .catch(err => console.error('Crop error:', err));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 12. KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
    // Escape → close modal
    if (e.key === 'Escape' && els.satModal.style.display !== 'none') {
        els.satModal.style.display = 'none';
    }
    // Enter in coordinate input → trigger scan
    if (e.key === 'Enter' && document.activeElement === els.coordInput) {
        if (!els.btnScan.disabled) startScan();
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. EXPANDABLE INFO SECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handles all expandable drawer sections:
 *  - .imagery-header  (data-expandable="drawer-id")    → imagery panels
 *  - .info-section-header (data-expandable="drawer-id") → bottom info cards
 *
 * Animation sequence when opening:
 *   1. Label text slides to centre (handled by CSS flex justify-content)
 *   2. Expand line scales from 0 → full width
 *   3. Drawer slides down + fades in
 *
 * When closing, the sequence reverses.
 */

function initExpandableSections() {
    // ── Imagery headers ────────────────────────────────────────────────────
    document.querySelectorAll('.imagery-header[data-expandable]').forEach(header => {
        // Inject animated line between label row and drawer
        const drawerId = header.dataset.expandable;
        const drawer   = document.getElementById(drawerId);
        if (!drawer) return;

        // Insert expand-line element after the label row, before the drawer
        const line = document.createElement('div');
        line.className = 'expand-line';
        header.insertBefore(line, drawer);

        header.addEventListener('click', () => {
            const isOpen = header.classList.contains('open');
            toggleDrawer(header, drawer, !isOpen);
        });
    });

    // ── Info section cards ─────────────────────────────────────────────────
    document.querySelectorAll('.info-section-header[data-expandable]').forEach(sectionHeader => {
        const drawerId = sectionHeader.dataset.expandable;
        const drawer   = document.getElementById(drawerId);
        if (!drawer) return;

        const card = sectionHeader.closest('.info-section-card');

        // Inject expand divider between header and drawer inside the card
        const divider = document.createElement('div');
        divider.className = 'info-section-divider';
        card.insertBefore(divider, drawer);

        sectionHeader.addEventListener('click', () => {
            const isOpen = card.classList.contains('open');
            toggleInfoCard(card, drawer, sectionHeader, !isOpen);
        });
    });
}

/**
 * Toggle an imagery drawer open/close.
 * @param {HTMLElement} header  — .imagery-header
 * @param {HTMLElement} drawer  — .imagery-info-drawer
 * @param {boolean}     open
 */
function toggleDrawer(header, drawer, open) {
    if (open) {
        header.classList.add('open');
        drawer.classList.add('open');
    } else {
        header.classList.remove('open');
        drawer.classList.remove('open');
    }
}

/**
 * Toggle an info-section card open/close.
 * @param {HTMLElement} card
 * @param {HTMLElement} drawer
 * @param {HTMLElement} sectionHeader
 * @param {boolean}     open
 */
function toggleInfoCard(card, drawer, sectionHeader, open) {
    if (open) {
        card.classList.add('open');
        drawer.classList.add('open');
    } else {
        card.classList.remove('open');
        drawer.classList.remove('open');
    }
}

// Boot expandable sections on DOM ready
initExpandableSections();