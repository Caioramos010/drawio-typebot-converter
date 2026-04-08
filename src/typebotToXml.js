/**
 * Conversor Typebot JSON → DrawIO XML
 *
 * Percorre grupos/blocos do Typebot e gera mxCell vertices + edges
 * para cada grupo de conteúdo, conditions e suas saídas.
 */

const { generateId, richTextToPlain } = require('./utils');

// Dimensões padrão de células
const NODE_W = 220;
const NODE_H_BASE = 60;
const NODE_H_PER_LINE = 14;
const SUBMENU_W = 130;
const STEP_X = 320;
const STEP_Y = 180;

async function typebotToXml(typebot) {
  const cells = [];
  // Células base obrigatórias do drawio
  cells.push(mxCell({ id: '0' }));
  cells.push(mxCell({ id: '1', parent: '0' }));

  // Mapa groupId → posição (x,y) no canvas
  const posMap = {};
  // Mapa blockId → cellId do drawio
  const blockToCellId = {};

  // Resolve posição de cada grupo
  for (const grp of typebot.groups || []) {
    const coord = grp.graphCoordinates || { x: 0, y: 0 };
    posMap[grp.id] = { x: coord.x, y: coord.y };
  }

  // ─── Processar grupos ────────────────────────────────────────────────────
  let globalY = 0;

  for (const grp of typebot.groups || []) {
    const pos = posMap[grp.id] || { x: 0, y: globalY };

    // Determina o conteúdo textual do grupo para o vértice
    let groupLabel = '';
    let currentY = pos.y;

    for (const block of grp.blocks || []) {
      if (block.type === 'text') {
        const text = richTextToPlain(block.content?.richText);
        groupLabel += (groupLabel ? '\n' : '') + text;
      } else if (block.type === 'Typebot link') {
        groupLabel += (groupLabel ? '\n' : '') + `[Fila: ${block.options?.typebotId || ''}]`;
      } else if (block.type === 'Webhook') {
        groupLabel += (groupLabel ? '\n' : '') + `[Webhook: ${block.options?.webhook?.url || ''}]`;
      } else if (block.type === 'Wait') {
        groupLabel += (groupLabel ? '\n' : '') + `[Aguardar ${block.options?.secondsToWaitFor || '?'}s]`;
      }
    }

    const lineCount = (groupLabel.match(/\n/g) || []).length + 1;
    const cellH = Math.max(NODE_H_BASE, lineCount * NODE_H_PER_LINE + 20);
    const cellId = `grp_${grp.id.replace(/-/g, '').substring(0, 12)}`;

    // Mapeia todos os blockIds para esse cellId (para as arestas)
    for (const block of grp.blocks || []) {
      blockToCellId[block.id] = cellId;
      // Também mapeia items de Condition
      if (block.type === 'Condition') {
        for (const item of block.items || []) {
          blockToCellId[item.id] = cellId;
        }
      }
    }

    // Também mapeia o groupId para o cellId (edges que apontam para grupo)
    blockToCellId[grp.id] = cellId;

    // Converter \n em &#xa; para o DrawIO renderizar quebras de linha corretamente
    const labelXml = escapeXml(groupLabel || grp.title || '').replace(/\n/g, '&#xa;');

    cells.push(mxCell({
      id: cellId,
      parent: '1',
      vertex: '1',
      value: labelXml,
      style: 'rounded=0;whiteSpace=wrap;html=1;labelBackgroundColor=none;',
      geometry: { x: pos.x, y: pos.y, width: NODE_W, height: cellH },
    }));

    globalY += cellH + STEP_Y;
  }

  // ─── Processar events (start) ────────────────────────────────────────────
  for (const evt of typebot.events || []) {
    const coord = evt.graphCoordinates || { x: -100, y: 0 };
    const evtCellId = `evt_${evt.id.replace(/-/g, '').substring(0, 12)}`;
    blockToCellId[evt.id] = evtCellId;
    cells.push(mxCell({
      id: evtCellId,
      parent: '1',
      vertex: '1',
      value: 'START',
      style: 'ellipse;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
      geometry: { x: coord.x, y: coord.y, width: 80, height: 40 },
    }));
  }

  // ─── Processar edges ─────────────────────────────────────────────────────
  for (const edge of typebot.edges || []) {
    const srcId = edge.from?.blockId || edge.from?.eventId;
    const tgtGroupId = edge.to?.groupId;
    const tgtBlockId = edge.to?.blockId;

    const srcCell = blockToCellId[srcId] || srcId;
    const tgtCell = blockToCellId[tgtGroupId] || blockToCellId[tgtBlockId] || tgtGroupId || tgtBlockId;

    if (!srcCell || !tgtCell) continue;

    const edgeCellId = `edge_${edge.id.replace(/-/g, '').substring(0, 12)}`;
    cells.push(mxCell({
      id: edgeCellId,
      parent: '1',
      edge: '1',
      source: srcCell,
      target: tgtCell,
      style: 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;labelBackgroundColor=none;',
      geometry: { relative: 1 },
    }));
  }

  // ─── Montar XML final ─────────────────────────────────────────────────────
  const cellsXml = cells.map(renderCell).join('\n        ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net">
  <diagram name="Página-1" id="${generateId()}">
    <mxGraphModel dx="1515" dy="737" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1654" pageHeight="1169" math="0" shadow="0">
      <root>
        ${cellsXml}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

// ─── Helpers de XML ────────────────────────────────────────────────────────────

function mxCell(opts) {
  return opts;
}

function renderCell(c) {
  if (c.vertex) {
    const g = c.geometry;
    return `<mxCell id="${c.id}" parent="${c.parent}" vertex="1" value="${c.value}" style="${c.style}">
          <mxGeometry x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" as="geometry" />
        </mxCell>`;
  }
  if (c.edge) {
    return `<mxCell id="${c.id}" parent="${c.parent}" edge="1" source="${c.source}" target="${c.target}" style="${c.style}">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>`;
  }
  // Base cells (id=0, id=1)
  return `<mxCell id="${c.id}" ${c.parent ? `parent="${c.parent}"` : ''} />`;
}

function escapeXml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { typebotToXml };
