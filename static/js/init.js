// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
    initLogResize('logResize1', 'logPanel1');
    initLogResize('logResize2', 'logPanel2');
    initLogResize('logResize3', 'logPanel3');

    document.getElementById('urlInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') startScrape();
    });
});
