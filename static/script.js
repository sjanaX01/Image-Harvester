// ── STATE ──
let jobId = null;
let pollTimer = null;
let shownImages = new Set();
let currentView = 'gallery';
let followLinks = true;
let exhaustAll = false;
let detectFullres = false;
let sameDomainOnly = true;
let respectRobots = true;
let selectedImages = new Set();
let allSelectMode = false;
let allImageDetails = [];
let currentDetailImg = null;
let logPanelHeights = {};  // stores height before minimize
let rawLiveMode = false;
let lastRawPages = {};
let lastCrawlEvents = [];

// ── THEME ──
function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
    updateThemeIcon();
    updateGraphRootColor();
}

function updateThemeIcon() {
    const btn = document.getElementById('themeBtn');
    if (!btn) return;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    btn.innerHTML = isDark
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
}

function updateGraphRootColor() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    NODE_COLORS.root = isDark ? '#e0dcd4' : '#0a0a0a';
    // Re-color existing root nodes
    d3.selectAll('.nodes g.node circle').each(function (d) {
        if (d && d.depth === 0) d3.select(this).attr('fill', NODE_COLORS.root);
    });
}

// Apply saved theme on load
(function () {
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    document.addEventListener('DOMContentLoaded', () => { updateThemeIcon(); updateGraphRootColor(); });
})();

// ── WARNING ──
let warnTimer = null;
function showWarn(msg, duration) {
    const el = document.getElementById('warnMsg');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('vis');
    clearTimeout(warnTimer);
    if (duration) warnTimer = setTimeout(() => el.classList.remove('vis'), duration);
}
function hideWarn() {
    const el = document.getElementById('warnMsg');
    if (el) el.classList.remove('vis');
}

// ── VIEW SWITCHING ──
function switchView(v, el) {
    currentView = v;
    document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    if (el) el.classList.add('active');
    const panelMap = { gallery: 'panelGallery', graph: 'panelGraph', queue: 'panelQueue', rawdata: 'panelRawData' };
    document.getElementById(panelMap[v]).classList.remove('hidden');
    if (v === 'graph' && graphNeedsRender) {
        renderGraph(lastGraphData);
        graphNeedsRender = false;
    }
}

// ── TOGGLES ──
function toggleOption(which) {
    if (which === 'follow') {
        followLinks = !followLinks;
        document.getElementById('followToggle').classList.toggle('on', followLinks);
        if (!followLinks) {
            exhaustAll = false;
            document.getElementById('exhaustToggle').classList.remove('on');
            document.getElementById('exhaustToggle').classList.add('disabled-row');
        } else {
            document.getElementById('exhaustToggle').classList.remove('disabled-row');
        }
        updateDepthSection();
    } else if (which === 'exhaust') {
        exhaustAll = !exhaustAll;
        document.getElementById('exhaustToggle').classList.toggle('on', exhaustAll);
        updateDepthSection();
        if (exhaustAll) showWarn('⚠ Exhaust All ignores depth — crawl size depends on Max Pages.', 5000);
        else hideWarn();
    } else if (which === 'fullres') {
        detectFullres = !detectFullres;
        document.getElementById('fullresToggle').classList.toggle('on', detectFullres);
    } else if (which === 'domain') {
        sameDomainOnly = !sameDomainOnly;
        document.getElementById('domainToggle').classList.toggle('on', sameDomainOnly);
        if (!sameDomainOnly) showWarn('⚠ Cross-domain scraping may discover a very large number of links.', 5000);
        else hideWarn();
    } else if (which === 'robots') {
        respectRobots = !respectRobots;
        document.getElementById('robotsToggle').classList.toggle('on', respectRobots);
        if (!respectRobots) showWarn('⚠ Ignoring robots.txt — some sites may block or rate-limit you.', 5000);
        else hideWarn();
    }
}

function updateDepthSection() {
    const hint = document.getElementById('depthHint');
    const depthInput = document.getElementById('depthInput');
    if (!followLinks) {
        hint.textContent = 'Follow Links is off — only scraping the given URL.';
        depthInput.disabled = true; depthInput.style.opacity = '0.4';
    } else if (exhaustAll) {
        hint.textContent = 'Exhaust All is on — depth limit is ignored. Max pages still applies.';
        depthInput.disabled = true; depthInput.style.opacity = '0.4';
    } else {
        hint.textContent = 'Depth 0 = single page. Max pages caps total crawl.';
        depthInput.disabled = false; depthInput.style.opacity = '1';
    }
}

