// ── LOG UPDATE ──
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

// ── LOG TOGGLE (MINIMIZE/RESTORE) ──
function toggleLog(panelId) {
    const panel = document.getElementById(panelId);
    if (panel.classList.contains('minimized')) {
        const savedH = logPanelHeights[panelId] || 180;
        panel.style.height = savedH + 'px';
        panel.classList.remove('minimized');
    } else {
        logPanelHeights[panelId] = panel.offsetHeight;
        panel.classList.add('minimized');
    }
}

// ── LOG RESIZE (smooth, no lag) ──
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
