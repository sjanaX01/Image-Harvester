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
                `<span class="raw-v">${ev.images_found} images found · ${ev.total_images} total</span>`;
        } else if (ev.type === 'links_found') {
            detail = `<span class="raw-v">${ev.count} links discovered</span>` +
                `<div class="raw-link-list" style="margin-top:4px">${(ev.links || []).slice(0, 5).map(l =>
                    `<div class="raw-link-row"><a class="raw-link-href" href="${esc(l)}" target="_blank">${esc(truncUrl(l))}</a></div>`
                ).join('')}</div>`;
        } else if (ev.type === 'error') {
            detail = `<span class="raw-v-url">${esc(ev.url || '')}</span>` +
                `<span class="raw-v" style="color:#b03020">HTTP ${ev.status || '?'} — ${esc(ev.reason || 'Unknown')}</span>`;
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