// ── SCRAPING ──
async function startScrape() {
    const url = document.getElementById('urlInput').value.trim();
    if (!url) { document.getElementById('urlInput').focus(); return; }

    const maxDepth = parseInt(document.getElementById('depthInput').value) || 2;
    const maxPages = parseInt(document.getElementById('pagesInput').value) || 50;

    // Reset
    shownImages = new Set();
    selectedImages = new Set();
    allSelectMode = false;
    sectionCollapsed = { thumbs: false, fullres: false };
    allImageDetails = [];
    document.getElementById('galleryContent').innerHTML = '';
    document.getElementById('galleryEmpty') || null; // recreated below
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state'; emptyDiv.id = 'galleryEmpty';
    emptyDiv.innerHTML = '<div class="big-icon">⬡</div><p>Scraping in progress…</p>';
    document.getElementById('galleryContent').appendChild(emptyDiv);
    document.getElementById('queueList').innerHTML = '';
    document.getElementById('queueEmpty').style.display = 'flex';
    ['logBody', 'logBody2', 'logBody3'].forEach(id => { document.getElementById(id).innerHTML = ''; });
    setStats(0, 0, 0, 0);
    document.getElementById('currentUrl').textContent = '—';
    document.getElementById('downloadBtn').disabled = true;
    closeDlMenu();
    document.getElementById('graphEmpty').style.display = 'flex';
    updateSelBar();
    resetGraphState();

    setStatus('starting');
    document.getElementById('startBtn').disabled = true;
    document.getElementById('cancelBtn').disabled = false;

    const res = await fetch('/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url, max_depth: maxDepth, max_pages: maxPages,
            follow_links: followLinks, exhaust_all: exhaustAll,
            detect_fullres: detectFullres, same_domain_only: sameDomainOnly,
            respect_robots: respectRobots,
        })
    });
    const data = await res.json();
    jobId = data.job_id;
    pollTimer = setInterval(poll, 1000);
}

async function poll() {
    if (!jobId) return;
    try {
        const res = await fetch(`/status/${jobId}`);
        const data = await res.json();

        setStatus(data.status);
        setStats(data.image_count, data.pages_scraped, data.queue_size, data.crawl_nodes?.length || 0);
        document.getElementById('currentUrl').textContent = data.current_url || '—';
        document.getElementById('galleryCount').textContent = `${data.image_count} images`;

        updateLog(data.log);
        renderNewImages(data.image_details || []);
        updateQueue(data.queue_urls || []);

        // Graph
        if (data.crawl_nodes && data.crawl_nodes.length > 0) {
            document.getElementById('graphEmpty').style.display = 'none';
            if (currentView === 'graph') {
                renderGraph({ nodes: data.crawl_nodes, edges: data.crawl_edges || [] });
            } else {
                lastGraphData = { nodes: data.crawl_nodes, edges: data.crawl_edges || [] };
                graphNeedsRender = true;
            }
        }

        // Raw Data
        if (data.raw_pages) {
            const oldKeys = Object.keys(lastRawPages).length;
            lastRawPages = data.raw_pages;
            lastCrawlEvents = data.crawl_events || [];
            if (Object.keys(lastRawPages).length !== oldKeys) updateRawPageSelect();
            if (currentView === 'rawdata') updateRawDataView();
        }

        // Zip progress
        if (data.zip_progress && data.zip_progress.status === 'zipping') {
            showZipProgress(data.zip_progress);
        }

        if (data.status === 'done' || data.status === 'cancelled') {
            clearInterval(pollTimer);
            document.getElementById('startBtn').disabled = false;
            document.getElementById('cancelBtn').disabled = true;
            if (data.image_count > 0) document.getElementById('downloadBtn').disabled = false;
        }
    } catch (e) { /* network error, keep polling */ }
}

async function cancelScrape() {
    if (!jobId) return;
    await fetch(`/cancel/${jobId}`, { method: 'POST' });
    document.getElementById('cancelBtn').disabled = true;
}

// ── DOWNLOAD DROPDOWN ──
let dlMenuOpen = false;

function toggleDlMenu() {
    const dd = document.getElementById('dlDropdown');
    dlMenuOpen = !dlMenuOpen;
    dd.classList.toggle('open', dlMenuOpen);
    if (dlMenuOpen) updateDlCounts();
}

function closeDlMenu() {
    dlMenuOpen = false;
    const dd = document.getElementById('dlDropdown');
    if (dd) dd.classList.remove('open');
}

function updateDlCounts() {
    const thumbs = allImageDetails.filter(i => i.is_thumbnail);
    const full = allImageDetails.filter(i => !i.is_thumbnail);
    document.getElementById('dlCountAll').textContent = allImageDetails.length + ' images';
    document.getElementById('dlCountThumb').textContent = thumbs.length + ' images';
    document.getElementById('dlCountFull').textContent = full.length + ' images';
    const selOpt = document.getElementById('dlOptSelected');
    if (selectedImages.size > 0) {
        selOpt.style.display = 'flex';
        document.getElementById('dlCountSel').textContent = selectedImages.size + ' images';
    } else {
        selOpt.style.display = 'none';
    }
}

