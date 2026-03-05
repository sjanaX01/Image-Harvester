// ── IMAGE GALLERY ──
function renderNewImages(imageDetails) {
    if (!imageDetails || imageDetails.length === 0) return;

    const content = document.getElementById('galleryContent');
    const empty = document.getElementById('galleryEmpty');
    if (empty) empty.remove();

    const newOnes = imageDetails.filter(img => !shownImages.has(img.url));
    if (newOnes.length === 0) return;

    newOnes.forEach(img => {
        shownImages.add(img.url);
        allImageDetails.push(img);
    });

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
