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

  // resolveTargetByCoord (replicate from converter)
  function resolveTargetByCoord(edgeGeo, srcId) {
    if (!edgeGeo || !edgeGeo[0]) return null;
    const pts = edgeGeo[0].mxPoint || [];
    const tgtPt = pts.find(p => p['$'].as === 'targetPoint');
    if (!tgtPt) return null;
    const tx = parseFloat(tgtPt['$'].x);
    const ty = parseFloat(tgtPt['$'].y);
    if (isNaN(tx) || isNaN(ty)) return null;
    let bestId = null;
    let bestDist = Infinity;
    for (const [vid, g] of vertexGeo) {
      if (vid === srcId) continue;
      if (tx >= g.x && tx <= g.x + g.w && ty >= g.y && ty <= g.y + g.h) return vid;
      const dist = Math.hypot(tx - g.cx, ty - g.cy);
      if (dist < bestDist) { bestDist = dist; bestId = vid; }
    }
    return bestId;
  }

  // Test coordinate resolution for node 7's undefined edges
  console.log('=== Coordinate resolution for undefined-target edges ===');
  const vertexIds = new Set(vertices.map(v => v['$'].id));
  const parentOf = {};
  for (const c of cells) {
    const p = c['$'].parent;
    if (p && p !== '0' && p !== '1' && vertexIds.has(p)) {
      parentOf[c['$'].id] = p;
    }
  }
  function resolveParent(id) {
    const visited = new Set();
    let cur = id;
    while (parentOf[cur] && !visited.has(cur)) {
      visited.add(cur);
      cur = parentOf[cur];
    }
    return cur;
  }

  // Process ALL edges as converter does
  const adjacency = {};
  const brokenEdgeSources = new Set();
  for (const e of edges) {
    let src = e['$'].source;
    const tgt = e['$'].target;
    if (!src) continue;
    src = resolveParent(src);
    let resolvedTgt = (tgt && tgt !== 'undefined')
      ? tgt
      : resolveTargetByCoord(e.mxGeometry, src);
    if (!resolvedTgt) {
      brokenEdgeSources.add(src);
      console.log(`  BROKEN: ${src.replace(P,'')} -> (no target, no resolution)`);
      continue;
    }
    resolvedTgt = resolveParent(resolvedTgt);
    if (resolvedTgt === src) continue;
    if (!adjacency[src]) adjacency[src] = [];
    if (!adjacency[src].includes(resolvedTgt)) adjacency[src].push(resolvedTgt);
  }

  console.log('\n=== Full adjacency (with coordinate resolution) ===');
  for (const nid of [7, 14, 18, 21, 24, 28, 34, 44, 66, 78, 87, 100]) {
    const fullId = P + nid;
    const children = (adjacency[fullId] || []).map(c => c.replace(P, ''));
    const text = (stripHtml(vertices.find(v=>v['$'].id===fullId)?.['$']?.value||'').substring(0,40));
    console.log(`  Node ${nid} [${children.length} children]: ${children.join(', ')}  "${text}"`);
  }

  console.log('\nBroken edge sources:', [...brokenEdgeSources].map(s => s.replace(P, '')).join(', '));
})();