async function downloadCategory(cat) {
    if (!jobId) return;
    closeDlMenu();

    let urls = [];
    if (cat === 'all') {
        urls = allImageDetails.map(i => i.url);
    } else if (cat === 'thumbnails') {
        urls = allImageDetails.filter(i => i.is_thumbnail).map(i => i.url);
    } else if (cat === 'fullres') {
        urls = allImageDetails.filter(i => !i.is_thumbnail).map(i => i.url);
    } else if (cat === 'selected') {
        urls = Array.from(selectedImages);
    }

    if (urls.length === 0) return;

    document.getElementById('zipOverlay').classList.add('open');
    document.getElementById('zipDetail').textContent = `Packaging ${urls.length} images…`;
    document.getElementById('zipBar').style.width = '10%';

    try {
        const res = await fetch(`/download-selected/${jobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
        });
        document.getElementById('zipBar').style.width = '80%';
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `images_${cat}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);
        document.getElementById('zipBar').style.width = '100%';
    } catch (e) {
        document.getElementById('zipDetail').textContent = 'Download failed.';
    }
    setTimeout(() => { document.getElementById('zipOverlay').classList.remove('open'); }, 600);
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    if (dlMenuOpen && !e.target.closest('#dlDropWrap')) closeDlMenu();
});

function showZipProgress(zp) {
    if (zp.total > 0) {
        const pct = Math.round((zp.current / zp.total) * 100);
        document.getElementById('zipBar').style.width = pct + '%';
        document.getElementById('zipDetail').textContent = `${zp.current}/${zp.total} — ${zp.filename || ''}`;
    }
}

function setStatus(s) {
    const pill = document.getElementById('statusPill');
    pill.className = `status-pill ${s}`;
    const dot = pill.querySelector('.dot');
    dot.className = `dot ${s === 'running' || s === 'starting' ? 'pulse' : ''}`;
    pill.querySelector('span').textContent = s;
}

function setStats(images, pages, queue, nodes) {
    document.getElementById('statImages').textContent = images;
    document.getElementById('statPages').textContent = pages;
    document.getElementById('statQueue').textContent = queue;
    document.getElementById('statNodes').textContent = nodes;
}

function updateLog(lines) {
    ['logBody', 'logBody2', 'logBody3'].forEach(id => {
        const body = document.getElementById(id);
        if (!lines || !lines.length) return;
        body.innerHTML = '';
        lines.forEach((line, i) => {
            const el = document.createElement('div');
            el.className = `log-line ${i === lines.length - 1 ? 'new' : ''}`;
            el.textContent = line;
            body.appendChild(el);
        });
        body.scrollTop = body.scrollHeight;
    });
}

// ── QUEUE ──
function updateQueue(queueUrls) {
    if (!queueUrls || queueUrls.length === 0) return;
    document.getElementById('queueEmpty').style.display = 'none';
    const list = document.getElementById('queueList');
    list.innerHTML = '';
    document.getElementById('queueCount').textContent = `${queueUrls.length} urls`;
    queueUrls.forEach(q => {
        const div = document.createElement('div');
        div.className = 'queue-item';
        div.innerHTML = `<div class="q-status ${q.status}"></div><span class="q-url" title="${q.url}">${q.url}</span><span class="q-depth">d${q.depth}</span>`;
        list.appendChild(div);
    });
}

// ── IMAGE GALLERY ──
function renderNewImages(imageDetails) {
    if (!imageDetails || imageDetails.length === 0) return;

    const content = document.getElementById('galleryContent');
    const empty = document.getElementById('galleryEmpty');
    if (empty) empty.remove();

    // Track new images
    const newOnes = imageDetails.filter(img => !shownImages.has(img.url));
    if (newOnes.length === 0) return;

    newOnes.forEach(img => {
        shownImages.add(img.url);
        allImageDetails.push(img);
    });

    // Rebuild gallery with sections
    rebuildGallery();
}

let sectionCollapsed = { thumbs: false, fullres: false };

function rebuildGallery() {
    const content = document.getElementById('galleryContent');
    content.innerHTML = '';

    const thumbnails = allImageDetails.filter(img => img.is_thumbnail);
    const fullres = allImageDetails.filter(img => !img.is_thumbnail);

    if (thumbnails.length > 0) {
        content.appendChild(makeSectionHeader('thumbs', 'Thumbnails', thumbnails.length));
        const grid = document.createElement('div');
        grid.className = 'gallery' + (sectionCollapsed.thumbs ? ' sec-collapsed' : '');
        grid.id = 'thumbGrid';
        thumbnails.forEach(img => grid.appendChild(createImageCard(img)));
        content.appendChild(grid);
    }

    if (fullres.length > 0) {
        const hdr = makeSectionHeader('fullres', 'Full-Resolution Images', fullres.length);
        if (thumbnails.length > 0) hdr.style.marginTop = '20px';
        content.appendChild(hdr);
        const grid = document.createElement('div');
        grid.className = 'gallery' + (sectionCollapsed.fullres ? ' sec-collapsed' : '');
        grid.id = 'fullresGrid';
        fullres.forEach(img => grid.appendChild(createImageCard(img, true)));
        content.appendChild(grid);
    }

    if (thumbnails.length === 0 && fullres.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state'; emptyDiv.id = 'galleryEmpty';
        emptyDiv.innerHTML = '<div class="big-icon">⬡</div><p>No images found yet</p>';
        content.appendChild(emptyDiv);
    }
}

