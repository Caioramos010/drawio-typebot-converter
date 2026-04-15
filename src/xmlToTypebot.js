/**
 * Conversor determinístico DrawIO XML → Typebot JSON
 *
 * Estratégia sem IA:
 *  1. Parseia o XML com xml2js
 *  2. Separa vértices (nodes) de arestas (edges)
 *  3. Extrai texto puro de cada vértice (strip HTML)
 *  4. Detecta padrões estruturais: menu (tem lista numerada), resposta final, submenu
 *  5. Monta grupos, blocos e edges no formato Typebot 6.1
 *
 * A IA só é chamada quando um bloco tem HTML muito complexo e o texto extraído
 * resulta em menos de 20 caracteres (conteúdo ininteligível).
 */

const xml2js = require('xml2js');
const { v4: uuidv4 } = require('uuid');
const { stripHtml, detectMenuItems, generateId, cleanResponseText } = require('./utils');

// ─── Constantes de layout ────────────────────────────────────────────────────
const LAYOUT = {
  startX: -38.51,
  startY: 171.84,
  initX: 307.68,
  initY: -5.36,
  mainX: 716.54,
  mainY: -1.86,
  responseBaseX: 1124.75,
  responseStepY: 400,
};

// ─── Exportação principal ─────────────────────────────────────────────────────
async function xmlToTypebot(xmlString, options = {}) {
  const { tokenWhatsapp = 'SEU_TOKEN_AQUI', flowName = 'Novo Fluxo', queueIds = {}, workspaceId = '', folderId = null, openaiClient = null } = options;

  // 1. Parse XML
  const parsed = await xml2js.parseStringPromise(xmlString, { explicitArray: true });
  const diagrams = parsed?.mxfile?.diagram || [];
  if (!diagrams.length) throw new Error('XML inválido: estrutura mxGraphModel não encontrada');

  // Em diagramas multi-página, usa a página com mais nós de conteúdo
  let root = null;
  for (const diagram of diagrams) {
    const r = diagram?.mxGraphModel?.[0]?.root?.[0];
    if (!r) continue;
    const count = (r.mxCell?.length || 0) + (r.UserObject?.length || 0);
    if (!root || count > (root.mxCell?.length || 0) + (root.UserObject?.length || 0)) {
      root = r;
    }
  }
  if (!root) throw new Error('XML inválido: estrutura mxGraphModel não encontrada');

  const cells = root.mxCell || [];

  // 2. Separar vértices e arestas (suporte a mxCell e UserObject)
  // UserObject: nó com label HTML + atributo "link" com texto mais limpo
  const userObjects = root.UserObject || [];
  const userObjVertices = userObjects
    .filter(uo => uo.mxCell?.[0]?.$.vertex === '1')
    .map(uo => ({
      $: {
        id: uo.$.id,
        value: uo.$.label || '',
        _linkText: uo.$.link || '',
        vertex: '1',
      },
      mxGeometry: uo.mxCell?.[0]?.mxGeometry,
    }));

  const vertices = [
    ...cells.filter(c => c.$.vertex === '1' && c.$.id !== '0' && c.$.id !== '1'),
    ...userObjVertices,
  ];
  const edges = cells.filter(c => c.$.edge === '1');

  // 3. Construir mapa de adjacência: sourceId → [targetId]
  // Suporta dois formatos de aresta:
  //   a) target="nodeId"  — conexão explícita (formato padrão)
  //   b) sem target attr, mas com mxPoint as="targetPoint" — aresta "flutuante"
  //      (frequente em diagramas exportados sem snap a nós)
  const adjacency = {};
  const edgeMap = {};
  const brokenEdgeSources = new Set();

  // Pré-indexa geometria de cada vértice para resolução de arestas por coordenada
  const vertexGeo = new Map(); // id → { x, y, w, h, cx, cy }
  for (const v of vertices) {
    const g = v.mxGeometry?.[0]?.$ || {};
    const x = parseFloat(g.x || 0);
    const y = parseFloat(g.y || 0);
    const w = parseFloat(g.width || 0);
    const h = parseFloat(g.height || 0);
    vertexGeo.set(v.$.id, { x, y, w, h, cx: x + w / 2, cy: y + h / 2 });
  }

  // Resolve target de aresta flutuante pela coordenada mxPoint as="targetPoint"
  function resolveTargetByCoord(edgeGeo, srcId) {
    if (!edgeGeo?.[0]) return null;
    const pts = edgeGeo[0].mxPoint || [];
    const tgtPt = pts.find(p => p.$.as === 'targetPoint');
    if (!tgtPt) return null;
    const tx = parseFloat(tgtPt.$.x);
    const ty = parseFloat(tgtPt.$.y);
    if (isNaN(tx) || isNaN(ty)) return null;
    let bestId = null;
    let bestDist = Infinity;
    for (const [vid, g] of vertexGeo) {
      if (vid === srcId) continue;
      // Bounding-box hit: preferência absoluta
      if (tx >= g.x && tx <= g.x + g.w && ty >= g.y && ty <= g.y + g.h) return vid;
      // Caso contrário: guarda o mais próximo por distância euclidiana ao centro
      const dist = Math.hypot(tx - g.cx, ty - g.cy);
      if (dist < bestDist) { bestDist = dist; bestId = vid; }
    }
    return bestId;
  }

  // Resolve células-filhas dentro de containers/grupos:
  // Em DrawIO, sub-cells possuem parent=containerId. Arestas originadas de sub-cells
  // devem ser mapeadas para o container (vértice de conteúdo).
  const vertexIds = new Set(vertices.map(v => v.$.id));
  const parentOf = {}; // cellId → ancestral vértice mais próximo
  const allCells = [...cells, ...userObjects.map(uo => uo.mxCell?.[0]).filter(Boolean)];
  for (const c of cells) {
    const p = c.$.parent;
    if (p && p !== '0' && p !== '1' && vertexIds.has(p)) {
      parentOf[c.$.id] = p;
    }
  }
  // Resolve transitivamente (sub-sub-cells)
  function resolveParent(id) {
    const visited = new Set();
    let cur = id;
    while (parentOf[cur] && !visited.has(cur)) {
      visited.add(cur);
      cur = parentOf[cur];
    }
    return cur;
  }

  for (const e of edges) {
    let src = e.$.source;
    const tgt = e.$.target;
    if (!src) continue;
    // Resolve sub-cell para o vértice-container pai
    src = resolveParent(src);
    // Resolve target: explícito ou por coordenada de ponto-final
    let resolvedTgt = (tgt && tgt !== 'undefined')
      ? tgt
      : resolveTargetByCoord(e.mxGeometry, src);
    if (!resolvedTgt) {
      brokenEdgeSources.add(src);
      continue;
    }
    // Resolve sub-cell target para o vértice-container pai
    resolvedTgt = resolveParent(resolvedTgt);
    if (!adjacency[src]) adjacency[src] = [];
    // Ignora self-loops (arestas que apontam para o próprio nó)
    if (resolvedTgt === src) continue;
    if (!adjacency[src].includes(resolvedTgt)) adjacency[src].push(resolvedTgt);
    edgeMap[e.$.id] = { source: src, target: resolvedTgt };
  }

  // 4. Graus de entrada/saída calculados da adjacência resolvida
  const inDegree = {};
  const outDegree = {};
  for (const [src, tgts] of Object.entries(adjacency)) {
    outDegree[src] = (outDegree[src] || 0) + tgts.length;
    for (const tgt of tgts) inDegree[tgt] = (inDegree[tgt] || 0) + 1;
  }

  // Ordena vértices por grau de saída decrescente para pegar o menu principal primeiro
  const sortedByOut = [...vertices].sort((a, b) => (outDegree[b.$.id] || 0) - (outDegree[a.$.id] || 0));

  // 5. Extrair conteúdo de cada vértice
  // UserObject: usa atributo "link" como fonte de texto preferencial (mais limpo que o label HTML)
  const nodeContent = {};
  const needsAI = [];
  for (const v of vertices) {
    const raw = v.$.value || '';
    const linkText = v.$._linkText || '';
    // link attribute (UserObject) → stripHtml para remover spans residuais
    // value attribute (mxCell)    → stripHtml normal
    const text = linkText ? stripHtml(linkText).trim() : stripHtml(raw).trim();
    nodeContent[v.$.id] = { raw, text, vertex: v };
    // Só aciona IA para mxCell com HTML ilegível (UserObject tem link limpo)
    if (!linkText && raw.includes('<') && text.length < 20) {
      needsAI.push(v.$.id);
    }
  }

  // 6. Chamar IA apenas para os nós que precisam (otimização de tokens)
  if (needsAI.length > 0 && openaiClient) {
    await enrichWithAI(needsAI, nodeContent, openaiClient);
  }

  // 6b. Interpretação semântica com IA — identifica mainMenu e mapeamento opção→nó
  // Esta é a fonte primária de verdade quando a IA está disponível.
  let flowMap = null;
  if (openaiClient) {
    try {
      flowMap = await interpretFlowWithAI(nodeContent, adjacency, vertices, openaiClient);
    } catch (e) {
      console.warn('[xmlToTypebot] IA não pôde interpretar o fluxo, usando heurística:', e.message);
    }
  }

  // 7. Identificar o menu principal usando BFS de acessibilidade:
  //    O menu raiz é o menu candidato que NÃO pode ser alcançado a partir de nenhum outro candidato.
  let mainNodeId = null;

  if (flowMap?.mainMenuNodeId && nodeContent[flowMap.mainMenuNodeId]) {
    // IA identificou o menu principal diretamente
    mainNodeId = flowMap.mainMenuNodeId;
  } else {
    // Fallback heurístico: candidatos com >= 3 itens numerados
    const menuCandidates = vertices.filter(v => detectMenuItems(nodeContent[v.$.id].text).length >= 3);
    const menuCandidateIds = new Set(menuCandidates.map(v => v.$.id));
    const reachableAsMC = new Set();
    for (const src of menuCandidates) {
      const visited = new Set();
      const queue = [src.$.id];
      while (queue.length > 0) {
        const curr = queue.shift();
        if (visited.has(curr)) continue;
        visited.add(curr);
        for (const next of (adjacency[curr] || [])) {
          if (!visited.has(next)) {
            if (menuCandidateIds.has(next)) reachableAsMC.add(next);
            queue.push(next);
          }
        }
      }
    }
    const rootCandidates = menuCandidates.filter(v => !reachableAsMC.has(v.$.id));
    rootCandidates.sort((a, b) => (outDegree[b.$.id] || 0) - (outDegree[a.$.id] || 0));
    mainNodeId = rootCandidates[0]?.$.id ?? sortedByOut[0]?.$.id;
  }

  // Reparar arestas quebradas: para nós sem filhos válidos, encontrar nó órfão próximo
  if (brokenEdgeSources.size > 0) {
    const validInDegree = {};
    for (const children of Object.values(adjacency)) {
      for (const c of children) validInDegree[c] = (validInDegree[c] || 0) + 1;
    }
    const orphanVertices = vertices.filter(v => !validInDegree[v.$.id] && v.$.id !== mainNodeId);
    for (const srcId of brokenEdgeSources) {
      if ((adjacency[srcId] || []).length > 0) continue;
      const srcV = vertices.find(v => v.$.id === srcId);
      const srcY = srcV?.mxGeometry?.[0]?.$.y ? parseFloat(srcV.mxGeometry[0].$.y) : 0;
      const srcX = srcV?.mxGeometry?.[0]?.$.x ? parseFloat(srcV.mxGeometry[0].$.x) : 0;
      const candidate = orphanVertices
        .filter(v => {
          const vx = v.mxGeometry?.[0]?.$.x ? parseFloat(v.mxGeometry[0].$.x) : 0;
          const vy = v.mxGeometry?.[0]?.$.y ? parseFloat(v.mxGeometry[0].$.y) : 0;
          const text = nodeContent[v.$.id]?.text || '';
          return vx > srcX && vy > srcY - 200 && text.length > 20;
        })
        .sort((a, b) => {
          const ay = a.mxGeometry?.[0]?.$.y ? parseFloat(a.mxGeometry[0].$.y) : 0;
          const by = b.mxGeometry?.[0]?.$.y ? parseFloat(b.mxGeometry[0].$.y) : 0;
          return Math.abs(ay - srcY) - Math.abs(by - srcY);
        })[0];
      if (candidate) {
        if (!adjacency[srcId]) adjacency[srcId] = [];
        adjacency[srcId].push(candidate.$.id);
      }
    }
  }

  // Reparar arestas faltantes: para menus com itens numerados, vincular nós órfãos
  // que correspondem aos itens não conectados (por prefixo numérico + proximidade espacial)
  {
    const validInDegree = {};
    for (const children of Object.values(adjacency)) {
      for (const c of children) validInDegree[c] = (validInDegree[c] || 0) + 1;
    }
    const orphanSet = new Set(
      vertices.filter(v => !validInDegree[v.$.id] && v.$.id !== mainNodeId).map(v => v.$.id)
    );

    // Processa nós-menu por coordenada X decrescente (menus mais profundos primeiro)
    // Isso evita que menus rasos "roubem" órfãos de submenus mais profundos
    const menuVertices = vertices
      .filter(v => detectMenuItems(nodeContent[v.$.id]?.text || '').length >= 2)
      .sort((a, b) => {
        const ax = vertexGeo.get(a.$.id)?.cx || 0;
        const bx = vertexGeo.get(b.$.id)?.cx || 0;
        return bx - ax; // mais à direita primeiro
      });

    const MAX_ORPHAN_DIST = 1200; // distância máxima para vincular órfão

    for (const v of menuVertices) {
      const vid = v.$.id;
      const text = nodeContent[vid]?.text || '';
      const items = detectMenuItems(text);

      const currentChildren = adjacency[vid] || [];
      // Mapeia quais números de item já têm um filho correspondente
      const linkedNums = new Set();
      for (const childId of currentChildren) {
        const childText = (nodeContent[childId]?.text || '').trim();
        const childMatch = childText.match(/^(\d+)[.\)\-*\s]/);
        if (childMatch) linkedNums.add(parseInt(childMatch[1], 10));
      }

      // Para cada item não vinculado, procura órfão com mesmo prefixo numérico
      const srcGeo = vertexGeo.get(vid);
      for (const item of items) {
        if (linkedNums.has(item.number)) continue;
        // Pula itens de "Retornar" (não têm nó-alvo)
        if (/retorn|voltar|menu\s+(?:anterior|principal)/i.test(item.label)) continue;
        // Procura órfão cujo texto começa com esse número
        let bestOrphan = null;
        let bestDist = Infinity;
        for (const oid of orphanSet) {
          const oText = (nodeContent[oid]?.text || '').trim();
          const oMatch = oText.match(/^(\d+)[.\)\-*\s]/);
          if (!oMatch || parseInt(oMatch[1], 10) !== item.number) continue;
          // Verifica proximidade espacial (à direita do menu, dentro do limite)
          const oGeo = vertexGeo.get(oid);
          if (!oGeo || !srcGeo) { bestOrphan = oid; break; }
          if (oGeo.cx <= srcGeo.cx) continue; // deve estar à direita
          const dist = Math.hypot(oGeo.cx - srcGeo.cx, oGeo.cy - srcGeo.cy);
          if (dist > MAX_ORPHAN_DIST) continue; // muito longe
          if (dist < bestDist) { bestDist = dist; bestOrphan = oid; }
        }
        if (bestOrphan) {
          if (!adjacency[vid]) adjacency[vid] = [];
          adjacency[vid].push(bestOrphan);
          orphanSet.delete(bestOrphan);
          linkedNums.add(item.number);
        }
      }

      // Fase 2: vincular órfãos próximos à direita que NÃO têm número no texto detectado
      // (para menus cujo texto não lista todos os sub-itens)
      if (srcGeo) {
        const childCount = (adjacency[vid] || []).length;
        // Se o menu ainda tem poucos filhos, procura órfãos muito próximos à direita
        const remainingOrphans = [...orphanSet]
          .map(oid => {
            const oGeo = vertexGeo.get(oid);
            if (!oGeo || oGeo.cx <= srcGeo.cx) return null;
            const dist = Math.hypot(oGeo.cx - srcGeo.cx, oGeo.cy - srcGeo.cy);
            if (dist > MAX_ORPHAN_DIST) return null;
            return { oid, dist };
          })
          .filter(Boolean)
          .sort((a, b) => a.dist - b.dist);

        for (const { oid } of remainingOrphans) {
          const oText = (nodeContent[oid]?.text || '').trim();
          // Só vincula se o órfão tem conteúdo substancial
          if (oText.length < 20) continue;
          // Não vincula se já foi consumido
          if (!orphanSet.has(oid)) continue;
          // Verifica se o texto do órfão começa com um número que já é filho
          const oMatch = oText.match(/^(\d+)[.\)\-*\s]/);
          if (oMatch && linkedNums.has(parseInt(oMatch[1], 10))) continue;
          if (!adjacency[vid]) adjacency[vid] = [];
          adjacency[vid].push(oid);
          orphanSet.delete(oid);
          if (oMatch) linkedNums.add(parseInt(oMatch[1], 10));
        }
      }
    }
  }

  // 8. Montar o Typebot
  const typebotId = generateId();
  const startEvtId = generateId();
  const startEdgeId = generateId();
  const initGroupId = generateId();
  const mainGroupId = generateId();
  const invalidGroupId = generateId();
  const waitGroupId = generateId();
  const finGroupId = generateId();

  // Variáveis fixas
  const varMenu = generateId();
  const varToken = generateId();
  const varName = generateId();
  const varNumber = generateId();
  const varTicket = generateId();
  const varProtocol = generateId();

  const variables = [
    { id: varMenu, name: 'menuPrincipal', isSessionVariable: false },
    { id: varToken, name: 'TOKENWHATSAPP', isSessionVariable: true },
    { id: varName, name: 'contactName', isSessionVariable: true },
    { id: varNumber, name: 'contactNumber', isSessionVariable: true },
    { id: varTicket, name: 'ticketId', isSessionVariable: true },
    { id: varProtocol, name: 'protocolo', isSessionVariable: true },
  ];

  // Grupos de resposta (um por nó filho do menu principal)
  const groups = [];
  const edgesOut = [];

  // ─── Grupo de variáveis iniciais ──────────────────────────────────────────
  const initToMainEdge = generateId();
  const bSetToken = generateId();
  const bSetName = generateId();
  const bSetNumber = generateId();
  const bSetTicket = generateId();
  const bSetProtocol = generateId();

  groups.push({
    id: initGroupId,
    title: 'Variáveis iniciais',
    graphCoordinates: { x: LAYOUT.initX, y: LAYOUT.initY },
    blocks: [
      { id: bSetToken, type: 'Set variable', options: { variableId: varToken, expressionToEvaluate: tokenWhatsapp, isCode: false } },
      { id: bSetName, type: 'Set variable', options: { variableId: varName, expressionToEvaluate: '{{contactName}}', isCode: true } },
      { id: bSetNumber, type: 'Set variable', options: { variableId: varNumber, expressionToEvaluate: '{{contactNumber}}', isCode: true } },
      { id: bSetTicket, type: 'Set variable', options: { variableId: varTicket, expressionToEvaluate: '{{ticketId}}', isCode: true } },
      { id: bSetProtocol, outgoingEdgeId: initToMainEdge, type: 'Set variable', options: { variableId: varProtocol, expressionToEvaluate: '{{protocol}}', isCode: true } },
    ],
  });

  edgesOut.push({ id: startEdgeId, from: { eventId: startEvtId }, to: { groupId: initGroupId } });
  edgesOut.push({ id: initToMainEdge, from: { blockId: bSetProtocol }, to: { groupId: mainGroupId } });

  // ─── Menu principal ────────────────────────────────────────────────────────
  const mainText = nodeContent[mainNodeId]?.text || '';
  const mainItems = detectMenuItems(mainText);
  const mainTargets = adjacency[mainNodeId] || [];

  // Bloco de boas-vindas (texto do menu)
  const bWelcome = generateId();
  const bInputMain = generateId();
  const bCondMain = generateId();
  const mainInvalidEdge = generateId();

  const condItems = [];
  const condEdges = [];

  // Constrói mapeamento opção→nó: usa IA quando disponível, senão Y-sort heurístico
  let optionMappings; // Array de { number, targetNodeId, isSubmenu, subOptions }
  if (flowMap?.options?.length > 0) {
    optionMappings = flowMap.options
      .filter(opt => opt.targetNodeId && (nodeContent[opt.targetNodeId] || adjacency[opt.targetNodeId]))
      .sort((a, b) => a.number - b.number);
  } else {
    const sortedTargets = [...mainTargets].sort((a, b) => {
      const va = vertices.find(v => v.$.id === a);
      const vb = vertices.find(v => v.$.id === b);
      const ya = va?.mxGeometry?.[0]?.$.y ? parseFloat(va.mxGeometry[0].$.y) : 0;
      const yb = vb?.mxGeometry?.[0]?.$.y ? parseFloat(vb.mxGeometry[0].$.y) : 0;
      return ya - yb;
    });
    optionMappings = sortedTargets.map((id, i) => ({ number: i + 1, targetNodeId: id, isSubmenu: false, subOptions: null }));
  }

  for (const opt of optionMappings) {
    const itemId = generateId();
    const edgeId = generateId();
    condItems.push({
      id: itemId,
      outgoingEdgeId: edgeId,
      content: { comparisons: [{ id: generateId(), variableId: varMenu, comparisonOperator: 'Equal to', value: String(opt.number) }] },
    });
    condEdges.push({ edgeId, targetId: opt.targetNodeId, itemId, isSubmenu: opt.isSubmenu || false, subOptions: opt.subOptions || null });
  }

  groups.push({
    id: mainGroupId,
    title: 'Menu Principal',
    graphCoordinates: { x: LAYOUT.mainX, y: LAYOUT.mainY },
    blocks: [
      { id: bWelcome, type: 'text', content: { richText: textToRichText(mainText) } },
      { id: bInputMain, type: 'text input', options: { variableId: varMenu } },
      { id: bCondMain, outgoingEdgeId: mainInvalidEdge, type: 'Condition', items: condItems },
    ],
  });

  // ─── Grupo de opção inválida ───────────────────────────────────────────────
  const bInvalidMain = generateId();
  const invalidBackEdge = generateId();
  groups.push({
    id: invalidGroupId,
    title: 'Opção inválida',
    graphCoordinates: { x: LAYOUT.mainX, y: LAYOUT.mainY + 600 },
    blocks: [
      { id: bInvalidMain, outgoingEdgeId: invalidBackEdge, type: 'text', content: { richText: textToRichText('Não entendemos sua resposta. Por favor, digite apenas o número de uma das opções disponíveis.') } },
    ],
  });

  edgesOut.push({ id: mainInvalidEdge, from: { blockId: bCondMain }, to: { groupId: invalidGroupId } });
  edgesOut.push({ id: invalidBackEdge, from: { blockId: bInvalidMain }, to: { groupId: mainGroupId } });

  // ─── Grupos de resposta (filhos do menu principal) ─────────────────────────
  let responseY = LAYOUT.responseBaseX;

  for (let i = 0; i < condEdges.length; i++) {
    const { edgeId, targetId, itemId, isSubmenu: aiIsSubmenu, subOptions } = condEdges[i];

    // Resolve "pass-through": segue encadeamentos de nós intermediários com exatamente 1 filho.
    // Para em nós com >= 2 itens de menu (são submenus reais, não labels intermediários).
    // Também para em nós com texto longo sem itens de menu (são conteúdo final).
    let effectiveTargetId = targetId;
    {
      const visited = new Set([targetId]);
      while (true) {
        const current = nodeContent[effectiveTargetId];
        const currentText = (current && current.text || '').trim();
        if (detectMenuItems(currentText).length >= 2) break;
        const directChildren = (adjacency[effectiveTargetId] || []).filter(c => c && c !== 'undefined');
        if (directChildren.length !== 1) break;
        if (currentText.length > 80 && !detectMenuItems(currentText).length) break;
        const nextId = directChildren[0];
        if (visited.has(nextId)) break;
        visited.add(nextId);
        effectiveTargetId = nextId;
      }
    }

    const { text, raw } = nodeContent[effectiveTargetId] || { text: '', raw: '' };
    const groupId = generateId();

    // Filhos: usa sub-opções da IA quando disponíveis, senão adjacency
    const children = subOptions
      ? subOptions.filter(s => s.targetNodeId).map(s => s.targetNodeId)
      : (adjacency[effectiveTargetId] || []);

    // Detecta submenu: IA sinalizou OU texto tem itens numerados e há filhos suficientes
    const subItems = detectMenuItems(text);
    const isSubmenu = aiIsSubmenu || (subItems.length >= 2 && children.length >= 2);

    edgesOut.push({ id: edgeId, from: { blockId: bCondMain, itemId }, to: { groupId } });

    if (isSubmenu) {
      buildSubmenuGroup(
        targetId, text, groupId, children, vertices, nodeContent,
        adjacency, edgesOut, groups, waitGroupId, variables,
        i, responseY, queueIds, mainGroupId, 1
      );
      responseY += LAYOUT.responseStepY * (children.length + 1);
    } else {
      const cleanText = cleanResponseText(text);
      const bResp = generateId();
      const respToWaitEdge = generateId();
      groups.push({
        id: groupId,
        title: cleanText.substring(0, 50) || `Resposta ${i + 1}`,
        graphCoordinates: { x: LAYOUT.responseBaseX, y: responseY },
        blocks: [
          { id: bResp, outgoingEdgeId: respToWaitEdge, type: 'text', content: { richText: textToRichText(cleanText) } },
        ],
      });
      edgesOut.push({ id: respToWaitEdge, from: { blockId: bResp }, to: { groupId: waitGroupId } });
      responseY += LAYOUT.responseStepY;
    }
  }

  // ─── Grupo Wait + Finalização ──────────────────────────────────────────────
  const bWait = generateId();
  const waitToFinEdge = generateId();
  const bWebhook = generateId();

  groups.push({
    id: waitGroupId,
    title: 'Aguardar antes de finalizar',
    graphCoordinates: { x: 2200, y: 400 },
    blocks: [
      { id: bWait, outgoingEdgeId: waitToFinEdge, type: 'Wait', options: { secondsToWaitFor: '10' } },
    ],
  });

  groups.push({
    id: finGroupId,
    title: 'Finalização',
    graphCoordinates: { x: 2700, y: 400 },
    blocks: [
      {
        id: bWebhook,
        type: 'Webhook',
        options: {
          isCustomBody: true,
          webhook: {
            headers: [{ id: generateId(), key: 'Authorization', value: 'Bearer {{TOKENWHATSAPP}}' }],
            url: 'https://apisavoxpro.sheepcode.com.br/api/messages/send',
            body: JSON.stringify({
              number: '{{contactNumber}}',
              body: 'O atendimento foi encerrado. Se precisar de mais assistência no futuro, não hesite em nos contatar novamente. Tenha um ótimo dia!',
              closeTicket: true,
            }, null, 2),
          },
        },
      },
    ],
  });

  edgesOut.push({ id: waitToFinEdge, from: { blockId: bWait }, to: { groupId: finGroupId } });

  // ─── Monta o Typebot final ─────────────────────────────────────────────────
  const typebot = {
    version: '6.1',
    id: typebotId,
    name: flowName,
    events: [{ id: startEvtId, outgoingEdgeId: startEdgeId, graphCoordinates: { x: LAYOUT.startX, y: LAYOUT.startY }, type: 'start' }],
    groups,
    edges: edgesOut,
    variables,
    theme: {},
    selectedThemeTemplateId: null,
    settings: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    icon: null,
    folderId: folderId || null,
    publicId: null,
    customDomain: null,
    workspaceId: workspaceId || '',
    resultsTablePreferences: null,
    isArchived: false,
    isClosed: false,
    whatsAppCredentialsId: null,
    riskLevel: null,
  };

  return typebot;
}

