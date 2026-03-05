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
let logPanelHeights = {};
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