function makeSectionHeader(key, title, count) {
    const div = document.createElement('div');
    div.className = 'section-divider';
    div.id = 'sec-hdr-' + key;

    const left = document.createElement('div');
    left.className = 'sec-left';

    const btn = document.createElement('button');
    btn.className = 'sec-toggle';
    btn.textContent = sectionCollapsed[key] ? '▶' : '▼';
    btn.title = sectionCollapsed[key] ? 'Expand section' : 'Minimize section';
    btn.onclick = () => toggleSection(key);

    const titleSpan = document.createElement('span');
    titleSpan.textContent = title;

    left.appendChild(btn);
    left.appendChild(titleSpan);

    const countSpan = document.createElement('span');
    countSpan.className = 'count';
    countSpan.textContent = count + ' images';

    div.appendChild(left);
    div.appendChild(countSpan);
    return div;
}

function toggleSection(key) {
    sectionCollapsed[key] = !sectionCollapsed[key];
    const gridId = key === 'thumbs' ? 'thumbGrid' : 'fullresGrid';
    const grid = document.getElementById(gridId);
    const btn = document.querySelector('#sec-hdr-' + key + ' .sec-toggle');
    if (grid) grid.classList.toggle('sec-collapsed', sectionCollapsed[key]);
    if (btn) {
        btn.textContent = sectionCollapsed[key] ? '▶' : '▼';
        btn.title = sectionCollapsed[key] ? 'Expand section' : 'Minimize section';
    }
}

function updateSelBar() {
    const bar = document.getElementById('selBar');
    const cnt = document.getElementById('selCount');
    const n = selectedImages.size;
    if (n > 0) {
        bar.classList.add('vis');
        cnt.textContent = n + ' selected';
    } else {
        bar.classList.remove('vis');
    }
}

function createImageCard(img, showSource) {
    const wrapper = document.createElement('div');

    const card = document.createElement('div');
    card.className = 'img-card' + (selectedImages.has(img.url) ? ' selected' : '');
    card.dataset.url = img.url;

    const check = document.createElement('div');
    check.className = 'check-mark';
    check.textContent = '✓';
    card.appendChild(check);

    const imgEl = document.createElement('img');
    imgEl.src = img.url; imgEl.alt = img.filename || ''; imgEl.loading = 'lazy';
    imgEl.onerror = () => { card.innerHTML = `<div class="img-err"><span>⬡</span><span>No preview</span></div>`; card.appendChild(check); };
    card.appendChild(imgEl);

    card.onclick = (e) => {
        if (e.shiftKey || e.ctrlKey) {
            toggleSelect(img.url, card);
        } else {
            openDetail(img);
        }
    };
    card.oncontextmenu = (e) => { e.preventDefault(); toggleSelect(img.url, card); };

    wrapper.appendChild(card);

    if (showSource && img.source_page) {
        const src = document.createElement('div');
        src.className = 'img-source';
        try { src.textContent = new URL(img.source_page).pathname; } catch { src.textContent = img.source_page; }
        src.title = img.source_page;
        wrapper.appendChild(src);
    }

    return wrapper;
}

// ── IMAGE SELECTION ──
function toggleSelect(url, card) {
    if (selectedImages.has(url)) {
        selectedImages.delete(url);
        if (card) card.classList.remove('selected');
    } else {
        selectedImages.add(url);
        if (card) card.classList.add('selected');
    }
    updateSelBar();
}

function toggleSelectAll() {
    allSelectMode = !allSelectMode;
    const btn = document.getElementById('selectAllBtn');
    if (allSelectMode) {
        allImageDetails.forEach(img => selectedImages.add(img.url));
        btn.classList.add('active');
    } else {
        selectedImages.clear();
        btn.classList.remove('active');
    }
    document.querySelectorAll('.img-card').forEach(c => {
        c.classList.toggle('selected', selectedImages.has(c.dataset.url));
    });
    updateSelBar();
}

function clearSelection() {
    selectedImages.clear();
    allSelectMode = false;
    const btn = document.getElementById('selectAllBtn');
    if (btn) btn.classList.remove('active');
    document.querySelectorAll('.img-card').forEach(c => c.classList.remove('selected'));
    updateSelBar();
}

// ── IMAGE DETAIL DASHBOARD ──
let detailImgData = null;

