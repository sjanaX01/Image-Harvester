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

// ── EXPORT ──
function triggerDownload(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 100);
}

function csvEsc(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

function exportImages(format) {
    if (!allImageDetails.length) { showWarn('⚠ No image data to export yet.', 3000); return; }
    const base = jobId || 'images';
    if (format === 'json') {
        triggerDownload(
            new Blob([JSON.stringify(allImageDetails, null, 2)], { type: 'application/json' }),
            `${base}_images.json`
        );
    } else {
        const cols = ['url', 'filename', 'source_page', 'file_size', 'is_thumbnail', 'fullres_url'];
        const rows = allImageDetails.map(img =>
            [img.url, img.filename, img.source_page, img.file_size ?? '', img.is_thumbnail, img.fullres_url ?? '']
            .map(csvEsc).join(',')
        );
        triggerDownload(
            new Blob([[cols.join(','), ...rows].join('\r\n')], { type: 'text/csv' }),
            `${base}_images.csv`
        );
    }
}

function exportRawData(format) {
    const pages = Object.values(lastRawPages);
    if (!pages.length) { showWarn('⚠ No raw data to export yet.', 3000); return; }
    const base = jobId || 'rawdata';
    if (format === 'json') {
        triggerDownload(
            new Blob([JSON.stringify(lastRawPages, null, 2)], { type: 'application/json' }),
            `${base}_rawdata.json`
        );
    } else {
        const cols = ['url', 'title', 'status_code', 'html_length', 'img_tag_count',
                      'internal_links', 'external_links', 'meta_count', 'scripts', 'stylesheets'];
        const rows = pages.map(p => {
            const links = p.links || [];
            return [
                p.url, p.title ?? '', p.status_code ?? '', p.html_length ?? '',
                p.img_tag_count ?? '',
                links.filter(l => l.internal).length,
                links.filter(l => !l.internal).length,
                (p.meta_tags || []).length,
                (p.scripts || []).length,
                (p.stylesheets || []).length,
            ].map(csvEsc).join(',');
        });
        triggerDownload(
            new Blob([[cols.join(','), ...rows].join('\r\n')], { type: 'text/csv' }),
            `${base}_rawdata.csv`
        );
    }
}
