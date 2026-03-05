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