function openDetail(img) {
    detailImgData = img;
    document.getElementById('detailImg').src = img.url;
    document.getElementById('detailFilename').textContent = img.filename || 'Unknown';
    document.getElementById('detailSourceUrl').textContent = img.source_page || '—';
    document.getElementById('detailImgUrl').textContent = img.url;

    // Type based on extension
    const ext = (img.filename || '').split('.').pop()?.toUpperCase() || '—';
    document.getElementById('detailType').textContent = ext;

    // Found on
    try {
        document.getElementById('detailFoundOn').textContent = new URL(img.source_page).pathname;
    } catch {
        document.getElementById('detailFoundOn').textContent = img.source_page || '—';
    }

    // Category
    document.getElementById('detailCategory').textContent = img.is_thumbnail ? 'Thumbnail' : 'Full Resolution';

    // Select button state
    updateDetailSelectBtn();

    document.getElementById('imgDetailOverlay').classList.add('open');
}

function closeDetail() {
    document.getElementById('imgDetailOverlay').classList.remove('open');
    detailImgData = null;
}

function detailOpenOriginal() {
    if (detailImgData) window.open(detailImgData.url, '_blank');
}

function detailOpenSource() {
    if (detailImgData?.source_page) window.open(detailImgData.source_page, '_blank');
}

function detailToggleSelect() {
    if (!detailImgData) return;
    if (selectedImages.has(detailImgData.url)) {
        selectedImages.delete(detailImgData.url);
    } else {
        selectedImages.add(detailImgData.url);
    }
    // Update card in gallery
    document.querySelectorAll('.img-card').forEach(c => {
        if (c.dataset.url === detailImgData.url) {
            c.classList.toggle('selected', selectedImages.has(detailImgData.url));
        }
    });
    updateSelBar();
    updateDetailSelectBtn();
}

function updateDetailSelectBtn() {
    const btn = document.getElementById('detailSelectBtn');
    if (!detailImgData) return;
    if (selectedImages.has(detailImgData.url)) {
        btn.textContent = '☑ Selected — Click to Deselect';
        btn.classList.add('active');
    } else {
        btn.textContent = '☐ Select for Download';
        btn.classList.remove('active');
    }
}

function detailDownloadSingle() {
    if (!detailImgData) return;
    const a = document.createElement('a');
    a.href = detailImgData.url;
    a.download = detailImgData.filename || 'image';
    a.target = '_blank';
    a.click();
}

// Close on Escape or overlay background click
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
document.getElementById('imgDetailOverlay')?.addEventListener('click', e => {
    if (e.target.id === 'imgDetailOverlay') closeDetail();
});

// ── LOG TOGGLE (MINIMIZE/RESTORE) ──
function toggleLog(panelId) {
    const panel = document.getElementById(panelId);
    if (panel.classList.contains('minimized')) {
        // Restore to previous height
        const savedH = logPanelHeights[panelId] || 180;
        panel.style.height = savedH + 'px';
        panel.classList.remove('minimized');
    } else {
        // Save current height and minimize
        logPanelHeights[panelId] = panel.offsetHeight;
        panel.classList.add('minimized');
    }
}

// Resizable logs (smooth, no lag)
function initLogResize(handleId, panelId) {
    const handle = document.getElementById(handleId);
    const panel = document.getElementById(panelId);
    if (!handle || !panel) return;

    let startY, startH, rafId;
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startY = e.clientY;
        startH = panel.offsetHeight;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'ns-resize';
        const onMove = (e2) => {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                const diff = startY - e2.clientY;
                const newH = Math.max(60, Math.min(500, startH + diff));
                panel.style.height = newH + 'px';
            });
        };
        const onUp = () => {
            if (rafId) cancelAnimationFrame(rafId);
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

// ── D3 GRAPH ──
let simulation = null, svgRoot = null, zoomBehavior = null, graphContainer = null;
let lastGraphData = { nodes: [], edges: [] };
let graphNeedsRender = false, nodeMap = {};

const NODE_COLORS = { root: '#0a0a0a', pending: '#c8c4bc', scraping: '#b06010', done: '#1f7a4a', error: '#b03020' };

function rootNodeColor() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? '#e0dcd4' : '#0a0a0a';
}

function resetGraphState() {
    simulation = null; nodeMap = {};
    lastGraphData = { nodes: [], edges: [] }; graphNeedsRender = false;
    d3.select('#graphSvg').selectAll('*').remove();
    svgRoot = null; graphContainer = null;
}

function initGraphSvg() {
    const svg = d3.select('#graphSvg');
    svg.selectAll('*').remove();
    svgRoot = svg;
    zoomBehavior = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (event) => {
        graphContainer.attr('transform', event.transform);
    });
    svg.call(zoomBehavior);
    svg.append('defs').append('marker')
        .attr('id', 'arrow').attr('viewBox', '0 -4 8 8')
        .attr('refX', 18).attr('refY', 0).attr('markerWidth', 5).attr('markerHeight', 5)
        .attr('orient', 'auto').append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#c0bbb0');
    graphContainer = svg.append('g').attr('class', 'graph-container');
    graphContainer.append('g').attr('class', 'edges');
    graphContainer.append('g').attr('class', 'nodes');
}

