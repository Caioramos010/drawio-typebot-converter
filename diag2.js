const fs = require('fs');
const xml2js = require('xml2js');
const { stripHtml, detectMenuItems } = require('./src/utils');

(async () => {
  const xml = fs.readFileSync('test-input.xml', 'utf8');
  const parsed = await xml2js.parseStringPromise(xml, { explicitArray: true });
  const root = parsed.mxfile.diagram[0].mxGraphModel[0].root[0];
  const cells = root.mxCell || [];
  const userObjects = root.UserObject || [];
  const P = 'Zj-whqz9mNZbiH2NHCfn-';

  const userObjVertices = userObjects
    .filter(uo => uo.mxCell && uo.mxCell[0] && uo.mxCell[0]['$'].vertex === '1')
    .map(uo => ({
      '$': { id: uo['$'].id, value: uo['$'].label || '', _linkText: uo['$'].link || '', vertex: '1' },
      mxGeometry: uo.mxCell[0].mxGeometry,
    }));
  const vertices = [
    ...cells.filter(c => c['$'].vertex === '1' && c['$'].id !== '0' && c['$'].id !== '1'),
    ...userObjVertices,
  ];
  const edges = cells.filter(c => c['$'].edge === '1');

  // Build vertexGeo
  const vertexGeo = new Map();
  for (const v of vertices) {
    const g = v.mxGeometry && v.mxGeometry[0] && v.mxGeometry[0]['$'] || {};
    const x = parseFloat(g.x || 0), y = parseFloat(g.y || 0);
    const w = parseFloat(g.width || 0), h = parseFloat(g.height || 0);
    vertexGeo.set(v['$'].id, { x, y, w, h, cx: x + w/2, cy: y + h/2 });
  }

  // Build nodeContent
  const nodeContent = {};
  for (const v of vertices) {
    const raw = v['$'].value || '';
    const linkText = v['$']._linkText || '';
    const text = linkText ? stripHtml(linkText).trim() : stripHtml(raw).trim();
    nodeContent[v['$'].id] = { raw, text };
  }

  // Build adjacency (replicating converter logic but simplified)
  const adj = {};
  for (const e of edges) {
    const src = e['$'].source, tgt = e['$'].target;
    if (!src || !tgt || tgt === 'undefined' || src === tgt) continue;
    if (!adj[src]) adj[src] = [];
    if (!adj[src].includes(tgt)) adj[src].push(tgt);
  }

  // Compute in-degree
  const inDeg = {};
  for (const targets of Object.values(adj)) {
    for (const t of targets) inDeg[t] = (inDeg[t] || 0) + 1;
  }

  // Find orphans
  const mainNodeId = P + '7';
  const orphans = vertices.filter(v => !inDeg[v['$'].id] && v['$'].id !== mainNodeId);

  console.log('=== ORPHAN NODES ===');
  for (const o of orphans) {
    const id = o['$'].id.replace(P, '');
    const text = (nodeContent[o['$'].id]?.text || '').substring(0, 60);
    const geo = vertexGeo.get(o['$'].id);
    console.log(`  ${id}: x=${geo?.x} y=${geo?.y} "${text}"`);
  }

  // Simulate orphan repair for specific menu nodes
  console.log('\n=== MENU NODES AND THEIR ITEMS ===');
  for (const nid of [7, 14, 18, 21, 24, 28, 34, 44, 66, 78, 87, 100]) {
    const fullId = P + nid;
    const text = nodeContent[fullId]?.text || '';
    const items = detectMenuItems(text);
    const children = adj[fullId] || [];
    if (items.length < 2) continue;

    console.log(`\n  Node ${nid}: ${items.length} items, ${children.length} children`);
    console.log(`    Items: ${items.map(i => i.number + '=' + i.label.substring(0, 25)).join(', ')}`);
    console.log(`    Children: ${children.map(c => c.replace(P, '')).join(', ')}`);

    // Check which items are linked
    const linkedNums = new Set();
    for (const childId of children) {
      const childText = (nodeContent[childId]?.text || '').trim();
      const m = childText.match(/^(\d+)[.\)\-*\s]/);
      if (m) linkedNums.add(parseInt(m[1], 10));
    }
    console.log(`    LinkedNums: {${[...linkedNums].join(', ')}}`);

    // Check which items are unlinked
    for (const item of items) {
      if (!linkedNums.has(item.number)) {
        // Find matching orphans
        const matches = orphans.filter(o => {
          const oText = (nodeContent[o['$'].id]?.text || '').trim();
          const m = oText.match(/^(\d+)[.\)\-*\s]/);
          return m && parseInt(m[1], 10) === item.number;
        });
        console.log(`    UNLINKED item ${item.number} (${item.label.substring(0, 25)}): ${matches.length} orphan candidates`);
        for (const m of matches) {
          const mid = m['$'].id.replace(P, '');
          const mText = (nodeContent[m['$'].id]?.text || '').substring(0, 40);
          const mGeo = vertexGeo.get(m['$'].id);
          const srcGeo = vertexGeo.get(fullId);
          const dist = srcGeo && mGeo ? Math.hypot(mGeo.cx - srcGeo.cx, mGeo.cy - srcGeo.cy).toFixed(0) : '?';
          const rightOf = srcGeo && mGeo ? mGeo.cx > srcGeo.cx : '?';
          console.log(`      ${mid}: dist=${dist} rightOf=${rightOf} "${mText}"`);
        }
      }
    }
  }
})();
