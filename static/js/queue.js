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