function renderGraph(data) {
    const { nodes, edges } = data;
    if (!nodes || nodes.length === 0) return;
    const svgEl = document.getElementById('graphSvg');
    const W = svgEl.clientWidth || 800, H = svgEl.clientHeight || 500;
    if (!svgRoot || !graphContainer) initGraphSvg();

    const nodeById = {};
    nodes.forEach(n => { nodeById[n.id] = n; });
    nodes.forEach(n => {
        if (nodeMap[n.id]) { n.x = nodeMap[n.id].x; n.y = nodeMap[n.id].y; n.vx = nodeMap[n.id].vx || 0; n.vy = nodeMap[n.id].vy || 0; }
    });
    nodes.forEach(n => { nodeMap[n.id] = n; });

    const validEdges = edges.filter(e => nodeById[e.source] && nodeById[e.target])
        .map(e => ({ source: nodeById[e.source], target: nodeById[e.target] }));

    if (simulation) simulation.stop();
    simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(validEdges).id(d => d.id).distance(90).strength(0.8))
        .force('charge', d3.forceManyBody().strength(-220))
        .force('center', d3.forceCenter(W / 2, H / 2).strength(0.05))
        .force('collision', d3.forceCollide(22))
        .alphaDecay(0.03);

    const edgeGroup = graphContainer.select('.edges');
    const edgeSel = edgeGroup.selectAll('line').data(validEdges, d => `${d.source.id}=>${d.target.id}`);
    edgeSel.exit().remove();
    const edgeEnter = edgeSel.enter().append('line')
        .attr('stroke', '#d0ccc4').attr('stroke-width', 1).attr('marker-end', 'url(#arrow)').attr('opacity', 0.7);
    const allEdges = edgeEnter.merge(edgeSel);

    const nodeGroup = graphContainer.select('.nodes');
    const nodeSel = nodeGroup.selectAll('g.node').data(nodes, d => d.id);
    nodeSel.exit().remove();
    const nodeEnter = nodeSel.enter().append('g').attr('class', 'node')
        .call(d3.drag()
            .on('start', (ev, d) => { if (!ev.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
            .on('end', (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }))
        .on('mouseenter', (ev, d) => showTooltip(ev, d))
        .on('mouseleave', hideTooltip);
    nodeEnter.append('circle').attr('r', d => d.depth === 0 ? 14 : 9);
    nodeEnter.append('text').attr('dy', d => d.depth === 0 ? 24 : 20).attr('text-anchor', 'middle')
        .attr('font-family', 'IBM Plex Mono, monospace').attr('font-size', d => d.depth === 0 ? 9 : 8)
        .attr('fill', '#666').attr('pointer-events', 'none');

    const allNodes = nodeEnter.merge(nodeSel);
    allNodes.select('circle')
        .attr('fill', d => d.depth === 0 ? rootNodeColor() : NODE_COLORS[d.status] || NODE_COLORS.pending)
        .attr('stroke', d => d.depth === 0 ? 'none' : 'rgba(255,255,255,0.4)').attr('stroke-width', 1.5);
    allNodes.select('text').text(d => d.label);

    simulation.on('tick', () => {
        allEdges.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        allNodes.attr('transform', d => `translate(${d.x},${d.y})`);
    });
}

function showTooltip(event, d) {
    const tt = document.getElementById('nodeTooltip');
    tt.innerHTML = `<div style="font-weight:600;margin-bottom:3px;">${d.label}</div>
    <div style="opacity:0.6;word-break:break-all;">${d.url}</div>
    <div style="margin-top:4px;opacity:0.8;">depth ${d.depth} · ${d.image_count} images · ${d.status}</div>`;
    tt.style.left = (event.offsetX + 14) + 'px';
    tt.style.top = (event.offsetY - 10) + 'px';
    tt.classList.add('visible');
}
function hideTooltip() { document.getElementById('nodeTooltip').classList.remove('visible'); }

function resetZoom() {
    if (!svgRoot || !zoomBehavior) return;
    svgRoot.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity);
}
function centerGraph() {
    if (!svgRoot || !zoomBehavior || !graphContainer) return;
    const svgEl = document.getElementById('graphSvg');
    const W = svgEl.clientWidth, H = svgEl.clientHeight;
    svgRoot.transition().duration(400).call(
        zoomBehavior.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(0.8).translate(-W / 2, -H / 2)
    );
}

// ── RAW DATA PANEL ──
function toggleRawLive() {
    rawLiveMode = !rawLiveMode;
    const btn = document.getElementById('rawLiveToggle');
    btn.classList.toggle('active', rawLiveMode);
    document.getElementById('rawPageSelect').style.display = rawLiveMode ? 'none' : '';
    updateRawDataView();
}

function updateRawPageSelect() {
    const sel = document.getElementById('rawPageSelect');
    const currentVal = sel.value;
    const urls = Object.keys(lastRawPages);
    sel.innerHTML = '<option value="">Select a page\u2026</option>';
    urls.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u;
        const p = lastRawPages[u];
        opt.textContent = (p.title || new URL(u).pathname).substring(0, 50);
        sel.appendChild(opt);
    });
    if (currentVal && urls.includes(currentVal)) sel.value = currentVal;
    else if (urls.length > 0 && !currentVal) sel.value = urls[0];
}

