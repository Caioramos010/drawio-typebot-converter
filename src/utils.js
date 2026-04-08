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

  // Remove prefixo numérico da primeira linha não-vazia ("3. Olá" → "Olá")
  const firstIdx = lines.findIndex(l => l.trim());
  if (firstIdx >= 0 && /^\*?\d+\.\s+/.test(lines[firstIdx].trim())) {
    lines[firstIdx] = lines[firstIdx].replace(/^\*?\d+\.\s+/, '');
  }

  // Filtra linhas de navegação de menu e cabeçalhos de diagrama
  const NAV_PATTERN = /(?:[\d️⃣\*_]+\s*[.\)\-]?\s*)?[Mm]enu\s+(?:[Pp]rincipal|[Aa]nterior)|[Vv]oltar\s+ao\s+[Mm]enu|^\s*[0️⃣1️⃣2️⃣]\s*[.\-]?\s*[Mm]enu/u;
  const HEADER_PATTERN = /^\s*Resposta\s+Autom[aá]tica\s*$/i;
  const cleaned = lines.filter(line => !NAV_PATTERN.test(line) && !HEADER_PATTERN.test(line));

  // Remove linhas em branco consecutivas no final
  while (cleaned.length > 0 && !cleaned[cleaned.length - 1].trim()) cleaned.pop();

  return cleaned.join('\n').trim();
}

/**
 * Detecta itens numerados de um menu em texto plano.
 * Aceita padrões: "1. Texto", "1- Texto", "1) Texto"
 * Retorna array de { number, label }
 */
function detectMenuItems(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const items = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)[.\-\)]\s+(.+)/);
    if (match) {
      items.push({ number: parseInt(match[1], 10), label: match[2].trim() });
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
