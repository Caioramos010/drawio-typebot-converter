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

  // Build vertex map including UserObjects
  const allVertices = [
    ...cells.filter(c => c['$'].vertex === '1' && c['$'].id !== '0' && c['$'].id !== '1'),
    ...userObjects.filter(uo => uo.mxCell && uo.mxCell[0] && uo.mxCell[0]['$'].vertex === '1').map(uo => ({
      '$': { id: uo['$'].id, value: uo['$'].label || '' },
      mxGeometry: uo.mxCell[0].mxGeometry,
    })),
  ];

  // Get geometry
  function getGeo(id) {
    const v = allVertices.find(v2 => v2['$'].id === P + id);
    if (!v || !v.mxGeometry || !v.mxGeometry[0]) return null;
    const g = v.mxGeometry[0]['$'] || {};
    return { x: parseFloat(g.x || 0), y: parseFloat(g.y || 0), w: parseFloat(g.width || 0), h: parseFloat(g.height || 0) };
  }

  console.log('=== Geometry of key nodes ===');
  for (const id of [18, 70, 78, 90, 21, 87, 89, 92, 24, 99, 100, 101, 66, 67, 68, 69, 71, 117]) {
    const g = getGeo(id);
    if (g) {
      console.log(`  Node ${id}: x=${g.x} y=${g.y} w=${g.w} h=${g.h}`);
    } else {
      console.log(`  Node ${id}: NO GEO`);
    }
  }

  // Build edge-based adjacency (raw)
  const edges = cells.filter(c => c['$'].edge === '1');
  const adj = {};
  for (const e of edges) {
    const s = e['$'].source, t = e['$'].target;
    if (!s || !t || t === 'undefined' || s === t) continue;
    if (!adj[s]) adj[s] = [];
    adj[s].push(t);
  }

  console.log('\n=== Adjacency (explicit edges only) ===');
  for (const id of [18, 21, 24, 28, 34, 44, 66, 78, 87, 100]) {
    const children = (adj[P + id] || []).map(c => c.replace(P, ''));
    console.log(`  Node ${id}: [${children.join(', ')}]`);
  }

  // Check orphan nodes (no in-degree)
  const allTargets = new Set();
  for (const cs of Object.values(adj)) for (const c of cs) allTargets.add(c);
  console.log('\n=== Orphan nodes (no incoming edges) ===');
  for (const v of allVertices) {
    const vid = v['$'].id;
    if (!allTargets.has(vid) && vid !== P + '7') { // Exclude main menu
      const text = stripHtml(v['$'].value || '').substring(0, 60);
      console.log(`  ${vid.replace(P, '')}: ${text}`);
    }
  }
})();