function updateRawDataView() {
    const empty = document.getElementById('rawEmpty');
    const pageView = document.getElementById('rawPageView');
    const liveView = document.getElementById('rawLiveView');

    if (rawLiveMode) {
        empty.style.display = 'none';
        pageView.style.display = 'none';
        liveView.style.display = 'block';
        renderRawLive();
    } else {
        liveView.style.display = 'none';
        const sel = document.getElementById('rawPageSelect');
        if (sel.value) {
            empty.style.display = 'none';
            pageView.style.display = 'block';
            renderRawPage(sel.value);
        } else if (Object.keys(lastRawPages).length > 0) {
            empty.style.display = 'none';
            pageView.style.display = 'block';
            const first = Object.keys(lastRawPages)[0];
            document.getElementById('rawPageSelect').value = first;
            renderRawPage(first);
        } else {
            empty.style.display = 'flex';
            pageView.style.display = 'none';
        }
    }
}

function renderRawPage(url) {
    const view = document.getElementById('rawPageView');
    const data = lastRawPages[url];
    if (!data) { view.innerHTML = ''; return; }

    const intLinks = (data.links || []).filter(l => l.internal);
    const extLinks = (data.links || []).filter(l => !l.internal);
    const respHeaders = data.response_headers || {};
    const headerKeys = Object.keys(respHeaders);
    const statusCode = data.status_code || 0;
    const hasError = data.error || (statusCode && statusCode !== 200);

    let h = '';

    // Error banner
    if (hasError) {
        h += `<div class="raw-section" style="border-color:#b03020">
            <div class="raw-section-title" style="color:#b03020;background:rgba(176,48,32,0.06)">\u26a0 Error</div>
            <div class="raw-meta-grid">
                <div class="raw-kv"><span class="raw-k">Status</span><span class="raw-v" style="color:#b03020">HTTP ${statusCode || 'N/A'}</span></div>
                <div class="raw-kv"><span class="raw-k">Reason</span><span class="raw-v">${esc(data.error || 'Unknown')}</span></div>
            </div>
        </div>`;
    }

    h += `
    <div class="raw-section">
        <div class="raw-section-title">\ud83d\udcc4 Page Info</div>
        <div class="raw-meta-grid">
            <div class="raw-kv"><span class="raw-k">URL</span><span class="raw-v raw-v-url">${esc(data.url)}</span></div>
            <div class="raw-kv"><span class="raw-k">Status</span><span class="raw-v">${statusCode || '\u2014'}</span></div>
            <div class="raw-kv"><span class="raw-k">Title</span><span class="raw-v">${esc(data.title || '\u2014')}</span></div>
            <div class="raw-kv"><span class="raw-k">HTML Size</span><span class="raw-v">${(data.html_length || 0).toLocaleString()} bytes</span></div>
            <div class="raw-kv"><span class="raw-k">Image Tags</span><span class="raw-v">${data.img_tag_count || 0}</span></div>
        </div>
    </div>`;

    // Response Headers
    if (headerKeys.length > 0) {
        h += `<div class="raw-section">
            <div class="raw-section-title">\ud83d\udce1 Response Headers <span class="raw-badge">${headerKeys.length}</span></div>
            <div class="raw-link-list">${headerKeys.map(k =>
            `<div class="raw-link-row"><span class="raw-k" style="min-width:140px">${esc(k)}</span><span class="raw-v">${esc(String(respHeaders[k]).substring(0, 200))}</span></div>`
        ).join('')}</div>
        </div>`;
    }

    h += `
    <div class="raw-section">
        <div class="raw-section-title">\ud83d\udd17 Internal Links <span class="raw-badge">${intLinks.length}</span></div>
        <div class="raw-link-list">${intLinks.slice(0, 50).map(l =>
        `<div class="raw-link-row"><span class="raw-link-text">${esc(l.text || '\u2014')}</span><a class="raw-link-href" href="${esc(l.href)}" target="_blank">${esc(truncUrl(l.href))}</a></div>`
    ).join('') || '<div class="raw-empty-sub">None found</div>'}</div>
    </div>
    <div class="raw-section">
        <div class="raw-section-title">\ud83c\udf10 External Links <span class="raw-badge">${extLinks.length}</span></div>
        <div class="raw-link-list">${extLinks.slice(0, 30).map(l =>
        `<div class="raw-link-row"><span class="raw-link-text">${esc(l.text || '\u2014')}</span><a class="raw-link-href" href="${esc(l.href)}" target="_blank">${esc(truncUrl(l.href))}</a></div>`
    ).join('') || '<div class="raw-empty-sub">None found</div>'}</div>
    </div>
    <div class="raw-section">
        <div class="raw-section-title">\ud83c\udff7\ufe0f Meta Tags <span class="raw-badge">${(data.meta_tags || []).length}</span></div>
        <div class="raw-link-list">${(data.meta_tags || []).map(m =>
        `<div class="raw-link-row"><span class="raw-k" style="min-width:100px">${esc(m.name)}</span><span class="raw-v">${esc(m.content)}</span></div>`
    ).join('') || '<div class="raw-empty-sub">None found</div>'}</div>
    </div>
    <div class="raw-section">
        <div class="raw-section-title">\ud83d\udcdc Scripts <span class="raw-badge">${(data.scripts || []).length}</span></div>
        <div class="raw-link-list">${(data.scripts || []).map(s =>
        `<div class="raw-link-row"><a class="raw-link-href" href="${esc(s)}" target="_blank">${esc(s)}</a></div>`
    ).join('') || '<div class="raw-empty-sub">None found</div>'}</div>
    </div>
    <div class="raw-section">
        <div class="raw-section-title">\ud83c\udfa8 Stylesheets <span class="raw-badge">${(data.stylesheets || []).length}</span></div>
        <div class="raw-link-list">${(data.stylesheets || []).map(s =>
        `<div class="raw-link-row"><a class="raw-link-href" href="${esc(s)}" target="_blank">${esc(s)}</a></div>`
    ).join('') || '<div class="raw-empty-sub">None found</div>'}</div>
    </div>`;

    if (data.html_snippet) {
        h += `<div class="raw-section">
            <div class="raw-section-title">&lt;/&gt; HTML Snippet</div>
            <pre class="raw-html-snippet">${esc(data.html_snippet.substring(0, 1500))}</pre>
        </div>`;
    }

    view.innerHTML = h;
}

