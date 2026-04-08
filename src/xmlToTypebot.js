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
  const adjacency = {};     // sourceId → [targetId]
  const edgeMap = {};       // edgeId → { source, target }
  const brokenEdgeSources = new Set(); // fontes com arestas quebradas (target="undefined")
  for (const e of edges) {
    const src = e.$.source;
    const tgt = e.$.target;
    if (!src) continue;
    if (!tgt || tgt === 'undefined') {
      // Aresta com source mas sem target válido — registra para reparar depois
      if (src) brokenEdgeSources.add(src);
      continue;
    }
    if (!adjacency[src]) adjacency[src] = [];
    adjacency[src].push(tgt);
    edgeMap[e.$.id] = { source: src, target: tgt };
  }

  // 4. Encontrar nó raiz (mais saídas ou nó referenciado por menos entradas)
  const inDegree = {};
  for (const e of edges) {
    if (e.$.target) inDegree[e.$.target] = (inDegree[e.$.target] || 0) + 1;
  }
  // Nó com mais saídas = menu principal
  const outDegree = {};
  for (const e of edges) {
    if (e.$.source) outDegree[e.$.source] = (outDegree[e.$.source] || 0) + 1;
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
      .filter(opt => opt.targetNodeId && nodeContent[opt.targetNodeId])
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
    let effectiveTargetId = targetId;
    {
      const visited = new Set([targetId]);
      while (true) {
        const current = nodeContent[effectiveTargetId];
        const currentText = (current && current.text || '').trim();
        const directChildren = (adjacency[effectiveTargetId] || []).filter(c => c && c !== 'undefined');
        if (directChildren.length !== 1) break;
        if (currentText.length > 40 && !detectMenuItems(currentText).length) break;
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
        i, responseY, queueIds, mainGroupId
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
function buildSubmenuGroup(nodeId, text, groupId, children, vertices, nodeContent, adjacency, edgesOut, groups, waitGroupId, variables, parentIdx, startY, queueIds, mainGroupId) {
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

  // Verifica se algum filho é fila (queueId configurado)
  const sortedChildren = [...children].sort((a, b) => {
    const va = vertices.find(v => v.$.id === a);
    const vb = vertices.find(v => v.$.id === b);
    const ya = va?.mxGeometry?.[0]?.$.y ? parseFloat(va.mxGeometry[0].$.y) : 0;
    const yb = vb?.mxGeometry?.[0]?.$.y ? parseFloat(vb.mxGeometry[0].$.y) : 0;
    return ya - yb;
  });

  // Opção 0 = voltar ao menu principal
  const back0Id = generateId();
  const back0Edge = generateId();
  subItems.push({
    id: back0Id,
    outgoingEdgeId: back0Edge,
    content: { comparisons: [{ id: generateId(), variableId: varSub.id, comparisonOperator: 'Equal to', value: '0' }] },
  });

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

  groups.push({
    id: groupId,
    title: text.substring(0, 50) || `Submenu ${parentIdx + 1}`,
    graphCoordinates: { x: LAYOUT.responseBaseX, y: startY },
    blocks: [
      { id: bSubText, type: 'text', content: { richText: textToRichText(text) } },
      { id: bSubInput, type: 'text input', options: { variableId: varSub.id } },
      { id: bSubCond, outgoingEdgeId: subInvalidEdge, type: 'Condition', items: subItems },
    ],
  });

  // Grupo inválido do submenu
  groups.push({
    id: subInvalidGroupId,
    title: 'Opção inválida - Submenu',
    graphCoordinates: { x: LAYOUT.responseBaseX, y: startY + 600 },
    blocks: [
      { id: bSubInvalid, outgoingEdgeId: subInvalidBackEdge, type: 'text', content: { richText: textToRichText('Não entendemos sua resposta. Por favor, tente novamente.') } },
    ],
  });

  edgesOut.push({ id: subInvalidEdge, from: { blockId: bSubCond }, to: { groupId: subInvalidGroupId } });
  edgesOut.push({ id: subInvalidBackEdge, from: { blockId: bSubInvalid }, to: { groupId } });
  // Opção 0 volta para o Menu Principal
  edgesOut.push({ id: back0Edge, from: { blockId: bSubCond, itemId: back0Id }, to: { groupId: mainGroupId || groupId } });

  // Filhos do submenu
  let childY = startY + LAYOUT.responseStepY;
  for (const { edgeId, childId, itemId } of subEdges) {
    const childGroupId = generateId();
    const { text: childText } = nodeContent[childId] || { text: '' };
    const cleanChildText = cleanResponseText(childText);
    const bChild = generateId();
    const childToWaitEdge = generateId();

    // Detecta se é uma fila (queueId passado pelo usuário)
    const queueId = queueIds[childId] || queueIds[childText?.substring(0, 30)];

    if (queueId) {
      // Bloco de Typebot link (fila)
      groups.push({
        id: childGroupId,
        title: cleanChildText.substring(0, 50) || `Fila ${childId}`,
        graphCoordinates: { x: LAYOUT.responseBaseX + 600, y: childY },
        blocks: [{ id: bChild, type: 'Typebot link', options: { typebotId: queueId } }],
      });
    } else {
      groups.push({
        id: childGroupId,
        title: cleanChildText.substring(0, 50) || `Opção ${childId}`,
        graphCoordinates: { x: LAYOUT.responseBaseX + 600, y: childY },
        blocks: [
          { id: bChild, outgoingEdgeId: childToWaitEdge, type: 'text', content: { richText: textToRichText(cleanChildText) } },
        ],
      });
      edgesOut.push({ id: childToWaitEdge, from: { blockId: bChild }, to: { groupId: waitGroupId } });
    }

    edgesOut.push({ id: edgeId, from: { blockId: bSubCond, itemId }, to: { groupId: childGroupId } });
    childY += LAYOUT.responseStepY;
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
  const nodes = vertices
    .map(v => ({ id: v.$.id, text: (nodeContent[v.$.id]?.text || '').substring(0, 400) }))
    .filter(n => n.text.replace(/\s/g, '').length > 10);

  const edgeList = [];
  for (const [src, targets] of Object.entries(adjacency)) {
    for (const tgt of (targets || [])) edgeList.push(`${src} → ${tgt}`);
  }

  const prompt = `Analise este diagrama DrawIO de chatbot e retorne um JSON descrevendo a estrutura de menus.

NODOS:
${nodes.map(n => `[${n.id}]\n${n.text}`).join('\n\n')}

ARESTAS:
${edgeList.join('\n') || '(nenhuma aresta encontrada)'}

Retorne um JSON com esta estrutura:
{
  "mainMenuNodeId": "id do nó que contém o menu principal com opções numeradas",
  "options": [
    { "number": 1, "targetNodeId": "id do nó de resposta para opção 1" },
    { "number": 2, "targetNodeId": "id do nó de resposta para opção 2" }
  ]
}

Regras:
- O menu principal é o nó com lista de opções numeradas (1. / 1️⃣ / 1* / etc.)
- Cada "targetNodeId" deve ser um ID válido da lista de nós acima
- Se um nó filho também tem sub-opções numeradas, adicione "isSubmenu": true e "subOptions": [{"number":1,"targetNodeId":"..."},...]
- Use apenas IDs existentes na lista de nós acima`;

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 2000,
  });

  return JSON.parse(response.choices[0].message.content);
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
