require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { xmlToTypebot } = require('./src/xmlToTypebot');
const { typebotToXml } = require('./src/typebotToXml');

const app = express();
const PORT = process.env.PORT || 3000;

// Upload em memória (sem salvar disco)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Lazy-load do cliente OpenAI (só cria se a chave estiver configurada)
let openaiClient = null;
function getOpenAI() {
  if (!openaiClient && process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'sk-...') {
    const { OpenAI } = require('openai');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// ─── Rota: XML → Typebot JSON ─────────────────────────────────────────────────
app.post('/api/xml-to-typebot', upload.single('file'), async (req, res) => {
  try {
    let xmlString;
    if (req.file) {
      xmlString = req.file.buffer.toString('utf-8');
    } else if (req.body.xml) {
      xmlString = req.body.xml;
    } else {
      return res.status(400).json({ error: 'Envie o arquivo XML ou o campo "xml" no body.' });
    }

    // Opções vindas do frontend
    const tokenWhatsapp = (req.body.tokenWhatsapp || '').trim() || 'SEU_TOKEN_AQUI';
    const flowName = (req.body.flowName || '').trim() || 'Novo Fluxo';
    const workspaceId = (req.body.workspaceId || '').trim();
    const folderId = (req.body.folderId || '').trim() || null;

    // queueIds: mapeamento opcional nodeId → typebotId de fila
    // Formato: JSON string { "nodeId": "typebotId", ... }
    let queueIds = {};
    try {
      if (req.body.queueIds) queueIds = JSON.parse(req.body.queueIds);
    } catch { /* ignora JSON inválido */ }

    const typebot = await xmlToTypebot(xmlString, {
      tokenWhatsapp,
      flowName,
      queueIds,
      workspaceId,
      folderId,
      openaiClient: getOpenAI(),
    });

    res.json({ success: true, typebot });
  } catch (err) {
    console.error('[xml-to-typebot]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Rota: Typebot JSON → XML ─────────────────────────────────────────────────
app.post('/api/typebot-to-xml', upload.single('file'), async (req, res) => {
  try {
    let typebot;
    if (req.file) {
      typebot = JSON.parse(req.file.buffer.toString('utf-8'));
    } else if (req.body.typebot) {
      typebot = typeof req.body.typebot === 'string' ? JSON.parse(req.body.typebot) : req.body.typebot;
    } else {
      return res.status(400).json({ error: 'Envie o arquivo JSON ou o campo "typebot" no body.' });
    }

    const xml = await typebotToXml(typebot);
    res.json({ success: true, xml });
  } catch (err) {
    console.error('[typebot-to-xml]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Rota: health ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', aiEnabled: !!getOpenAI() });
});

// ─── Fallback para SPA ────────────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`   IA (OpenAI): ${getOpenAI() ? 'habilitada' : 'desabilitada (configure OPENAI_API_KEY no .env)'}`);
});