const EVENT_CONFIG = {
    page_start: { icon: '\u2192', label: 'Page Visit', color: '#486090' },
    page_done: { icon: '\u2713', label: 'Page Scraped', color: '#1f7a4a' },
    links_found: { icon: '\ud83d\udd17', label: 'Links Found', color: '#6a6a2a' },
    fullres: { icon: '\u2b06', label: 'Full-Res', color: '#6a3a8a' },
    error: { icon: '\u2717', label: 'Error', color: '#b03020' },
};

function renderRawLive() {
    const view = document.getElementById('rawLiveView');
    if (!lastCrawlEvents.length) {
        view.innerHTML = '<div class="raw-empty-sub" style="padding:30px;">Waiting for crawl events\u2026</div>';
        return;
    }
    let html = '';
    const events = lastCrawlEvents.slice(-100).reverse();
    for (const ev of events) {
        const cfg = EVENT_CONFIG[ev.type] || { icon: '\u25cf', label: ev.type, color: '#888' };
        const ts = new Date(ev.ts * 1000).toLocaleTimeString();
        let detail = '';
        if (ev.type === 'page_start') {
            detail = `<span class="raw-v-url">${esc(ev.url || '')}</span>` +
                (ev.title ? `<span class="raw-v">${esc(ev.title)}</span>` : '') +
                `<span class="raw-v">depth ${ev.depth ?? '?'}</span>`;
        } else if (ev.type === 'page_done') {
            detail = `<span class="raw-v-url">${esc(ev.url || '')}</span>` +
                `<span class="raw-v">${ev.images_found} images found \u00b7 ${ev.total_images} total</span>`;
        } else if (ev.type === 'links_found') {
            detail = `<span class="raw-v">${ev.count} links discovered</span>` +
                `<div class="raw-link-list" style="margin-top:4px">${(ev.links || []).slice(0, 5).map(l =>
                    `<div class="raw-link-row"><a class="raw-link-href" href="${esc(l)}" target="_blank">${esc(truncUrl(l))}</a></div>`
                ).join('')}</div>`;
        } else if (ev.type === 'error') {
            detail = `<span class="raw-v-url">${esc(ev.url || '')}</span>` +
                `<span class="raw-v" style="color:#b03020">HTTP ${ev.status || '?'} \u2014 ${esc(ev.reason || 'Unknown')}</span>`;
        } else {
            detail = `<span class="raw-v">${esc(JSON.stringify(ev).substring(0, 120))}</span>`;
        }

        html += `<div class="raw-event-card" style="border-left-color:${cfg.color}">
            <div class="raw-event-header">
                <span class="raw-event-icon" style="color:${cfg.color}">${cfg.icon}</span>
                <span class="raw-event-label">${cfg.label}</span>
                <span class="raw-event-ts">${ts}</span>
            </div>
            <div class="raw-event-body">${detail}</div>
        </div>`;
    }
    view.innerHTML = html;
}

function truncUrl(u) {
    try { const p = new URL(u); return p.pathname + (p.search || ''); }
    catch { return u.length > 60 ? u.substring(0, 57) + '\u2026' : u; }
}

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
    initLogResize('logResize1', 'logPanel1');
    initLogResize('logResize2', 'logPanel2');
    initLogResize('logResize3', 'logPanel3');

    document.getElementById('urlInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') startScrape();
    });
});