// ─── Monta submenu recursivo ──────────────────────────────────────────────────
function buildSubmenuGroup(nodeId, text, groupId, children, vertices, nodeContent, adjacency, edgesOut, groups, waitGroupId, variables, parentIdx, startY, queueIds, parentGroupId, depth) {
  depth = depth || 1;
  const maxDepth = 5; // Limite de recursão para evitar loops infinitos

  const varSub = { id: generateId(), name: `subMenu_${groupId.substring(0, 6)}`, isSessionVariable: false };
  variables.push(varSub);

  const bSubText = generateId();
  const bSubInput = generateId();
  const bSubCond = generateId();
  const subInvalidEdge = generateId();
  const subInvalidGroupId = generateId();
  const bSubInvalid = generateId();
  const subInvalidBackEdge = generateId();

  const subItems = [];
  const subEdges = [];

  // Ordena filhos por coordenada Y
  const sortedChildren = [...children].sort((a, b) => {
    const va = vertices.find(v => v.$.id === a);
    const vb = vertices.find(v => v.$.id === b);
    const ya = va?.mxGeometry?.[0]?.$.y ? parseFloat(va.mxGeometry[0].$.y) : 0;
    const yb = vb?.mxGeometry?.[0]?.$.y ? parseFloat(vb.mxGeometry[0].$.y) : 0;
    return ya - yb;
  });

  // Opção 0 = voltar ao menu pai (ou menu principal se for level 1)
  const back0Id = generateId();
  const back0Edge = generateId();
  subItems.push({
    id: back0Id,
    outgoingEdgeId: back0Edge,
    content: { comparisons: [{ id: generateId(), variableId: varSub.id, comparisonOperator: 'Equal to', value: '0' }] },
  });

  // Detecta item "Retornar" no menu (último item numerado cujo label contém retornar/voltar)
  const menuItemsDetected = detectMenuItems(text);
  const retornarItem = [...menuItemsDetected].reverse().find(it =>
    /retorn|voltar|menu\s+(?:anterior|principal)/i.test(it.label)
  );

  for (let i = 0; i < sortedChildren.length; i++) {
    const childId = sortedChildren[i];
    const itemId = generateId();
    const edgeId = generateId();
    subItems.push({
      id: itemId,
      outgoingEdgeId: edgeId,
      content: { comparisons: [{ id: generateId(), variableId: varSub.id, comparisonOperator: 'Equal to', value: String(i + 1) }] },
    });
    subEdges.push({ edgeId, childId, itemId });
  }

  // Se há item "Retornar" com número diferente de 0 e não coberto pelos filhos, adiciona condição extra
  if (retornarItem && retornarItem.number > sortedChildren.length) {
    const retItemId = generateId();
    const retEdgeId = generateId();
    subItems.push({
      id: retItemId,
      outgoingEdgeId: retEdgeId,
      content: { comparisons: [{ id: generateId(), variableId: varSub.id, comparisonOperator: 'Equal to', value: String(retornarItem.number) }] },
    });
    // Reutiliza o mesmo destino do back0 (menu pai)
    edgesOut.push({ id: retEdgeId, from: { blockId: bSubCond, itemId: retItemId }, to: { groupId: parentGroupId || groupId } });
  }

  // Texto do submenu com limpeza do prefixo numérico
  const cleanMenuText = cleanResponseText(text);

  groups.push({
    id: groupId,
    title: (cleanMenuText || text).substring(0, 50) || `Submenu ${parentIdx + 1}`,
    graphCoordinates: { x: LAYOUT.responseBaseX + (depth - 1) * 600, y: startY },
    blocks: [
      { id: bSubText, type: 'text', content: { richText: textToRichText(cleanMenuText || text) } },
      { id: bSubInput, type: 'text input', options: { variableId: varSub.id } },
      { id: bSubCond, outgoingEdgeId: subInvalidEdge, type: 'Condition', items: subItems },
    ],
  });

  // Grupo inválido do submenu
  groups.push({
    id: subInvalidGroupId,
    title: 'Opção inválida - Submenu',
    graphCoordinates: { x: LAYOUT.responseBaseX + (depth - 1) * 600, y: startY + 600 },
    blocks: [
      { id: bSubInvalid, outgoingEdgeId: subInvalidBackEdge, type: 'text', content: { richText: textToRichText('Não entendemos sua resposta. Por favor, tente novamente.') } },
    ],
  });

  edgesOut.push({ id: subInvalidEdge, from: { blockId: bSubCond }, to: { groupId: subInvalidGroupId } });
  edgesOut.push({ id: subInvalidBackEdge, from: { blockId: bSubInvalid }, to: { groupId } });
  // Opção 0 volta para o menu pai
  edgesOut.push({ id: back0Edge, from: { blockId: bSubCond, itemId: back0Id }, to: { groupId: parentGroupId || groupId } });

  // Filhos do submenu
  let childY = startY + LAYOUT.responseStepY;
  for (const { edgeId, childId, itemId } of subEdges) {
    // Resolve pass-through: segue nós intermediários com 1 filho (labels de opção)
    // Para em nós com >= 2 itens de menu (são submenus reais)
    // Para em nós com texto longo sem itens de menu (são conteúdo final)
    let effectiveChildId = childId;
    {
      const visited = new Set([childId]);
      while (true) {
        const current = nodeContent[effectiveChildId];
        const currentText = (current && current.text || '').trim();
        if (detectMenuItems(currentText).length >= 2) break;
        const directChildren = (adjacency[effectiveChildId] || []).filter(c => c && c !== 'undefined');
        if (directChildren.length !== 1) break;
        if (currentText.length > 80 && !detectMenuItems(currentText).length) break;
        const nextId = directChildren[0];
        if (visited.has(nextId)) break;
        visited.add(nextId);
        effectiveChildId = nextId;
      }
    }

    const { text: childText } = nodeContent[effectiveChildId] || { text: '' };
    const cleanChildText = cleanResponseText(childText);
    const childGroupId = generateId();
    const bChild = generateId();
    const childToWaitEdge = generateId();

    // Filhos deste nó (para verificar se é submenu recursivo)
    const grandchildren = (adjacency[effectiveChildId] || []).filter(c => c && c !== 'undefined');
    const childMenuItems = detectMenuItems(childText);
    const isChildSubmenu = depth < maxDepth && childMenuItems.length >= 2 && grandchildren.length >= 1;

    // Detecta se é uma fila (queueId passado pelo usuário)
    const queueId = queueIds[childId] || queueIds[effectiveChildId] || queueIds[childText?.substring(0, 30)];

    edgesOut.push({ id: edgeId, from: { blockId: bSubCond, itemId }, to: { groupId: childGroupId } });

    if (queueId) {
      // Bloco de Typebot link (fila)
      groups.push({
        id: childGroupId,
        title: cleanChildText.substring(0, 50) || `Fila ${childId}`,
        graphCoordinates: { x: LAYOUT.responseBaseX + depth * 600, y: childY },
        blocks: [{ id: bChild, type: 'Typebot link', options: { typebotId: queueId } }],
      });
      childY += LAYOUT.responseStepY;
    } else if (isChildSubmenu) {
      // Recursão: o filho é ele próprio um submenu
      buildSubmenuGroup(
        effectiveChildId, childText, childGroupId, grandchildren, vertices, nodeContent,
        adjacency, edgesOut, groups, waitGroupId, variables,
        parentIdx, childY, queueIds, groupId, depth + 1
      );
      childY += LAYOUT.responseStepY * (grandchildren.length + 2);
    } else {
      groups.push({
        id: childGroupId,
        title: cleanChildText.substring(0, 50) || `Opção ${childId}`,
        graphCoordinates: { x: LAYOUT.responseBaseX + depth * 600, y: childY },
        blocks: [
          { id: bChild, outgoingEdgeId: childToWaitEdge, type: 'text', content: { richText: textToRichText(cleanChildText || childText) } },
        ],
      });
      edgesOut.push({ id: childToWaitEdge, from: { blockId: bChild }, to: { groupId: waitGroupId } });
      childY += LAYOUT.responseStepY;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Converte texto plano em richText do Typebot */
function textToRichText(text) {
  if (!text) return [{ type: 'p', children: [{ text: '' }] }];
  return text.split('\n').map(line => ({
    type: 'p',
    children: [{ text: line }],
  }));
}

/** Interpreta a estrutura do fluxo com IA — identifica menu principal e mapeamento opção→nó */
async function interpretFlowWithAI(nodeContent, adjacency, vertices, openaiClient) {
  // Inclui TODOS os nós — até os de texto curto são necessários (são labels de opções)
  const nodes = vertices.map(v => ({
    id: v.$.id,
    text: (nodeContent[v.$.id]?.text || '').substring(0, 500),
  }));

  // Arestas resolvidas (já incluem as deduzidas por coordenada)
  const edgeList = [];
  for (const [src, targets] of Object.entries(adjacency)) {
    for (const tgt of (targets || [])) edgeList.push(`${src} → ${tgt}`);
  }

  // IDs de nós que NÃO aparecem como targets de nenhuma aresta (potencialmente orphans)
  const allTargets = new Set(edgeList.map(e => e.split(' → ')[1]));
  const unreachableIds = nodes.filter(n => !allTargets.has(n.id)).map(n => n.id);

  // Detecta antecipadamente quantas opções o menu principal provavelmente tem
  const bestMenuNode = nodes
    .map(n => ({
      id: n.id,
      count: (n.text.match(/(?:^|\n)\s*(?:\d{1,2}[.)* ]|[1-9️⃣🔟])/gm) || []).length,
    }))
    .sort((a, b) => b.count - a.count)[0];
  const expectedCount = bestMenuNode?.count || '?';

  const prompt = `Você está analisando um diagrama de fluxo de chatbot (DrawIO).
Sua tarefa: identificar o MENU PRINCIPAL e mapear CADA opção numerada ao seu nó de destino.

O menu principal provavelmente tem ~${expectedCount} opções numeradas.

═══ TODOS OS NÓS DO DIAGRAMA ═══
${nodes.map(n => `[ID: ${n.id}]\n${n.text || '(nó sem texto)'}`).join('\n\n')}

═══ ARESTAS RESOLVIDAS (source → target) ═══
${edgeList.join('\n') || '(nenhuma aresta encontrada)'}

═══ NÓS SEM ARESTA DE ENTRADA (possíveis opções sem conexão explícita no diagrama) ═══
${unreachableIds.join(', ') || '(nenhum)'}

═══ REGRAS IMPORTANTES ═══
1. O menu principal é o nó com lista de opções numeradas: "1." / "1️⃣" / "1*" / "1)" etc.
2. Para cada opção numerada do menu, localize o nó de destino correspondente:
   a) Primeiro: use as arestas (o nó que a aresta do menu aponta para aquela opção)
   b) Se não há aresta para aquela opção: busque nos nós sem aresta de entrada acima — o nó cujo texto começa com "N*" ou "N." onde N é o número da opção
3. Inclua TODAS as opções, mesmo as sem aresta explícita.
4. O nó de destino PODE ter texto curto ou vazio — inclua mesmo assim.
5. Se um destino também tem sub-opções numeradas, adicione "isSubmenu": true e "subOptions": [...].
6. Use SOMENTE IDs que aparecem na lista de nós acima.
7. NÃO omita opções — retorne TODAS as ${expectedCount} opções do menu.

Retorne APENAS um JSON (sem markdown):
{
  "mainMenuNodeId": "string",
  "totalOptions": ${expectedCount},
  "options": [
    { "number": 1, "targetNodeId": "string" },
    { "number": 2, "targetNodeId": "string" }
  ]
}`;

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content: 'Você é um especialista em análise de diagramas de chatbot. Analise grafos de fluxo com precisão e retorne JSON estruturado. Para opções sem aresta explícita, encontre o nó correspondente pelo número no início do texto (ex: "4* Consulta com Enfermeiro" = opção 4). Nunca omita opções.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 4000,
  });

  const result = JSON.parse(response.choices[0].message.content);

  // Validação
  if (bestMenuNode && result.options?.length < bestMenuNode.count) {
    console.warn(
      `[interpretFlowWithAI] IA retornou ${result.options?.length} opções mas o menu parece ter ${bestMenuNode.count}. Verifique o diagrama.`
    );
  }

  return result;
}

/** Chama IA apenas para nós com HTML ilegível — minimiza tokens */
async function enrichWithAI(nodeIds, nodeContent, openaiClient) {
  // Envia todos os nós problemáticos em uma única chamada (batch)
  const batch = nodeIds.map(id => `ID: ${id}\nHTML: ${nodeContent[id].raw.substring(0, 500)}`).join('\n---\n');

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: 'Você extrai o texto visível de fragmentos HTML de nós de diagramas drawio. Responda no formato JSON: {"id1": "texto extraído", "id2": "texto extraído"}. Seja conciso.',
      },
      { role: 'user', content: batch },
    ],
    temperature: 0,
    max_tokens: 1000,
  });

  try {
    const result = JSON.parse(response.choices[0].message.content);
    for (const [id, text] of Object.entries(result)) {
      if (nodeContent[id]) nodeContent[id].text = text;
    }
  } catch {
    // Se falhar o parse do JSON da IA, mantém o que temos
  }
}

module.exports = { xmlToTypebot };
