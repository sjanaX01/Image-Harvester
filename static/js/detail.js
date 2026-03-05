// ── IMAGE DETAIL DASHBOARD ──
let detailImgData = null;

function openDetail(img) {
    detailImgData = img;
    document.getElementById('detailImg').src = img.url;
    document.getElementById('detailFilename').textContent = img.filename || 'Unknown';
    document.getElementById('detailSourceUrl').textContent = img.source_page || '—';
    document.getElementById('detailImgUrl').textContent = img.url;

    const ext = (img.filename || '').split('.').pop()?.toUpperCase() || '—';
    document.getElementById('detailType').textContent = ext;

    try {
        document.getElementById('detailFoundOn').textContent = new URL(img.source_page).pathname;
    } catch {
        document.getElementById('detailFoundOn').textContent = img.source_page || '—';
    }

    document.getElementById('detailCategory').textContent = img.is_thumbnail ? 'Thumbnail' : 'Full Resolution';

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
