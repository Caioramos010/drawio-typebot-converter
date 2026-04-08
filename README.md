# DrawIO ↔ Typebot Converter

Ferramenta web para converter diagramas **DrawIO** em fluxos **Typebot JSON** e vice-versa. Ideal para times que projetam chatbots no DrawIO e precisam importá-los no Typebot — ou exportar fluxos existentes para visualização e edição em diagrama.

---

## ✨ Funcionalidades

### 📐 DrawIO XML → Typebot JSON
- Detecta automaticamente **menus numerados** (ex.: `1. Opção A  2. Opção B`) e gera blocos de input + condição
- Suporte a **submenus** aninhados com roteamento correto
- Detecta nós de **webhook**, **wait**, **typebot link** e **set variable** via tags especiais no texto
- Limpeza automática de ruído: remove linhas de navegação (Menu Principal, Voltar, etc.) e cabeçalhos repetitivos
- IA opcional (OpenAI) para interpretar nós com HTML complexo — economizando tokens ao máximo
- Reparação de **arestas quebradas**: nós sem edge de destino são conectados ao órfão mais próximo por posição no canvas
- Saída totalmente compatível com o **formato Typebot 6.1**

### 🔁 Typebot JSON → DrawIO XML
- Converte grupos, blocos e edges do Typebot em vértices + arestas DrawIO
- Quebras de linha renderizadas corretamente no diagrama (`&#xa;`)
- Nós de workflow (Webhook, Wait, Typebot link) são anotados; blocos internos de roteamento (Set variable, Input, Condition) são omitidos para manter o diagrama limpo
- Arquivo pronto para abrir no [app.diagrams.net](https://app.diagrams.net)

---

## 🚀 Como usar

### Pré-requisitos
- [Node.js](https://nodejs.org/) 18+

### Instalação

```bash
git clone https://github.com/Caioramos010/drawio-typebot-converter.git
cd drawio-typebot-converter
npm install
```

### Configuração

Copie o arquivo de exemplo e preencha sua chave OpenAI (opcional):

```bash
cp .env.example .env
```

```env
# .env
OPENAI_API_KEY=sk-...   # opcional — habilita IA para nós complexos
PORT=3000
```

> Sem `OPENAI_API_KEY` o conversor funciona normalmente com heurísticas locais.

### Executar

```bash
# Produção
npm start

# Desenvolvimento (reload automático)
npm run dev
```

Acesse: **http://localhost:3000**

---

## 🖥️ Interface

| Painel | Função |
|--------|--------|
| **Esquerdo** | DrawIO XML → Typebot JSON |
| **Direito** | Typebot JSON → DrawIO XML |

### Campos disponíveis (XML → JSON)

| Campo | Descrição |
|-------|-----------|
| Nome do fluxo | Nome do typebot gerado |
| TOKEN WhatsApp | Token para o bloco de webhook de envio |
| Workspace ID | ID do workspace Typebot (opcional) |
| Folder ID | ID da pasta Typebot (opcional) |
| IDs de fila | Mapeamento nó DrawIO → Typebot ID para redirecionamentos |

---

## 📁 Estrutura do projeto

```
drawio-typebot-converter/
├── public/
│   └── index.html          # Interface web (SPA)
├── src/
│   ├── xmlToTypebot.js     # Conversor DrawIO XML → Typebot JSON
│   ├── typebotToXml.js     # Conversor Typebot JSON → DrawIO XML
│   └── utils.js            # Helpers: stripHtml, cleanResponseText, detectMenuItems
├── server.js               # Servidor Express + rotas API
├── .env.example
└── package.json
```

---

## 🔌 API

### `POST /api/xml-to-typebot`

Converte um DrawIO XML em Typebot JSON.

**Body** (`multipart/form-data` ou `application/json`):

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `xml` | string | Conteúdo do arquivo XML |
| `flowName` | string | Nome do fluxo |
| `tokenWhatsapp` | string | Token WhatsApp |
| `workspaceId` | string | (opcional) Workspace ID |
| `folderId` | string | (opcional) Folder ID |
| `queueIds` | JSON string | `{"nodeId": "typebotId"}` |

**Resposta:**
```json
{ "success": true, "typebot": { ... } }
```

---

### `POST /api/typebot-to-xml`

Converte um Typebot JSON em DrawIO XML.

**Body** (`multipart/form-data`):

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `typebot` | string | Conteúdo do arquivo JSON |

**Resposta:**
```json
{ "success": true, "xml": "<?xml version=\"1.0\"...>" }
```

---

### `GET /api/health`

```json
{ "ok": true, "aiEnabled": true }
```

---

## 🔤 Sintaxe especial no DrawIO

O conversor reconhece as seguintes tags nos textos dos nós:

| Tag | Efeito |
|-----|--------|
| `[Input → nomeVariavel]` | Cria bloco de input de texto |
| `[Condição]` | Cria bloco de condição |
| `[Set: var = valor]` | Cria bloco Set variable |
| `[Webhook: https://...]` | Cria bloco Webhook |
| `[Aguardar Xs]` | Cria bloco Wait |
| `[Fila: typebotId]` | Cria bloco Typebot link |

Menus são detectados automaticamente pelo padrão `1. Texto  2. Texto  3. Texto`.

---

## 🛠️ Tecnologias

- **Node.js** + **Express 5**
- **xml2js** — parsing de XML
- **multer** — upload de arquivos
- **openai** — IA assistida (opcional)
- Interface em HTML/CSS/JS puro (sem framework)

---

## 📄 Licença

ISC
