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
