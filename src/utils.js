/**
 * Funções utilitárias compartilhadas
 */

const { v4: uuidv4 } = require('uuid');

/** Gera um ID curto estilo Typebot (22 chars alfanumérico) */
function generateId() {
  return uuidv4().replace(/-/g, '').substring(0, 22);
}

/**
 * Remove tags HTML e decodifica entidades — versão eficiente sem dependências extras
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    // Converte <b>/<strong> em marcadores WhatsApp *bold*
    .replace(/<\/(?:b|strong)>/gi, '*')
    .replace(/<(?:b|strong)(?:\s[^>]*)?>/gi, '*')
    // Converte <i>/<em> em marcadores WhatsApp _italic_
    .replace(/<\/(?:i|em)>/gi, '_')
    .replace(/<(?:i|em)(?:\s[^>]*)?>/gi, '_')
    // Converte abertura de tags de bloco em quebra de linha
    .replace(/<(div|p|li|tr|h[1-6]|blockquote|pre)[^>]*>/gi, '\n')
    // Converte fechamento de tags de bloco em quebra de linha
    .replace(/<\/(div|p|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    // <br> vira quebra
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove todas as demais tags restantes
    .replace(/<[^>]*>/g, '')
    // Decodifica entidades HTML comuns
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&#39;/g, "'")
    // Colapsa marcadores duplos gerados por tags aninhadas: ** → * e __ → _
    .replace(/\*{2,}/g, '*')
    .replace(/_{2,}/g, '_')
    // Normaliza espaços em cada linha
    .split('\n').map(l => l.replace(/[ \t]{2,}/g, ' ').trim()).join('\n')
    // Remove linhas em branco consecutivas excessivas
    .replace(/\n{3,}/g, '\n\n')
    // Remove marcadores bold/italic que ficaram dentro de URLs (ex: https://wa.me/*55*48...)
    .replace(/(https?:\/\/\S+)/g, url => url.replace(/[*_]/g, ''))
    // Normaliza URLs wa.me sem barra: https://wa.me554... → https://wa.me/554...
    .replace(/https?:\/\/wa\.me(\d)/g, 'https://wa.me/$1')
    .trim();
}

/**
 * Remove artefatos de diagrama do texto de nós de resposta:
 *  - Prefixo numérico de opção na primeira linha ("2. Texto" → "Texto")
 *  - Linhas de navegação ("0️⃣. Menu Principal", "1️⃣. Menu Anterior", etc.)
 */
function cleanResponseText(text) {
  if (!text) return '';
  const lines = text.split('\n');

  // Remove prefixo numérico da primeira linha não-vazia
  // Suporta: "3. Olá", "*3. Olá", "3* Olá", "*3* Título*", "3) Olá", "3- Olá"
  const firstIdx = lines.findIndex(l => l.trim());
  if (firstIdx >= 0) {
    const trimmed = lines[firstIdx].trim();
    if (/^\*?\d+[.*\-\)]\s/.test(trimmed)) {
      lines[firstIdx] = trimmed.replace(/^\*?\d+[.*\-\)]\s*/, '').replace(/\*+$/, '').trim();
    }
  }

  // Filtra linhas de navegação, cabeçalhos e "Digite X para retornar"
  const NAV_PATTERN = /(?:[\d️⃣\*_]+\s*[.\)\-]?\s*)?[Mm]enu\s+(?:[Pp]rincipal|[Aa]nterior)|[Vv]oltar\s+ao\s+[Mm]enu|^\s*[0️⃣1️⃣2️⃣]\s*[.\-]?\s*[Mm]enu/u;
  const HEADER_PATTERN = /^\s*Resposta\s+Autom[aá]tica\s*$/i;
  const BACK_PATTERN = /[Dd]igite\s+[Xx]\s+para\s+retornar/;
  const cleaned = lines.filter(line => !NAV_PATTERN.test(line) && !HEADER_PATTERN.test(line) && !BACK_PATTERN.test(line));

  // Remove linhas em branco consecutivas no final
  while (cleaned.length > 0 && !cleaned[cleaned.length - 1].trim()) cleaned.pop();

  return cleaned.join('\n').trim();
}

/**
 * Detecta itens numerados de um menu em texto plano.
 * Aceita padrões: "1. Texto", "1- Texto", "1) Texto"
 *   e emoji keycap: "1️⃣ Texto", "🔟 Texto", "1️⃣1️⃣ Texto" (= 11)
 * Retorna array de { number, label }
 */
function detectMenuItems(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const items = [];
  for (const line of lines) {
    const trimmed = line.trim();

    // Padrão numérico clássico: "1. Texto", "1- Texto", "1) Texto"
    const matchStd = trimmed.match(/^(\d+)[.\-\)]\s+(.+)/);
    if (matchStd) {
      items.push({ number: parseInt(matchStd[1], 10), label: matchStd[2].trim() });
      continue;
    }

    // Padrão emoji keycap: 1️⃣ (U+0031 U+FE0F U+20E3) ... 9️⃣, combinações 1️⃣1️⃣ = 11, e 🔟 (U+1F51F) = 10
    const matchEmoji = trimmed.match(/^((?:[0-9]\uFE0F?\u20E3)+|\uD83D\uDD1F)\s+(.+)/u);
    if (matchEmoji) {
      const numPart = matchEmoji[1];
      let num;
      if (numPart === '\uD83D\uDD1F') { // 🔟 = 10
        num = 10;
      } else {
        // extrai apenas os dígitos das sequências keycap
        const digits = numPart.replace(/[\uFE0F\u20E3]/g, '');
        num = parseInt(digits, 10);
      }
      if (!isNaN(num)) items.push({ number: num, label: matchEmoji[2].trim() });
    }
  }
  return items;
}

/**
 * Converte richText do Typebot em texto plano
 */
function richTextToPlain(richText) {
  if (!richText || !Array.isArray(richText)) return '';
  return richText
    .map(node => {
      if (!node.children) return '';
      return node.children.map(c => {
        let t = c.text || '';
        if (c.bold) t = `*${t}*`;
        if (c.italic) t = `_${t}_`;
        return t;
      }).join('');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { generateId, stripHtml, detectMenuItems, richTextToPlain, cleanResponseText };
