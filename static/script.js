// ── STATE ──
let jobId = null;
let pollTimer = null;
let shownImages = new Set();
let currentView = 'gallery';
let followLinks = true;
let exhaustAll = false;
let detectFullres = false;
let selectedImages = new Set();
let allSelectMode = false;
let allImageDetails = [];
let currentDetailImg = null;
let logPanelHeights = {};  // stores height before minimize

// ── VIEW SWITCHING ──
function switchView(v, el) {
    currentView = v;
    document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    if (el) el.classList.add('active');
    const panelMap = { gallery: 'panelGallery', graph: 'panelGraph', queue: 'panelQueue' };
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
    } else if (which === 'fullres') {
        detectFullres = !detectFullres;
        document.getElementById('fullresToggle').classList.toggle('on', detectFullres);
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
    document.getElementById('downloadSelBtn').disabled = true;
    document.getElementById('selectAllBtn').classList.remove('active');
    document.getElementById('graphEmpty').style.display = 'flex';
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
            detect_fullres: detectFullres,
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

function downloadZip() {
    if (!jobId) return;
    document.getElementById('zipOverlay').classList.add('open');
    document.getElementById('zipDetail').textContent = 'Preparing…';
    document.getElementById('zipBar').style.width = '0%';
    // Start polling zip progress
    const zpTimer = setInterval(async () => {
        try {
            const res = await fetch(`/status/${jobId}`);
            const data = await res.json();
            if (data.zip_progress) {
                showZipProgress(data.zip_progress);
                if (data.zip_progress.status === 'done') {
                    clearInterval(zpTimer);
                    document.getElementById('zipOverlay').classList.remove('open');
                }
            }
        } catch (e) { }
    }, 500);
    window.location.href = `/download/${jobId}`;
    // Fallback close
    setTimeout(() => {
        clearInterval(zpTimer);
        document.getElementById('zipOverlay').classList.remove('open');
    }, 30000);
}

async function downloadSelected() {
    if (!jobId || selectedImages.size === 0) return;
    document.getElementById('zipOverlay').classList.add('open');
    document.getElementById('zipDetail').textContent = `Packaging ${selectedImages.size} images…`;
    document.getElementById('zipBar').style.width = '50%';

    const res = await fetch(`/download-selected/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: Array.from(selectedImages) })
    });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'selected_images.zip';
    a.click();
    URL.revokeObjectURL(a.href);

    document.getElementById('zipBar').style.width = '100%';
    setTimeout(() => { document.getElementById('zipOverlay').classList.remove('open'); }, 500);
}

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

function rebuildGallery() {
    const content = document.getElementById('galleryContent');
    content.innerHTML = '';

    const thumbnails = allImageDetails.filter(img => img.is_thumbnail);
    const fullres = allImageDetails.filter(img => !img.is_thumbnail);

    if (thumbnails.length > 0) {
        const sec = document.createElement('div');
        sec.innerHTML = `<div class="section-divider">Thumbnails <span class="count">${thumbnails.length}</span></div>`;
        content.appendChild(sec);

        const grid = document.createElement('div');
        grid.className = 'gallery';
        thumbnails.forEach(img => grid.appendChild(createImageCard(img)));
        content.appendChild(grid);
    }

    if (fullres.length > 0) {
        const sec = document.createElement('div');
        sec.innerHTML = `<div class="section-divider" style="margin-top:16px;">Full-Resolution Images <span class="count">${fullres.length}</span></div>`;
        content.appendChild(sec);

        const grid = document.createElement('div');
        grid.className = 'gallery';
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
    document.getElementById('downloadSelBtn').disabled = selectedImages.size === 0;
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
    document.getElementById('downloadSelBtn').disabled = selectedImages.size === 0;
}

function clearSelection() {
    selectedImages.clear();
    allSelectMode = false;
    document.getElementById('selectAllBtn').classList.remove('active');
    document.querySelectorAll('.img-card').forEach(c => c.classList.remove('selected'));
    document.getElementById('downloadSelBtn').disabled = true;
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
    document.getElementById('downloadSelBtn').disabled = selectedImages.size === 0;
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

// Resizable logs
function initLogResize(handleId, panelId) {
    const handle = document.getElementById(handleId);
    const panel = document.getElementById(panelId);
    if (!handle || !panel) return;

    let startY, startH;
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startY = e.clientY;
        startH = panel.offsetHeight;
        const onMove = (e2) => {
            const diff = startY - e2.clientY;
            const newH = Math.max(60, Math.min(500, startH + diff));
            panel.style.height = newH + 'px';
        };
        const onUp = () => {
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
        .attr('fill', d => d.depth === 0 ? NODE_COLORS.root : NODE_COLORS[d.status] || NODE_COLORS.pending)
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

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
    initLogResize('logResize1', 'logPanel1');
    initLogResize('logResize2', 'logPanel2');
    initLogResize('logResize3', 'logPanel3');

    document.getElementById('urlInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') startScrape();
    });
});
