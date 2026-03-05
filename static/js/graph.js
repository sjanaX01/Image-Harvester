// ── D3 GRAPH ──
let simulation = null, svgRoot = null, zoomBehavior = null, graphContainer = null;
let lastGraphData = { nodes: [], edges: [] };
let graphNeedsRender = false, nodeMap = {};

const NODE_COLORS = { root: '#0a0a0a', pending: '#c8c4bc', scraping: '#b06010', done: '#1f7a4a', error: '#b03020' };

function rootNodeColor() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? '#e0dcd4' : '#0a0a0a';
}

function resetGraphState() {
    simulation = null; nodeMap = {};
    lastGraphData = { nodes: [], edges: [] }; graphNeedsRender = false;
    d3.select('#graphSvg').selectAll('*').remove();
    svgRoot = null; graphContainer = null;
}

function initGraphSvg() {
    const svg = d3.select('#graphSvg');
    svg.selectAll('*').remove();
    svgRoot = svg;
    zoomBehavior = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (event) => {
        graphContainer.attr('transform', event.transform);
    });
    svg.call(zoomBehavior);
    svg.append('defs').append('marker')
        .attr('id', 'arrow').attr('viewBox', '0 -4 8 8')
        .attr('refX', 18).attr('refY', 0).attr('markerWidth', 5).attr('markerHeight', 5)
        .attr('orient', 'auto').append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#c0bbb0');
    graphContainer = svg.append('g').attr('class', 'graph-container');
    graphContainer.append('g').attr('class', 'edges');
    graphContainer.append('g').attr('class', 'nodes');
}

function renderGraph(data) {
    const { nodes, edges } = data;
    if (!nodes || nodes.length === 0) return;
    const svgEl = document.getElementById('graphSvg');
    const W = svgEl.clientWidth || 800, H = svgEl.clientHeight || 500;
    if (!svgRoot || !graphContainer) initGraphSvg();

    const nodeById = {};
    nodes.forEach(n => { nodeById[n.id] = n; });
    nodes.forEach(n => {
        if (nodeMap[n.id]) { n.x = nodeMap[n.id].x; n.y = nodeMap[n.id].y; n.vx = nodeMap[n.id].vx || 0; n.vy = nodeMap[n.id].vy || 0; }
    });
    nodes.forEach(n => { nodeMap[n.id] = n; });

    const validEdges = edges.filter(e => nodeById[e.source] && nodeById[e.target])
        .map(e => ({ source: nodeById[e.source], target: nodeById[e.target] }));

    if (simulation) simulation.stop();
    simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(validEdges).id(d => d.id).distance(90).strength(0.8))
        .force('charge', d3.forceManyBody().strength(-220))
        .force('center', d3.forceCenter(W / 2, H / 2).strength(0.05))
        .force('collision', d3.forceCollide(22))
        .alphaDecay(0.03);

    const edgeGroup = graphContainer.select('.edges');
    const edgeSel = edgeGroup.selectAll('line').data(validEdges, d => `${d.source.id}=>${d.target.id}`);
    edgeSel.exit().remove();
    const edgeEnter = edgeSel.enter().append('line')
        .attr('stroke', '#d0ccc4').attr('stroke-width', 1).attr('marker-end', 'url(#arrow)').attr('opacity', 0.7);
    const allEdges = edgeEnter.merge(edgeSel);

    const nodeGroup = graphContainer.select('.nodes');
    const nodeSel = nodeGroup.selectAll('g.node').data(nodes, d => d.id);
    nodeSel.exit().remove();
    const nodeEnter = nodeSel.enter().append('g').attr('class', 'node')
        .call(d3.drag()
            .on('start', (ev, d) => { if (!ev.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
            .on('end', (ev, d) => { if (!ev.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }))
        .on('mouseenter', (ev, d) => showTooltip(ev, d))
        .on('mouseleave', hideTooltip);
    nodeEnter.append('circle').attr('r', d => d.depth === 0 ? 14 : 9);
    nodeEnter.append('text').attr('dy', d => d.depth === 0 ? 24 : 20).attr('text-anchor', 'middle')
        .attr('font-family', 'IBM Plex Mono, monospace').attr('font-size', d => d.depth === 0 ? 9 : 8)
        .attr('fill', '#666').attr('pointer-events', 'none');

    const allNodes = nodeEnter.merge(nodeSel);
    allNodes.select('circle')
        .attr('fill', d => d.depth === 0 ? rootNodeColor() : NODE_COLORS[d.status] || NODE_COLORS.pending)
        .attr('stroke', d => d.depth === 0 ? 'none' : 'rgba(255,255,255,0.4)').attr('stroke-width', 1.5);
    allNodes.select('text').text(d => d.label);

    simulation.on('tick', () => {
        allEdges.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        allNodes.attr('transform', d => `translate(${d.x},${d.y})`);
    });
}

function showTooltip(event, d) {
    const tt = document.getElementById('nodeTooltip');
    tt.innerHTML = `<div style="font-weight:600;margin-bottom:3px;">${d.label}</div>
    <div style="opacity:0.6;word-break:break-all;">${d.url}</div>
    <div style="margin-top:4px;opacity:0.8;">depth ${d.depth} · ${d.image_count} images · ${d.status}</div>`;
    tt.style.left = (event.offsetX + 14) + 'px';
    tt.style.top = (event.offsetY - 10) + 'px';
    tt.classList.add('visible');
}
function hideTooltip() { document.getElementById('nodeTooltip').classList.remove('visible'); }

function resetZoom() {
    if (!svgRoot || !zoomBehavior) return;
    svgRoot.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity);
}
function centerGraph() {
    if (!svgRoot || !zoomBehavior || !graphContainer) return;
    const svgEl = document.getElementById('graphSvg');
    const W = svgEl.clientWidth, H = svgEl.clientHeight;
    svgRoot.transition().duration(400).call(
        zoomBehavior.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(0.8).translate(-W / 2, -H / 2)
    );
}
