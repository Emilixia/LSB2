/**
 * LSB2 Philippine Law School Companion — Renderer Process
 */

'use strict';

/* ─── API stub (for running outside Electron, e.g., browser dev mode) ─────── */
if (typeof window.api === 'undefined') {
  window.api = {
    window: {
      minimize: () => {},
      maximize: () => {},
      close: () => {},
    },
    dialog: {
      openFile: async () => ({ canceled: true, filePaths: [] }),
    },
    file: {
      read: async () => ({ success: false, error: 'File reading requires the Electron app.' }),
      readFromBuffer: async () => ({ success: false, error: 'File reading requires the Electron app.' }),
    },
    ai: {
      query: async () => ({ success: false, error: 'AI requires the Electron app.' }),
      checkLocal: async () => ({ available: false, models: [] }),
    },
    web: {
      search: async () => ({ success: false, error: 'Web search requires the Electron app with a SerpAPI key configured in ⚙ Settings.' }),
    },
    storage: {
      get: async () => null,
      set: async () => true,
      delete: async () => true,
      getAll: async () => ({}),
    },
    shell: {
      openExternal: async (url) => { window.open(url, '_blank'); },
    },
  };
}

/* ─── Mermaid Init ─────────────────────────────────────────────────────────── */
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#1a6bff',
    primaryTextColor: '#e8ecf0',
    primaryBorderColor: '#1e2d40',
    lineColor: '#8896a9',
    secondaryColor: '#0d1526',
    tertiaryColor: '#111d35',
    background: '#0a0f1e',
    mainBkg: '#0d1526',
    nodeBorder: '#1e2d40',
    clusterBkg: '#111d35',
    titleColor: '#e8ecf0',
    edgeLabelBackground: '#0d1526',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
  },
});

/* ─── State ────────────────────────────────────────────────────────────────── */
let currentDocText = '';
let currentDocName = '';
let recitSession = null;
let recitMessages = [];
let isRecording = false;
let recognition = null;
let currentDeckId = null;
let currentCardIndex = 0;
let currentCards = [];
let cardFlipped = false;
let sessionCorrect = 0;
let codalData = null;
let allDecks = {};
let lqaHistory = [];
let lqaFilter = 'all';
let libraryData = null;
let libCurrentCat = 'law';
let libCurrentSubcat = null;
let libAllEntries = [];

/* ─── Navigation ───────────────────────────────────────────────────────────── */
function navigate(panelId) {
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  const btn = document.querySelector(`[data-panel="${panelId}"]`);
  const panel = document.getElementById(`panel-${panelId}`);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');

  // On-enter hooks
  if (panelId === 'dashboard') refreshDashboard();
  if (panelId === 'codal') renderCodalList();
  if (panelId === 'flashcards') renderDecks();
  if (panelId === 'settings') loadSettings();
  if (panelId === 'library') initLibrary();
}

// Sidebar click delegation
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.panel));
});

/* ─── Toast Notifications ──────────────────────────────────────────────────── */
function toast(msg, type = 'info', duration = 4000) {
  const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  // Use DOM methods to avoid XSS — never interpolate msg directly into innerHTML
  const iconSpan = document.createElement('span');
  iconSpan.textContent = icons[type] || 'ℹ️';
  const msgSpan = document.createElement('span');
  msgSpan.textContent = msg;
  el.appendChild(iconSpan);
  el.appendChild(msgSpan);
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

/* ─── Markdown-to-HTML (minimal) ───────────────────────────────────────────── */
function md(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^---$/gm, '<hr>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[a-z])(.+)$/gm, (m) => (m.trim() ? `<p>${m}</p>` : m));
}

/* ─── AI Helper ────────────────────────────────────────────────────────────── */
async function askAI(prompt, systemPrompt, model, temperature) {
  const result = await window.api.ai.query({ prompt, systemPrompt, model, temperature });
  if (!result.success) throw new Error(result.error);
  return result.content;
}

/* ─── Full-document chunked analysis ──────────────────────────────────────── */
const CHUNK_CHARS = 3500;

function splitIntoChunks(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function setUploadStatus(msg) {
  const el = document.querySelector('#upload-loading p');
  if (el) el.textContent = msg;
}

async function analyzeFullText(text) {
  if (text.length <= CHUNK_CHARS) {
    return await analyzeSinglePass(text);
  }

  const chunks = splitIntoChunks(text, CHUNK_CHARS);
  const partialSys = `You are a Philippine law professor assistant. Extract the most important information from this document segment and respond ONLY as JSON (no markdown, no extra text):
{"keyPoints":["point 1","point 2"],"laws":["law 1","law 2"]}`;
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    setUploadStatus(`🤖 Analyzing segment ${i + 1} of ${chunks.length}…`);
    const raw = await askAI(
      `Segment ${i + 1} of ${chunks.length}:\n\n${chunks[i]}`,
      partialSys,
      null,
      0.2
    );
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      partials.push(JSON.parse(m ? m[0] : raw));
    } catch {
      partials.push({ keyPoints: [raw.slice(0, 300)], laws: [] });
    }
  }

  setUploadStatus('🤖 Synthesizing full analysis…');
  const allKeyPoints = partials.flatMap((p) => p.keyPoints || []).join('\n');
  const allLaws = [...new Set(partials.flatMap((p) => p.laws || []))].join(', ');

  const synthSys = `You are an expert Philippine law professor. Synthesize these extracted points into a final structured analysis using EXACTLY this format:

## SUMMARY
Write 2–3 paragraphs summarizing the document's subject and legal significance.

## KEY POINTS
- Point 1
- Point 2
(up to 15 concise bullet points)

## DOCUMENT TYPE
State one of: case / statute / notes / codal / pleading / contract / other

## RELEVANT LAWS
- Law 1
- Law 2`;

  const synthRaw = await askAI(
    `Synthesize these extracted key points into a complete document analysis.\n\nKey Points:\n${allKeyPoints}\n\nLaws Mentioned: ${allLaws}`,
    synthSys,
    null,
    0.2
  );
  return parseAnalysisMarkdown(synthRaw);
}

async function analyzeSinglePass(text) {
  const sys = `You are an expert Philippine law professor. Analyze the document below and respond using EXACTLY this structure (keep the headings verbatim):

## SUMMARY
Write 2–3 paragraphs summarizing the document's subject, main argument, and legal significance.

## KEY POINTS
- Point 1
- Point 2
(list up to 15 concise bullet points)

## DOCUMENT TYPE
State one of: case / statute / notes / codal / pleading / contract / other

## RELEVANT LAWS
- Law or provision 1
- Law or provision 2

Do NOT include any other headings or text outside these four sections.`;
  const raw = await askAI(`Analyze this document:\n\n${text}`, sys, null, 0.2);
  return parseAnalysisMarkdown(raw);
}

function parseAnalysisMarkdown(raw) {
  // Extract named sections from the structured markdown response
  const sectionRegex = /##\s*(SUMMARY|KEY POINTS|DOCUMENT TYPE|RELEVANT LAWS)\s*\n([\s\S]*?)(?=##|$)/gi;
  const sections = {};
  let m;
  while ((m = sectionRegex.exec(raw)) !== null) {
    sections[m[1].trim().toUpperCase()] = m[2].trim();
  }

  const summary = sections['SUMMARY'] || raw.slice(0, 600);

  const keyPoints = (sections['KEY POINTS'] || '')
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);

  const docType = (sections['DOCUMENT TYPE'] || 'Document').split('\n')[0].trim();

  const relevantLaws = (sections['RELEVANT LAWS'] || '')
    .split('\n')
    .map((l) => l.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);

  return { summary, keyPoints, docType, relevantLaws };
}

/* ─── Trusted Philippine law sites for jurisprudence search ─────────────────── */
const PH_LAW_SITES = 'site:lawphil.net OR site:sc.judiciary.gov.ph OR site:chanrobles.com';
async function webSearch(query) {
  const result = await window.api.web.search({ query });
  if (!result.success) throw new Error(result.error);
  return result.results;
}

/* ─── Cache / Offline Helper ───────────────────────────────────────────────── */
async function getCached(key) {
  return window.api.storage.get(`cache.${key}`);
}
async function setCached(key, value) {
  return window.api.storage.set(`cache.${key}`, { ts: Date.now(), value });
}

/* ─── Stats / Dashboard ────────────────────────────────────────────────────── */
async function refreshDashboard() {
  const all = (await window.api.storage.getAll('stat.')) || {};
  document.getElementById('stat-docs').textContent = all['stat.docs'] || 0;
  document.getElementById('stat-cards').textContent = all['stat.cards'] || 0;
  document.getElementById('stat-briefs').textContent = all['stat.briefs'] || 0;
  document.getElementById('stat-recit').textContent = all['stat.recit'] || 0;

  const recent = (await window.api.storage.get('recent')) || [];
  const list = document.getElementById('recent-list');
  if (recent.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:24px"><span class="empty-icon">📂</span><p>No recent activity yet.</p></div>`;
    return;
  }
  list.innerHTML = recent
    .slice(0, 8)
    .map(
      (r) => `
    <div class="recent-item" onclick="navigate('${r.panel}')">
      <span class="ri-icon">${r.icon}</span>
      <div class="ri-info">
        <div class="ri-name">${escHtml(r.name)}</div>
        <div class="ri-meta">${r.type} · ${timeAgo(r.ts)}</div>
      </div>
    </div>`
    )
    .join('');
}

async function bumpStat(key) {
  const val = ((await window.api.storage.get(`stat.${key}`)) || 0) + 1;
  await window.api.storage.set(`stat.${key}`, val);
}

async function addRecent(name, type, icon, panel) {
  const recent = (await window.api.storage.get('recent')) || [];
  recent.unshift({ name, type, icon, panel, ts: Date.now() });
  await window.api.storage.set('recent', recent.slice(0, 20));
}

function timeAgo(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 1 – DOCUMENT ANALYZER
   ════════════════════════════════════════════════════════════════════════════ */

function triggerFileUpload() {
  document.getElementById('file-input').click();
}

function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('upload-zone').classList.add('drag-over');
}
function handleDragLeave(e) {
  document.getElementById('upload-zone').classList.remove('drag-over');
}
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('upload-zone').classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) processUploadedFile(file);
}
function handleFileSelect(e) {
  const file = e.target.files[0];
  if (file) processUploadedFile(file);
}

function readFileAsBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

async function processUploadedFile(file) {
  document.getElementById('upload-result').classList.remove('hidden');
  document.getElementById('upload-loading').classList.remove('hidden');
  document.getElementById('upload-content').style.opacity = '0.3';

  try {
    const buffer = await readFileAsBuffer(file);
    const readResult = await window.api.file.readFromBuffer({ name: file.name, buffer });
    if (!readResult.success) {
      toast(`Failed to read "${file.name}": ${readResult.error}`, 'error');
      document.getElementById('upload-loading').classList.add('hidden');
      return;
    }

    currentDocText = readResult.text;
    currentDocName = readResult.fileName || file.name;
    document.getElementById('upload-filename').textContent = `📄 ${currentDocName}`;

    // Check cache first
    const cacheKey = `doc_${currentDocName}_${currentDocText.length}`;
    const cached = await getCached(cacheKey);
    if (cached) {
      renderDocResult(cached.value);
      toast('Loaded from cache (offline mode)', 'info');
      return;
    }

    const parsed = await analyzeFullText(currentDocText);

    await setCached(cacheKey, parsed);
    renderDocResult(parsed);

    await bumpStat('docs');
    await addRecent(currentDocName, parsed.docType || 'Document', '📄', 'upload');
    toast('Document analyzed successfully!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    document.getElementById('upload-loading').classList.add('hidden');
    document.getElementById('upload-content').style.opacity = '1';
  }
}

function renderDocResult(parsed) {
  document.getElementById('doc-summary').innerHTML = md(parsed.summary || '');
  const kpList = document.getElementById('doc-keypoints');
  kpList.innerHTML = (parsed.keyPoints || [])
    .map(
      (kp, i) => `<li class="key-point">
        <span class="key-point-num">${i + 1}.</span>
        <span>${escHtml(kp)}</span>
      </li>`
    )
    .join('');
  document.getElementById('doc-text').textContent = currentDocText;
}

async function generateFlashcardsFromDoc() {
  if (!currentDocText) { toast('Please upload a document first.', 'warning'); return; }
  navigate('flashcards');
  document.getElementById('fc-gen-text').value = currentDocText;
  toast('Document text loaded into Flashcard Generator.', 'info');
}

async function briefFromDoc() {
  if (!currentDocText) { toast('Please upload a document first.', 'warning'); return; }
  navigate('casebrief');
  document.getElementById('brief-input').value = currentDocText;
  toast('Document text loaded into Case Brief.', 'info');
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 2 – LAW EXPLAINER
   ════════════════════════════════════════════════════════════════════════════ */

async function explainLaw() {
  const law = document.getElementById('law-input').value.trim();
  if (!law) { toast('Please enter a law, rule, or legal concept.', 'warning'); return; }

  document.getElementById('explainer-loading').classList.remove('hidden');
  document.getElementById('explainer-result').classList.add('hidden');

  try {
    const cacheKey = `explain_${law.toLowerCase().replace(/\s+/g, '_')}`;
    const cached = await getCached(cacheKey);

    let content;
    if (cached) {
      content = cached.value;
      toast('Loaded from cache.', 'info');
    } else {
      const sys = `You are a Philippine law professor with 20 years of experience. Explain the law/concept comprehensively using this structure:

# [Full Name & Citation]
## General Principles
[Core principles and purpose]

## Essential Elements / Requirements
[Numbered list of elements or requisites]

## Exceptions
[List each exception clearly]

## Exception to the Exception
[Where applicable]

## Key Jurisprudence
[List 3–5 landmark Supreme Court cases with their GR numbers, parties, year, and key ruling — ONLY cite cases you are 100% certain are real. Do NOT fabricate or guess GR numbers. If uncertain, omit.]

## Practical Application
[How this applies in practice, common bar exam angles]

## Related Laws / Cross-References
[Connected statutes, rules, or articles]

Use **bold** for key terms, and be thorough yet clear.`;

      content = await askAI(`Explain: ${law}`, sys);
      await setCached(cacheKey, content);
    }

    document.getElementById('explainer-title').textContent = `⚖️ ${law}`;
    document.getElementById('explainer-content').innerHTML = md(content);
    document.getElementById('explainer-result').classList.remove('hidden');
    document.getElementById('jurisprudence-card').classList.add('hidden');

    await addRecent(law, 'Law Explanation', '⚖️', 'explainer');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    document.getElementById('explainer-loading').classList.add('hidden');
  }
}

async function searchJurisprudence() {
  const law = document.getElementById('law-input').value.trim();
  if (!law) { toast('Please enter a law or concept first.', 'warning'); return; }

  document.getElementById('explainer-loading').classList.remove('hidden');

  try {
    const results = await webSearch(`Philippine Supreme Court cases ${law} jurisprudence ${PH_LAW_SITES}`);
    renderSearchResults(results, 'jurisprudence-list');
    document.getElementById('jurisprudence-card').classList.remove('hidden');
    document.getElementById('explainer-result').classList.remove('hidden');
    toast(`Found ${results.length} results.`, 'success');
  } catch (err) {
    toast(`Web search: ${err.message}`, 'error');
  } finally {
    document.getElementById('explainer-loading').classList.add('hidden');
  }
}

function renderSearchResults(results, containerId) {
  const el = document.getElementById(containerId);
  if (!results.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No results found.</p>';
    return;
  }
  el.innerHTML = results
    .map(
      (r) => `
    <div class="search-result-item" onclick="window.api.shell.openExternal('${escHtml(r.link)}')">
      <div class="result-title">${escHtml(r.title)}</div>
      <div class="result-snippet">${escHtml(r.snippet || '')}</div>
      <div class="result-link">🔗 ${escHtml(r.link)}</div>
    </div>`
    )
    .join('');
}

function quickExplain(law) {
  document.getElementById('law-input').value = law;
  explainLaw();
}

async function saveExplanation() {
  const title = document.getElementById('explainer-title').textContent;
  const content = document.getElementById('explainer-content').innerHTML;
  const key = `saved_explain_${Date.now()}`;
  await window.api.storage.set(key, { title, content, ts: Date.now() });
  toast('Explanation saved for offline access.', 'success');
}

async function makeFlashcardsFromExplanation() {
  const content = document.getElementById('explainer-content').innerText;
  navigate('flashcards');
  document.getElementById('fc-gen-text').value = content.slice(0, 2000);
  toast('Explanation loaded into Flashcard Generator.', 'info');
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 3 – MIND MAP
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * Sanitize AI-generated Mermaid code so it can reliably render.
 *
 * Common model mistakes fixed here:
 *   - Markdown code fences (```mermaid ... ```) wrapping the output
 *   - Special characters inside node labels: `"`, `<`, `>`, `--`, `|`
 *   - Bare `--` sequences in flowchart arrow labels that confuse the parser
 *   - Node IDs starting with digits (invalid Mermaid identifiers)
 *   - Overly long node labels (truncated to 80 chars)
 *   - Smart/curly quotes and other Unicode punctuation
 *   - Missing diagram type header
 *
 * @param {string} code - Raw Mermaid code string, possibly fence-wrapped
 * @returns {string} Sanitized Mermaid code ready for mermaid.render()
 */
function sanitizeMermaidCode(code) {
  // Strip wrapping backtick fences if the model included them
  const fence = code.match(/```(?:mermaid)?\n?([\s\S]*?)```/);
  if (fence) code = fence[1];
  code = code.trim();

  // Ensure the code starts with a recognised diagram keyword
  if (!code.match(/^(graph|flowchart|mindmap|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph)/i)) {
    code = 'flowchart TD\n' + code;
  }

  const type = code.split(/\s/)[0].toLowerCase();

  if (type === 'mindmap') {
    // In mindmap, node text is just the indented string — remove unsafe chars
    code = code
      .split('\n')
      .map((line) => {
        // Remove content inside round/square/curly brackets if they appear on a pure-text mindmap line
        return line
          .replace(/[\u201c\u201d\u2018\u2019]/g, "'") // smart quotes → '
          .replace(/[<>]/g, ' ')
          .replace(/"/g, "'")
          .replace(/---+/g, '-');
      })
      .join('\n');
  } else {
    // flowchart / graph: sanitize text inside node label brackets
    // Matches [...], {...}, (...), [/..../], [\\...\\] etc.
    code = code.replace(
      /(\[|{|\/\/|\\\\)([^\]}\n]{1,200})(\]|}|\/\/|\\\\)/g,
      (match, open, inner, close) => {
        const safe = inner
          .replace(/"/g, "'")
          .replace(/[\u201c\u201d]/g, "'")
          .replace(/[<>]/g, ' ')
          .replace(/---+/g, '-')
          .replace(/\|/g, ' ')
          .slice(0, 80); // hard-truncate very long labels
        return `${open}${safe}${close}`;
      }
    );

    // Also sanitize quoted edge labels  -->|"text"| or -->|text|
    code = code.replace(/\|([^|\n]{1,60})\|/g, (match, inner) => {
      const safe = inner.replace(/"/g, "'").replace(/[<>]/g, ' ').slice(0, 40);
      return `|${safe}|`;
    });

    // Node IDs must not start with a digit — prefix with underscore
    code = code.replace(/\b(\d+)(\[|{|\()/g, '_$1$2');
  }

  return code;
}

async function generateMindMap() {
  const topic = document.getElementById('mindmap-input').value.trim();
  const type = document.getElementById('mindmap-type').value;
  if (!topic) { toast('Please enter a topic.', 'warning'); return; }

  document.getElementById('mindmap-loading').classList.remove('hidden');
  document.getElementById('mindmap-result').classList.add('hidden');

  try {
    const cacheKey = `map_${topic.toLowerCase().replace(/\s+/g, '_')}_${type}`;
    const cached = await getCached(cacheKey);

    let mermaidCode;
    if (cached) {
      mermaidCode = cached.value;
    } else {
      let typeInstruction;
      if (type === 'mindmap') {
        typeInstruction = `Generate a Mermaid MINDMAP diagram.
Rules:
- Start with: mindmap
- Root node: root((Short Topic Name))
- Max 3 levels of indentation
- Node text: plain words only, NO parentheses, NO quotes, NO special chars, NO --
- Max 5 words per node label
- Max 20 total nodes`;
      } else if (type === 'flowchart') {
        typeInstruction = `Generate a Mermaid FLOWCHART (top-down).
Rules:
- Start with: flowchart TD
- Node IDs: single uppercase letters or short CamelCase words (e.g. A, B, Start, Arrest)
- Node labels in brackets: short phrases, max 6 words, NO special chars, NO dashes inside labels
- Use --> for connections, -->|label| for labeled edges (label max 4 words)
- Decision nodes use {Question?} format
- Max 15 nodes total`;
      } else {
        typeInstruction = `Generate a Mermaid GRAPH (left-to-right).
Rules:
- Start with: graph LR
- Node IDs: short CamelCase (e.g. SC, CA, RTC)
- Node labels in brackets: short phrases, max 6 words, NO special chars
- Use --> with optional |label| for relationships
- Max 12 nodes`;
      }

      const sys = `You are a Philippine law diagram expert. ${typeInstruction}

Output ONLY valid Mermaid code. No markdown fences, no explanation, no prose — just the diagram code.`;

      mermaidCode = await askAI(
        `Create a ${type} diagram for: ${topic} (Philippine law context)`,
        sys,
        null,
        0.1
      );

      // Strip fences and sanitize
      mermaidCode = sanitizeMermaidCode(mermaidCode);
      await setCached(cacheKey, mermaidCode);
    }

    document.getElementById('mindmap-code').value = mermaidCode;
    document.getElementById('mindmap-title').textContent = `🗺️ ${topic}`;

    await renderMindmapSvg(mermaidCode);

    document.getElementById('mindmap-result').classList.remove('hidden');
    await addRecent(topic, `${type} Diagram`, '🗺️', 'mindmap');
    toast('Diagram generated!', 'success');
  } catch (err) {
    toast(`Diagram error: ${err.message}`, 'error');
    document.getElementById('mindmap-result').classList.remove('hidden');
  } finally {
    document.getElementById('mindmap-loading').classList.add('hidden');
  }
}

/**
 * Render Mermaid SVG into the container.  On first failure, sanitize and retry once.
 */
async function renderMindmapSvg(code) {
  const container = document.getElementById('mindmap-container');
  container.innerHTML = '';

  let svg;
  try {
    const result = await mermaid.render(`mermaid-${Date.now()}`, code);
    svg = result.svg;
  } catch (firstErr) {
    // Retry with aggressive sanitisation
    const cleaned = sanitizeMermaidCode(code);
    try {
      const result = await mermaid.render(`mermaid-r${Date.now()}`, cleaned);
      svg = result.svg;
      document.getElementById('mindmap-code').value = cleaned;
    } catch (secondErr) {
      // Show friendly error with raw code
      container.innerHTML = `
        <div class="mindmap-error">
          <div class="mindmap-error-icon">⚠️</div>
          <div class="mindmap-error-title">Diagram render failed</div>
          <div class="mindmap-error-msg">${escHtml(secondErr.message.slice(0, 200))}</div>
          <div class="mindmap-error-hint">The diagram code is shown below — you can edit and re-render.</div>
        </div>`;
      throw secondErr;
    }
  }

  // Wrap in a 3-D perspective stage
  const wrapper = document.createElement('div');
  wrapper.className = 'mindmap-3d-stage';
  wrapper.innerHTML = `<div class="mindmap-3d-card">${svg}</div>`;
  container.appendChild(wrapper);

  // Mouse-tracking 3-D tilt
  const card = wrapper.querySelector('.mindmap-3d-card');
  wrapper.addEventListener('mousemove', (e) => {
    const rect = wrapper.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) / (rect.width / 2);
    const dy = (e.clientY - cy) / (rect.height / 2);
    card.style.transform = `rotateX(${-dy * 6}deg) rotateY(${dx * 6}deg) scale3d(1.01,1.01,1.01)`;
  });
  wrapper.addEventListener('mouseleave', () => {
    card.style.transform = 'rotateX(0deg) rotateY(0deg) scale3d(1,1,1)';
  });
}

function quickMap(topic, type) {
  document.getElementById('mindmap-input').value = topic;
  document.getElementById('mindmap-type').value = type;
  generateMindMap();
}

function exportMindMap() {
  const svg = document.querySelector('#mindmap-container svg');
  if (!svg) { toast('Generate a diagram first.', 'warning'); return; }
  const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mindmap.svg';
  a.click();
  URL.revokeObjectURL(url);
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 4 – CASE BRIEF
   ════════════════════════════════════════════════════════════════════════════ */

async function uploadCaseFile() {
  const result = await window.api.dialog.openFile({
    title: 'Open Case File',
    filters: [
      { name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return;
  const readResult = await window.api.file.read(result.filePaths[0]);
  if (!readResult.success) { toast(readResult.error, 'error'); return; }
  document.getElementById('brief-input').value = readResult.text.slice(0, 8000);
  toast(`${readResult.fileName} loaded.`, 'success');
}

async function generateBrief() {
  const input = document.getElementById('brief-input').value.trim();
  if (!input) { toast('Please provide case text or a GR number.', 'warning'); return; }

  document.getElementById('brief-loading').classList.remove('hidden');
  document.getElementById('brief-result').classList.add('hidden');

  try {
    const sys = `You are a Philippine law expert specializing in case analysis. Extract and analyze the case, then respond ONLY in the following JSON format:
{
  "caseName": "<full case name>",
  "grNumber": "<GR No. or citation>",
  "year": "<year decided>",
  "facts": "<clear narrative of facts>",
  "issues": "<numbered list of legal issues>",
  "ratio": "<ratio decidendi — the court's legal reasoning that justifies the ruling>",
  "ruling": "<SC ruling and dispositive portion>",
  "doctrine": "<legal doctrine/principle established>",
  "legalBasis": "<specific articles, rules, or statutes cited>",
  "syllabus": "<official or inferred case syllabus / headnotes summarising each issue and holding>",
  "disposition": "<exact final court order — granted/denied/affirmed/reversed and remanded, etc.>",
  "alac": "<ALAC analysis: Answer, Legal Basis, Application, Conclusion>",
  "recitReady": "<2–3 paragraph flowing narrative summary suitable for oral recitation or cold calling — cover facts, core issue, ratio, and ruling in plain but precise language>",
  "oneLiner": "<one memorable sentence summarizing the case — vivid and memorable>"
}`;

    const aiResult = await askAI(
      `Extract and brief this case:\n\n${input.slice(0, 6000)}`,
      sys,
      null,
      0.2
    );

    let parsed;
    try {
      const jsonMatch = aiResult.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : aiResult);
    } catch {
      toast('Could not parse AI response. Showing raw.', 'warning');
      parsed = {
        caseName: 'Case Brief',
        facts: aiResult,
        issues: '', ruling: '', doctrine: '', legalBasis: '', alac: '', oneLiner: ''
      };
    }

    renderBrief(parsed);
    await bumpStat('briefs');
    await addRecent(parsed.caseName || 'Case Brief', 'Case Brief', '📋', 'casebrief');
    toast('Case brief generated!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    document.getElementById('brief-loading').classList.add('hidden');
  }
}

function renderBrief(b) {
  document.getElementById('brief-case-name').textContent = `${b.caseName || 'Case'} (${b.grNumber || ''} · ${b.year || ''})`;
  const ol = document.getElementById('brief-one-liner');
  if (b.oneLiner) {
    ol.innerHTML = `💡 <em>"${escHtml(b.oneLiner)}"</em>`;
    ol.style.display = '';
  } else {
    ol.style.display = 'none';
  }
  document.getElementById('brief-facts').innerHTML = md(b.facts || '');
  document.getElementById('brief-issues').innerHTML = md(b.issues || '');
  document.getElementById('brief-ratio').innerHTML = md(b.ratio || '');
  document.getElementById('brief-ruling').innerHTML = md(b.ruling || '');
  document.getElementById('brief-doctrine').innerHTML = md((b.doctrine || '') + (b.legalBasis ? '\n\n**Legal Basis:** ' + b.legalBasis : ''));
  document.getElementById('brief-syllabus').innerHTML = md(b.syllabus || '');
  document.getElementById('brief-disposition').innerHTML = md(b.disposition || '');
  document.getElementById('brief-alac').innerHTML = md(b.alac || '');
  document.getElementById('brief-recitready').innerHTML = md(b.recitReady || '');
  document.getElementById('brief-result').classList.remove('hidden');

  // Reset to first tab
  switchBriefTab('facts');

  // Store for save
  window._currentBrief = b;
  loadSavedBriefs();
}

function switchBriefTab(tab) {
  document.querySelectorAll('.brief-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.brief-tab-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== tab));
}

async function saveBrief() {
  if (!window._currentBrief) { toast('Generate a brief first.', 'warning'); return; }
  const key = `brief_${Date.now()}`;
  await window.api.storage.set(key, window._currentBrief);
  toast('Brief saved!', 'success');
  loadSavedBriefs();
}

async function loadSavedBriefs() {
  const all = (await window.api.storage.getAll('brief_')) || {};
  const list = document.getElementById('saved-briefs-list');
  const items = Object.entries(all).sort((a, b) => b[0].localeCompare(a[0]));
  if (!items.length) {
    list.innerHTML = `<div class="empty-state" style="padding:20px"><span>📋</span><p>No saved briefs.</p></div>`;
    return;
  }
  list.innerHTML = items
    .map(
      ([k, b]) => `
    <div class="recent-item" onclick="loadBrief('${k}')">
      <span class="ri-icon">📋</span>
      <div class="ri-info">
        <div class="ri-name">${escHtml(b.caseName || 'Brief')}</div>
        <div class="ri-meta">${escHtml(b.grNumber || '')} · ${escHtml(b.year || '')}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteBrief('${k}')">✕</button>
    </div>`
    )
    .join('');
}

async function loadBrief(key) {
  const b = await window.api.storage.get(key);
  if (b) renderBrief(b);
}

async function deleteBrief(key) {
  await window.api.storage.delete(key);
  toast('Brief deleted.', 'info');
  loadSavedBriefs();
}

async function searchCase() {
  const input = document.getElementById('brief-input').value.trim();
  if (!input) { toast('Enter a GR number or case name to search.', 'warning'); return; }
  const query = `Philippine Supreme Court case ${input} full text lawphil.net OR sc.judiciary.gov.ph`;
  try {
    const results = await webSearch(query);
    if (results.length) {
      toast(`Found ${results.length} results. Opening top result...`, 'info');
      window.api.shell.openExternal(results[0].link);
    } else {
      toast('No results found.', 'warning');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function briefToFlashcard() {
  if (!window._currentBrief) { toast('Generate a brief first.', 'warning'); return; }
  const b = window._currentBrief;
  const text = `Case: ${b.caseName}\nFacts: ${b.facts}\nRuling: ${b.ruling}\nDoctrine: ${b.doctrine}\nOne-liner: ${b.oneLiner}`;
  navigate('flashcards');
  document.getElementById('fc-gen-text').value = text.slice(0, 2000);
  toast('Brief loaded into Flashcard Generator.', 'info');
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 5 – CODAL REFERENCE
   ════════════════════════════════════════════════════════════════════════════ */

async function loadCodalData() {
  if (codalData) return;
  const resp = await fetch('../data/codal.json');
  codalData = await resp.json();
}

async function renderCodalList(filter = '') {
  await loadCodalData();
  const container = document.getElementById('codal-list');
  const sources = codalData.sources;
  const q = filter.toLowerCase();

  container.innerHTML = sources
    .map((src) => {
      const articles = src.articles.filter(
        (a) => !q || a.ref.toLowerCase().includes(q) || a.title.toLowerCase().includes(q) || a.text.toLowerCase().includes(q)
      );
      if (!articles.length) return '';
      return `
        <div class="codal-source">
          <div class="codal-source-title">${escHtml(src.name)}</div>
          ${articles
            .map(
              (a) => `
            <div class="codal-article" data-ref="${escHtml(a.ref)}" data-source="${escHtml(src.id)}" onclick="showArtDetail('${escHtml(src.id)}','${escHtml(a.ref)}')">
              <div class="art-ref">${escHtml(a.ref)}</div>
              <div class="art-title">${escHtml(a.title)}</div>
            </div>`
            )
            .join('')}
        </div>`;
    })
    .join('');
}

function searchCodal(q) {
  renderCodalList(q);
}

async function showArtDetail(sourceId, ref) {
  await loadCodalData();
  const src = codalData.sources.find((s) => s.id === sourceId);
  if (!src) return;
  const art = src.articles.find((a) => a.ref === ref);
  if (!art) return;

  document.getElementById('art-detail-content').innerHTML = `
    <div class="art-detail">
      <div class="art-detail-ref">${escHtml(art.ref)}</div>
      <div class="art-detail-source">${escHtml(src.name)}</div>
      <div style="margin-top:8px;font-size:14px;font-weight:600;">${escHtml(art.title)}</div>
      <div class="art-detail-text mt-2">${escHtml(art.text)}</div>
    </div>`;
  document.getElementById('art-detail-overlay').classList.remove('hidden');
  document.getElementById('art-detail-overlay').style.display = 'flex';

  // Highlight this article in the list
  document.querySelectorAll('.codal-article').forEach((el) => {
    el.classList.toggle('highlighted', el.dataset.ref === ref);
  });
}

function closeArtDetail(e) {
  if (!e || e.target === document.getElementById('art-detail-overlay')) {
    document.getElementById('art-detail-overlay').classList.add('hidden');
    document.getElementById('art-detail-overlay').style.display = '';
  }
}

function highlightLinks(textarea) {
  // Note: Direct textarea content can't have clickable links.
  // This is a marker for future rich-text enhancement.
}

async function uploadCodalFile() {
  const result = await window.api.dialog.openFile({
    filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'txt'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return;
  const readResult = await window.api.file.read(result.filePaths[0]);
  if (!readResult.success) { toast(readResult.error, 'error'); return; }
  document.getElementById('codal-notes').value = readResult.text.slice(0, 10000);
  toast(`${readResult.fileName} loaded.`, 'success');
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 6 – RECIT MODE
   ════════════════════════════════════════════════════════════════════════════ */

async function startRecit() {
  const topic = document.getElementById('recit-topic').value.trim();
  const difficulty = document.getElementById('recit-difficulty').value;
  const material = document.getElementById('recit-material').value.trim();

  if (!topic) { toast('Please enter a topic for recit.', 'warning'); return; }

  recitMessages = [];
  sessionCorrect = 0;

  const context = material
    ? `\n\nReference material:\n${material.slice(0, 3000)}`
    : '';

  recitSession = {
    topic,
    difficulty,
    context,
    sys: `You are a tough but fair Philippine law professor conducting a Socratic oral recitation ("recit"). 
Topic: ${topic}
Difficulty: ${difficulty === 'easy' ? '1st year fundamentals' : difficulty === 'hard' ? 'bar exam level' : 'standard law school level'}
${context}

Rules:
1. Start by asking one specific, focused question about the topic.
2. After each student answer, grade it (Excellent/Good/Needs Improvement/Incorrect), briefly explain why, then ask a follow-up or new question.
3. Keep questions progressively harder. 
4. After 5 exchanges, give an overall performance assessment.
5. Format each response as: [QUESTION or FEEDBACK]\n---\nGrade: [grade if evaluating an answer]
6. Be direct and precise — this is recit, not a lecture.`,
  };

  document.getElementById('recit-setup-card').style.display = 'none';
  document.getElementById('recit-session').classList.remove('hidden');

  // Get first question
  setRecitStatus('thinking');
  try {
    const q = await askAI('Begin the recit. Ask your first question.', recitSession.sys);
    addChatMsg(q, 'ai');
    speakText(q);
    setRecitStatus('idle');
    await bumpStat('recit');
  } catch (err) {
    toast(err.message, 'error');
    setRecitStatus('idle');
  }
}

function setRecitStatus(status) {
  const el = document.getElementById('recit-status');
  const labels = { idle: 'Waiting for your answer', listening: '🎤 Recording...', thinking: '💭 AI is thinking...', speaking: '🔊 Speaking...' };
  el.className = `recit-status ${status}`;
  el.innerHTML = `<span class="pulse"></span> ${labels[status] || status}`;
}

function addChatMsg(text, role) {
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  const label = role === 'ai' ? '👨‍⚖️ Professor' : '👤 You';
  div.innerHTML = `<div class="msg-label">${label}</div><div>${md(text)}</div>`;
  document.getElementById('recit-chat').appendChild(div);
  document.getElementById('recit-chat').scrollTop = 9999;
  recitMessages.push({ role, text });
}

async function submitAnswer() {
  const input = document.getElementById('recit-answer');
  const answer = input.value.trim();
  if (!answer || !recitSession) { toast('Type an answer first.', 'warning'); return; }
  input.value = '';

  addChatMsg(answer, 'user');
  setRecitStatus('thinking');

  try {
    const history = recitMessages
      .map((m) => `${m.role === 'ai' ? 'Professor' : 'Student'}: ${m.text}`)
      .join('\n\n');

    const response = await askAI(
      `${history}\n\nStudent: ${answer}\n\nRespond as the professor:`,
      recitSession.sys
    );

    addChatMsg(response, 'ai');
    speakText(response);

    // Extract grade for stats
    if (response.toLowerCase().includes('excellent') || response.toLowerCase().includes('correct')) {
      sessionCorrect++;
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setRecitStatus('idle');
  }
}

function endRecit() {
  recitSession = null;
  recitMessages = [];
  document.getElementById('recit-session').classList.add('hidden');
  document.getElementById('recit-setup-card').style.display = '';
  if (recognition) recognition.stop();
  isRecording = false;
  document.getElementById('mic-btn').textContent = '🎤 Start Recording';
  setRecitStatus('idle');
  toast('Recit session ended.', 'info');
}

function toggleMic() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    toast('Speech recognition not available in this browser.', 'warning');
    return;
  }

  if (isRecording) {
    recognition && recognition.stop();
    isRecording = false;
    document.getElementById('mic-btn').textContent = '🎤 Start Recording';
    setRecitStatus('idle');
    return;
  }

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRec();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'en-PH';

  recognition.onstart = () => {
    isRecording = true;
    setRecitStatus('listening');
    document.getElementById('mic-btn').textContent = '⏹ Stop Recording';
  };
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    document.getElementById('recit-answer').value = transcript;
    submitAnswer();
  };
  recognition.onend = () => {
    isRecording = false;
    document.getElementById('mic-btn').textContent = '🎤 Start Recording';
    setRecitStatus('idle');
  };
  recognition.onerror = (e) => {
    toast(`Mic error: ${e.error}`, 'error');
    setRecitStatus('idle');
  };
  recognition.start();
}

function speakText(text) {
  const voiceEnabled = document.getElementById('s-voice');
  if (!voiceEnabled || !voiceEnabled.checked) return;
  if (!window.speechSynthesis) return;

  // Strip markdown for speech
  const clean = text.replace(/[*#`_\[\]()>]/g, '').replace(/---.*$/gm, '').slice(0, 500);
  const utt = new SpeechSynthesisUtterance(clean);
  utt.rate = 0.9;
  utt.pitch = 1;
  window.speechSynthesis.speak(utt);
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 7 – FLASHCARDS (Spaced Repetition)
   ════════════════════════════════════════════════════════════════════════════ */

async function loadAllDecks() {
  const all = (await window.api.storage.getAll('deck_')) || {};
  allDecks = all;
  return all;
}

async function renderDecks() {
  await loadAllDecks();
  const list = document.getElementById('deck-list');
  const select = document.getElementById('fc-target-deck');
  const entries = Object.entries(allDecks).sort((a, b) => b[1].created - a[1].created);

  if (!entries.length) {
    list.innerHTML = `<div class="empty-state" style="padding:20px"><span>🃏</span><p>No decks yet. Create one!</p></div>`;
    select.innerHTML = '<option value="">-- Create a deck first --</option>';
  } else {
    list.innerHTML = entries
      .map(
        ([k, d]) => `
      <div class="deck-item" onclick="studyDeck('${k}')">
        <span class="deck-icon">🃏</span>
        <div class="deck-info">
          <div class="deck-name">${escHtml(d.name)}</div>
          <div class="deck-meta">${d.cards.length} cards · ${d.cards.filter((c) => c.due <= Date.now()).length} due</div>
        </div>
        <div style="flex:1;display:flex;align-items:center;gap:8px">
          <div class="progress-bar-wrap">
            <div class="progress-bar" style="width:${d.cards.length ? Math.round(d.cards.filter(c=>c.ease>2).length / d.cards.length * 100) : 0}%"></div>
          </div>
        </div>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteDeck('${k}')">✕</button>
      </div>`
      )
      .join('');

    select.innerHTML = entries
      .map(([k, d]) => `<option value="${k}">${escHtml(d.name)}</option>`)
      .join('');
  }
}

function showNewDeck() { document.getElementById('new-deck-form').classList.remove('hidden'); }
function hideNewDeck() { document.getElementById('new-deck-form').classList.add('hidden'); }

async function createDeck() {
  const name = document.getElementById('new-deck-name').value.trim();
  if (!name) { toast('Enter a deck name.', 'warning'); return; }
  const key = `deck_${Date.now()}`;
  await window.api.storage.set(key, { name, cards: [], created: Date.now() });
  document.getElementById('new-deck-name').value = '';
  hideNewDeck();
  await renderDecks();
  toast(`Deck "${name}" created!`, 'success');
}

async function deleteDeck(key) {
  await window.api.storage.delete(key);
  await renderDecks();
  toast('Deck deleted.', 'info');
}

async function generateFlashcards() {
  const text = document.getElementById('fc-gen-text').value.trim();
  const deckKey = document.getElementById('fc-target-deck').value;
  if (!text) { toast('Enter text to generate cards from.', 'warning'); return; }
  if (!deckKey) { toast('Create or select a deck first.', 'warning'); return; }

  const btn = document.querySelector('[onclick="generateFlashcards()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...'; }

  try {
    const sys = `You are a Philippine law flashcard expert. Generate flashcards from the provided text.
Focus on:
- Legal definitions
- Enumerations and requisites (great for cloze deletions)
- Key principles and exceptions  
- Important case doctrines

Respond ONLY in this JSON format:
{"cards":[{"front":"<question or cloze with ___ blank>","back":"<answer>","type":"qa|cloze"},{"front":"...","back":"...","type":"..."}]}

Generate 8–15 focused, exam-ready cards. For cloze type, use ___ in the front to mark the blank.`;

    const aiResult = await askAI(text.slice(0, 3000), sys, null, 0.3);
    const jsonMatch = aiResult.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : aiResult);

    const deck = await window.api.storage.get(deckKey);
    const newCards = parsed.cards.map((c) => ({
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      front: c.front,
      back: c.back,
      type: c.type || 'qa',
      ease: 2.5,
      interval: 0,
      due: Date.now(),
      reps: 0,
    }));

    deck.cards.push(...newCards);
    await window.api.storage.set(deckKey, deck);
    await bumpStat('cards');
    await renderDecks();
    toast(`${newCards.length} flashcards added to "${deck.name}"!`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generate'; }
  }
}

async function studyDeck(deckKey) {
  const deck = await window.api.storage.get(deckKey);
  if (!deck) return;

  currentDeckId = deckKey;
  currentCards = deck.cards.filter((c) => c.due <= Date.now() + 86400000).sort((a, b) => a.due - b.due);
  currentCardIndex = 0;
  sessionCorrect = 0;
  cardFlipped = false;

  if (!currentCards.length) {
    toast('No cards due for review! Check back later.', 'info');
    return;
  }

  document.getElementById('study-area').style.display = 'block';
  document.getElementById('study-deck-name').textContent = `🃏 ${deck.name}`;
  document.querySelectorAll('.card').forEach((c) => {
    if (c.closest('#study-area') === null) return;
    // only hide deck list cards
  });
  showCard();
  updateFcStats();
}

function showCard() {
  if (currentCardIndex >= currentCards.length) {
    // Done
    document.getElementById('fc-front').textContent = '🎉 Session Complete!';
    document.getElementById('fc-back').textContent = `You answered ${sessionCorrect} out of ${currentCards.length} correctly.`;
    document.getElementById('fc-controls').style.display = 'none';
    return;
  }

  const card = currentCards[currentCardIndex];
  cardFlipped = false;
  document.getElementById('flashcard').classList.remove('flipped');
  document.getElementById('fc-controls').style.display = 'none';

  if (card.type === 'cloze') {
    const escapedFront = escHtml(card.front);
    document.getElementById('fc-front').innerHTML = `<div class="cloze-text">${escapedFront.replace(/___/g, '<span class="cloze-blank">[?]</span>')}</div>`;
  } else {
    document.getElementById('fc-front').textContent = card.front;
  }
  document.getElementById('fc-back').textContent = card.back;
  updateFcStats();
}

function flipCard() {
  if (currentCardIndex >= currentCards.length) return;
  cardFlipped = !cardFlipped;
  document.getElementById('flashcard').classList.toggle('flipped', cardFlipped);
  if (cardFlipped) {
    document.getElementById('fc-controls').style.display = 'flex';
    if (currentCards[currentCardIndex]?.type === 'cloze') {
      document.getElementById('fc-front').innerHTML = `<div class="cloze-text">${escHtml(currentCards[currentCardIndex].front).replace(/___/g, `<span class="cloze-blank" style="color:var(--accent-green)">${escHtml(currentCards[currentCardIndex].back)}</span>`)}</div>`;
    }
  } else {
    document.getElementById('fc-controls').style.display = 'none';
  }
}

async function rateCard(quality) {
  if (currentCardIndex >= currentCards.length) return;

  const card = currentCards[currentCardIndex];
  if (quality >= 4) sessionCorrect++;

  // SM-2 algorithm
  card.ease = Math.max(1.3, card.ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (quality < 3) {
    card.interval = 1;
  } else if (card.reps === 0) {
    card.interval = 1;
  } else if (card.reps === 1) {
    card.interval = 6;
  } else {
    card.interval = Math.round(card.interval * card.ease);
  }
  card.reps++;
  card.due = Date.now() + card.interval * 86400000;

  // Save updated card to deck
  const deck = await window.api.storage.get(currentDeckId);
  const idx = deck.cards.findIndex((c) => c.id === card.id);
  if (idx !== -1) deck.cards[idx] = card;
  await window.api.storage.set(currentDeckId, deck);

  currentCardIndex++;
  cardFlipped = false;
  document.getElementById('fc-controls').style.display = 'none';
  showCard();
}

function updateFcStats() {
  document.getElementById('fc-due').textContent = currentCards.length;
  document.getElementById('fc-remaining').textContent = currentCards.length - currentCardIndex;
  document.getElementById('fc-correct').textContent = sessionCorrect;
}

function exitStudy() {
  document.getElementById('study-area').style.display = 'none';
  currentDeckId = null;
  currentCards = [];
  renderDecks();
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 8 – LEGISLATION TRACKER
   ════════════════════════════════════════════════════════════════════════════ */

async function trackLegislation() {
  const input = document.getElementById('tracker-input').value.trim();
  const type = document.getElementById('tracker-type').value;
  if (!input) { toast('Enter a case citation or law name.', 'warning'); return; }

  document.getElementById('tracker-loading').classList.remove('hidden');
  document.getElementById('tracker-result').classList.add('hidden');

  try {
    // Ask AI about the current status
    const sys = `You are a Philippine legal researcher with up-to-date knowledge. Check the current status of the given case or law and respond ONLY in this JSON format:
{
  "title": "<full name/citation>",
  "currentStatus": "current|amended|overturned|superseded",
  "statusDetail": "<brief explanation of current status>",
  "amendments": ["<amendment 1 if any>","<amendment 2>"],
  "overturnedBy": "<case or law that overturned/superseded it, if any>",
  "latestVersion": "<cite the latest version/amendment if applicable>",
  "effectiveDate": "<date of latest amendment/ruling>",
  "searchQuery": "<best Google query to find current status online>"
}`;

    const aiResult = await askAI(
      `Check the current legal status of: ${input} (type: ${type})`,
      sys,
      null,
      0.1
    );

    let parsed;
    try {
      const jsonMatch = aiResult.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : aiResult);
    } catch {
      parsed = { title: input, currentStatus: 'unknown', statusDetail: aiResult };
    }

    // Also do a web search for latest news
    let webResults = [];
    try {
      webResults = await webSearch(
        parsed.searchQuery || `${input} Philippines law status ${new Date().getFullYear()} amended overturned`
      );
    } catch {
      // ignore search failure
    }

    document.getElementById('tracker-title').textContent = `🔔 ${parsed.title || input}`;
    renderTrackerResult(parsed, webResults);
    document.getElementById('tracker-result').classList.remove('hidden');
    await addRecent(parsed.title || input, 'Legislation Check', '🔔', 'tracker');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    document.getElementById('tracker-loading').classList.add('hidden');
  }
}

function renderTrackerResult(parsed, webResults) {
  const statusMap = {
    current: { cls: 'status-current', icon: '✅', label: 'In Force / Current' },
    amended: { cls: 'status-amended', icon: '🟡', label: 'Amended' },
    overturned: { cls: 'status-overturned', icon: '🔴', label: 'Overturned / Superseded' },
    superseded: { cls: 'status-overturned', icon: '🔴', label: 'Superseded' },
    unknown: { cls: '', icon: 'ℹ️', label: 'Status Unknown' },
  };
  const s = statusMap[parsed.currentStatus] || statusMap.unknown;

  const items = [
    { title: `${s.icon} ${s.label}`, body: parsed.statusDetail || '', cls: s.cls },
  ];
  if (parsed.amendments && parsed.amendments.length) {
    items.push({ title: '📝 Amendments', body: parsed.amendments.join('\n'), cls: 'status-amended' });
  }
  if (parsed.overturnedBy) {
    items.push({ title: '⚠️ Overturned / Superseded By', body: parsed.overturnedBy, cls: 'status-overturned' });
  }
  if (parsed.latestVersion) {
    items.push({ title: '📋 Latest Version', body: parsed.latestVersion, cls: 'status-current' });
  }

  document.getElementById('tracker-content').innerHTML = items
    .map(
      (i) => `
    <div class="tracker-item ${i.cls}">
      <div class="t-title">${escHtml(i.title)}</div>
      <div class="t-body">${escHtml(i.body)}</div>
    </div>`
    )
    .join('');

  if (webResults.length) {
    document.getElementById('tracker-search-results').innerHTML = `
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:var(--text-secondary);margin-bottom:8px">🌐 Online Sources</div>
      ${webResults
        .slice(0, 5)
        .map(
          (r) => `
        <div class="search-result-item" onclick="window.api.shell.openExternal('${escHtml(r.link)}')">
          <div class="result-title">${escHtml(r.title)}</div>
          <div class="result-snippet">${escHtml(r.snippet || '')}</div>
          <div class="result-link">🔗 ${escHtml(r.link)}</div>
        </div>`
        )
        .join('')}`;
  } else {
    document.getElementById('tracker-search-results').innerHTML = '';
  }
}

function quickTrack(name, type) {
  document.getElementById('tracker-input').value = name;
  document.getElementById('tracker-type').value = type;
  trackLegislation();
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 9 – SETTINGS
   ════════════════════════════════════════════════════════════════════════════ */

async function loadSettings() {
  const s = (await window.api.storage.get('settings')) || {};
  if (s.openaiApiKey) document.getElementById('s-openai-key').value = s.openaiApiKey;
  if (s.serpApiKey) document.getElementById('s-serp-key').value = s.serpApiKey;
  if (s.aiModel) document.getElementById('s-model').value = s.aiModel;
  if (s.localModel) document.getElementById('s-local-model').value = s.localModel;
  if (s.autosave !== undefined) document.getElementById('s-autosave').checked = s.autosave;
  if (s.offline !== undefined) document.getElementById('s-offline').checked = s.offline;
  if (s.voice !== undefined) document.getElementById('s-voice').checked = s.voice;
  const mode = s.aiMode || 'local';
  document.getElementById('s-ai-mode').value = mode;
  toggleAiModeUI(mode);
}

async function saveSettings() {
  const settings = {
    openaiApiKey: document.getElementById('s-openai-key').value.trim(),
    serpApiKey: document.getElementById('s-serp-key').value.trim(),
    aiMode: document.getElementById('s-ai-mode').value,
    aiModel: document.getElementById('s-model').value,
    localModel: document.getElementById('s-local-model').value.trim(),
    autosave: document.getElementById('s-autosave').checked,
    offline: document.getElementById('s-offline').checked,
    voice: document.getElementById('s-voice').checked,
  };
  await window.api.storage.set('settings', settings);
  toast('Settings saved!', 'success');
}

function toggleAiModeUI(mode) {
  const isLocal = mode === 'local';
  document.getElementById('s-local-section').style.display = isLocal ? '' : 'none';
  document.getElementById('s-openai-section').style.display = isLocal ? 'none' : '';
}

async function checkOllamaStatus() {
  const btn = document.getElementById('s-check-ollama');
  btn.textContent = '⏳ Checking…';
  btn.disabled = true;
  const result = await window.api.ai.checkLocal();
  btn.disabled = false;
  if (result.available) {
    const modelList = result.models.length ? result.models.join(', ') : 'none pulled yet';
    toast(`✅ Ollama is running! Available models: ${modelList}`, 'success', 7000);
    btn.textContent = '✅ Ollama Running';
  } else {
    const hint = result.reason ? ` (${result.reason})` : '';
    toast(`❌ Ollama not found${hint}. Make sure Ollama is installed and running (ollama serve).`, 'error', 8000);
    btn.textContent = '🔍 Check Ollama';
  }
}

async function clearAllData() {
  if (!confirm('Clear all cached data, flashcards, and saved briefs? This cannot be undone.')) return;
  const all = await window.api.storage.getAll('');
  for (const key of Object.keys(all || {})) {
    if (!key.startsWith('settings')) await window.api.storage.delete(key);
  }
  allDecks = {};
  toast('All data cleared.', 'info');
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 10 – LEGAL Q&A CHAT
   ════════════════════════════════════════════════════════════════════════════ */

function toggleLqaFilter(filter) {
  lqaFilter = filter;
  document.querySelectorAll('.lqa-filter').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
}

function switchLqaTab(tab) {
  document.querySelectorAll('.lqa-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('lqa-answer-pane').classList.toggle('hidden', tab !== 'answer');
  document.getElementById('lqa-sources-pane').classList.toggle('hidden', tab !== 'sources');
}

async function buildLegalContext(question) {
  await loadCodalData();
  const q = question.toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length > 4);
  const relevant = [];

  // codal.json contains statutes (law sources only); skip context for jurisprudence/issuance-only filter
  if (lqaFilter === 'jurisprudence' || lqaFilter === 'issuance') return '';

  for (const src of codalData.sources) {
    for (const art of src.articles) {
      const haystack = [art.ref, art.title, art.text].join(' ').toLowerCase();
      if (words.some((w) => haystack.includes(w))) {
        relevant.push(`[${src.short}] ${art.ref} — ${art.title}: ${art.text.slice(0, 250)}`);
      }
    }
  }

  if (!relevant.length) return '';
  return `\n\nRelevant local law database excerpts (cite from these with exact references):\n${relevant.slice(0, 12).join('\n\n')}`;
}

function extractCitations(text) {
  const cites = new Set();
  const patterns = [
    /Art(?:icle)?\.?\s*\d+[\w,\s-]*\([A-Z]+\)/g,
    /Rule\s+\d+[\w,\s-]*\(ROC\)/g,
    /R\.?A\.?\s*(?:No\.?\s*)?\d{3,5}/gi,
    /P\.?D\.?\s*(?:No\.?\s*)?\d{3,5}/gi,
    /B\.?P\.?\s*(?:Blg\.?\s*)?\d{1,3}/gi,
    /G\.?R\.?\s*No\.?\s*[\d-]+/gi,
    /[A-Z][a-z]+(?:\s+[A-Za-z.]+){1,5}\s+v\.\s+[A-Z][a-z]+(?:\s+[A-Za-z.]+){1,4}\s+\(\d{4}\)/g,
  ];
  patterns.forEach((p) => {
    const matches = text.match(p) || [];
    matches.forEach((m) => cites.add(m.trim()));
  });
  return [...cites];
}

function renderCitationBadges(html) {
  return html
    .replace(/\b(Art(?:icle)?\.?\s*[\d\w,\s]+?\((?:CC|RPC|CONST|FC)\))/g, '<span class="cite-badge cite-law">⚖️ $1</span>')
    .replace(/\b(Rule\s+[\d\w,\s]+?\(ROC\))/g, '<span class="cite-badge cite-law">⚖️ $1</span>')
    .replace(/\b(R\.?A\.?\s*(?:No\.?\s*)?\d{3,5})/gi, '<span class="cite-badge cite-law">⚖️ $1</span>')
    .replace(/\b(P\.?D\.?\s*(?:No\.?\s*)?\d{3,5})/gi, '<span class="cite-badge cite-law">⚖️ $1</span>')
    .replace(/\b(B\.?P\.?\s*(?:Blg\.?\s*)?\d{1,3})/gi, '<span class="cite-badge cite-law">⚖️ $1</span>')
    .replace(/(G\.?R\.?\s*No\.?\s*[\d-]+)/gi, '<span class="cite-badge cite-juris">📰 $1</span>')
    .replace(/([A-Z][a-z]+(?:\s+[A-Za-z.]+){1,5}\s+v\.\s+[A-Z][a-z]+(?:\s+[A-Za-z.]+){1,4}\s+\(\d{4}\))/g, '<span class="cite-badge cite-juris">📰 $1</span>');
}

function renderLqaSources(citations, webResults = []) {
  const el = document.getElementById('lqa-sources-list');
  const parts = [];

  if (citations.length) {
    parts.push(`<div class="lqa-sources-section-title">📌 Citations in Answer</div>`);
    parts.push(citations
      .map((c) => {
        const isJuris = c.match(/G\.?R\.?|v\./i);
        const icon = isJuris ? '📰' : '⚖️';
        const cls = isJuris ? 'cite-juris' : 'cite-law';
        return `<div class="lqa-source-item"><span class="cite-badge ${cls}">${icon} ${escHtml(c)}</span></div>`;
      })
      .join(''));
  }

  if (webResults && webResults.length) {
    parts.push(`<div class="lqa-sources-section-title mt-3">🔍 Verified Web Sources</div>`);
    parts.push(webResults
      .slice(0, 8)
      .map((r) => `
        <div class="lqa-web-source" onclick="window.api.shell.openExternal('${escHtml(r.link)}')">
          <div class="lqa-web-source-title">${escHtml(r.title)}</div>
          <div class="lqa-web-source-snippet">${escHtml(r.snippet || '')}</div>
          <div class="lqa-web-source-link">🔗 ${escHtml(r.link)}</div>
        </div>`)
      .join(''));
  }

  if (!parts.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:12px 0">No specific citations extracted. Try a more specific question.</p>';
    return;
  }
  el.innerHTML = parts.join('');
}

/**
 * Search for real Philippine Supreme Court cases on the topic via web search.
 * Returns a compact context string suitable for injection into the AI prompt.
 * Falls back gracefully if web search is unavailable.
 */
async function fetchRealCases(topic) {
  try {
    const results = await webSearch(
      `Philippine Supreme Court cases ${topic} ${PH_LAW_SITES}`
    );
    if (!results || !results.length) return { context: '', results: [] };
    const lines = results.slice(0, 8).map((r, i) =>
      `[${i + 1}] ${r.title} — ${r.snippet || ''} | URL: ${r.link}`
    );
    return {
      context: `\n\nVERIFIED JURISPRUDENCE from web search (ONLY cite these real cases — do not add any others):\n${lines.join('\n')}`,
      results,
    };
  } catch {
    // Web search unavailable (no SerpAPI key) — fall back gracefully
    return { context: '', results: [] };
  }
}

async function askLegalQuestion(questionOverride = null) {
  const q = questionOverride || document.getElementById('lqa-input').value.trim();
  if (!q) { toast('Please enter a question.', 'warning'); return; }

  // Reset history for a fresh question
  lqaHistory = [];
  document.getElementById('lqa-history').innerHTML = '';
  document.getElementById('lqa-loading').classList.remove('hidden');
  document.getElementById('lqa-result').classList.add('hidden');
  setLqaStatus('Searching verified Philippine case law…');

  try {
    const [legalCtx, { context: caseCtx, results: caseResults }] = await Promise.all([
      buildLegalContext(q),
      fetchRealCases(q),
    ]);

    const filterNote = lqaFilter !== 'all' ? ` Focus on ${lqaFilter} sources.` : '';
    const hasCases = caseCtx.length > 0;

    const sys = `You are an expert Philippine law advisor with deep knowledge of the Revised Penal Code, Civil Code, Rules of Court, 1987 Constitution, and landmark jurisprudence.${filterNote}

CRITICAL: ${hasCases
  ? 'Only cite cases from the VERIFIED JURISPRUDENCE list provided below. Do NOT fabricate, invent, or guess any GR number or party names. If a case is not in the list, do not cite it.'
  : 'IMPORTANT — Do NOT fabricate case citations. Do NOT invent GR numbers or party names. Only cite cases you are 100% certain about from your training data. If uncertain, omit the citation entirely.'}

When citing laws, always use these reference formats:
- Constitution: "Art. III, Sec. 14 (CONST)"
- Civil Code: "Art. 1318 (CC)"
- Revised Penal Code: "Art. 315 (RPC)"
- Rules of Court: "Rule 65, Sec. 1 (ROC)"
- Republic Acts: "R.A. No. XXXX"
- Cases (ONLY if verified): "Party v. Party, G.R. No. XXXXX (Year)"
${legalCtx}${caseCtx}

Structure your answer:
1. **Direct answer** in plain language
2. **Legal basis** — cite the specific law provisions
3. **Key elements / requirements** — numbered list
4. **Relevant jurisprudence** — only from verified sources above
5. **Practical notes** — bar exam angles or common pitfalls

Use **bold** for key legal terms and important statements.`;

    setLqaStatus('AI is analyzing your question…');
    const answer = await askAI(q, sys, null, 0.2);
    const citations = extractCitations(answer);

    document.getElementById('lqa-answer-content').innerHTML = renderCitationBadges(md(answer));
    document.getElementById('lqa-source-count').textContent = citations.length;
    renderLqaSources(citations, caseResults);

    lqaHistory.push({ role: 'user', text: q }, { role: 'ai', text: answer });

    document.getElementById('lqa-result').classList.remove('hidden');
    document.getElementById('lqa-result').style.display = 'flex';
    switchLqaTab('answer');
    toast('Answer ready.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    document.getElementById('lqa-loading').classList.add('hidden');
    setLqaStatus('');
  }
}

function setLqaStatus(msg) {
  const el = document.querySelector('#lqa-loading p');
  if (el) el.textContent = msg ? `🔍 ${msg}` : '🤖 Researching Philippine law...';
}

async function sendLqaFollowUp() {
  const input = document.getElementById('lqa-followup');
  const q = input.value.trim();
  if (!q) return;
  if (!lqaHistory.length) { toast('Ask an initial question first.', 'warning'); return; }
  input.value = '';

  // Append the prior Q&A to history display
  const histEl = document.getElementById('lqa-history');
  const prevQ = lqaHistory[lqaHistory.length - 2]?.text || '';
  const prevA = lqaHistory[lqaHistory.length - 1]?.text || '';
  if (prevQ && prevA) {
    const item = document.createElement('div');
    item.className = 'lqa-history-item card';
    item.innerHTML = `
      <div class="lqa-history-q">💬 ${escHtml(prevQ)}</div>
      <div class="lqa-history-a">${renderCitationBadges(md(prevA))}</div>`;
    histEl.appendChild(item);
  }

  document.getElementById('lqa-loading').classList.remove('hidden');
  document.getElementById('lqa-result').style.display = 'none';
  setLqaStatus('Searching verified case law for follow-up…');

  try {
    const [legalCtx, { context: caseCtx, results: caseResults }] = await Promise.all([
      buildLegalContext(q),
      fetchRealCases(q),
    ]);

    const hasCases = caseCtx.length > 0;
    const conversation = lqaHistory
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
      .join('\n\n');

    const sys = `You are an expert Philippine law advisor. Continue the following legal Q&A conversation, maintaining context.${legalCtx}${caseCtx}
CRITICAL: ${hasCases ? 'Only cite cases from the VERIFIED JURISPRUDENCE list above.' : 'Do NOT fabricate GR numbers or party names. Only cite cases you are 100% certain of.'}
When citing: "Art. X (CC/RPC/CONST)", "Rule X (ROC)", "R.A. No. XXXX", or "Party v. Party, G.R. No. XXXXX (Year)".
Be concise for follow-ups. Use **bold** for key terms.`;

    setLqaStatus('AI is analyzing your follow-up…');
    const answer = await askAI(`${conversation}\n\nUser: ${q}\n\nAssistant:`, sys, null, 0.2);
    const citations = extractCitations(answer);

    document.getElementById('lqa-answer-content').innerHTML = renderCitationBadges(md(answer));
    document.getElementById('lqa-source-count').textContent = citations.length;
    renderLqaSources(citations, caseResults);

    lqaHistory.push({ role: 'user', text: q }, { role: 'ai', text: answer });

    document.getElementById('lqa-result').style.display = 'flex';
    document.getElementById('lqa-result').classList.remove('hidden');
    switchLqaTab('answer');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    document.getElementById('lqa-loading').classList.add('hidden');
  }
}

function copyLqaAnswer() {
  const text = document.getElementById('lqa-answer-content').innerText;
  if (!text) { toast('Nothing to copy.', 'warning'); return; }
  navigator.clipboard.writeText(text).then(() => toast('Answer copied!', 'success'));
}

/* ════════════════════════════════════════════════════════════════════════════
   FEATURE 11 – LAW LIBRARY
   ════════════════════════════════════════════════════════════════════════════ */

async function loadLibraryData() {
  if (libraryData) return;
  try {
    const resp = await fetch('../data/law-catalog.json');
    libraryData = await resp.json();
  } catch {
    libraryData = { categories: { law: { subcategories: [] }, jurisprudence: { subcategories: [] }, issuance: { subcategories: [] } } };
    toast('Law catalog could not be loaded.', 'warning');
  }
}

async function initLibrary() {
  await loadLibraryData();
  // Only init once; if sidebar already populated skip
  if (document.getElementById('lib-subcategory-list').innerHTML.trim()) return;
  switchLibCat('law');
}

function switchLibCat(cat) {
  libCurrentCat = cat;
  document.querySelectorAll('.lib-cat-tab').forEach((t) => t.classList.toggle('active', t.dataset.cat === cat));

  const catData = libraryData.categories[cat];
  if (!catData) return;
  const subcats = catData.subcategories || [];

  document.getElementById('lib-subcategory-list').innerHTML = subcats
    .map((s) => `<div class="lib-subcat" data-subcat="${escHtml(s.id)}" onclick="selectLibSubcat('${escHtml(s.id)}')">${escHtml(s.name)}</div>`)
    .join('');

  if (subcats.length) selectLibSubcat(subcats[0].id);
}

function selectLibSubcat(subcatId) {
  libCurrentSubcat = subcatId;
  document.querySelectorAll('.lib-subcat').forEach((el) => el.classList.toggle('active', el.dataset.subcat === subcatId));
  document.getElementById('lib-search').value = '';

  const catData = libraryData.categories[libCurrentCat];
  const subcat = catData.subcategories.find((s) => s.id === subcatId);
  if (!subcat) return;

  document.getElementById('lib-cat-name').textContent = subcat.name;
  document.getElementById('lib-cat-desc').textContent = subcat.description || '';

  libAllEntries = subcat.entries || [];

  // Populate year filter
  const years = [...new Set(libAllEntries.map((e) => e.year).filter(Boolean))].sort((a, b) => b - a);
  const yearSel = document.getElementById('lib-year-filter');
  yearSel.innerHTML = '<option value="">📅 Year: All</option>' + years.map((y) => `<option value="${y}">${y}</option>`).join('');

  renderLibResults(libAllEntries);
}

function renderLibResults(entries) {
  document.getElementById('lib-results-count').textContent = `Results (${entries.length})`;
  if (!entries.length) {
    document.getElementById('lib-results-list').innerHTML = '<div class="empty-state" style="padding:40px"><span>📚</span><p>No entries found.</p></div>';
    return;
  }
  document.getElementById('lib-results-list').innerHTML = entries
    .map(
      (e) => `
    <div class="lib-result-item">
      <div class="lib-result-meta">
        <span class="lib-result-ref">${escHtml(e.ref || '')}</span>
        ${e.date ? `<span class="lib-result-date">• ${escHtml(e.date)}</span>` : ''}
        <button class="lib-bookmark-btn" title="View in Q&A" onclick="quickLqaFromLib('${escHtml(e.ref || '')}', '${escHtml(e.title || '')}')">💬</button>
      </div>
      <div class="lib-result-title">${escHtml(e.title || '')}</div>
      ${e.summary ? `<div class="lib-result-summary">${escHtml(e.summary)}</div>` : ''}
    </div>`
    )
    .join('');
}

function filterLibraryByYear(year) {
  const entries = year ? libAllEntries.filter((e) => String(e.year) === String(year)) : libAllEntries;
  renderLibResults(entries);
}

function searchLibrary(q) {
  if (!libraryData) return;
  const query = q.trim().toLowerCase();
  if (!query) {
    // If we have a current subcat, restore it
    if (libCurrentSubcat) {
      const catData = libraryData.categories[libCurrentCat];
      const subcat = catData && catData.subcategories.find((s) => s.id === libCurrentSubcat);
      if (subcat) renderLibResults(subcat.entries || []);
    }
    return;
  }

  // Search across all subcategories in current category tab
  const catData = libraryData.categories[libCurrentCat];
  if (!catData) return;
  const results = [];
  for (const sub of catData.subcategories || []) {
    for (const e of sub.entries || []) {
      if (
        (e.ref && e.ref.toLowerCase().includes(query)) ||
        (e.title && e.title.toLowerCase().includes(query)) ||
        (e.summary && e.summary.toLowerCase().includes(query))
      ) {
        results.push(e);
      }
    }
  }
  document.getElementById('lib-cat-name').textContent = `Search results for "${q}"`;
  document.getElementById('lib-cat-desc').textContent = '';
  libAllEntries = results;
  renderLibResults(results);
}

function quickLqaFromLib(ref, title) {
  navigate('legalqa');
  document.getElementById('lqa-input').value = `Explain ${ref} — ${title}`;
  askLegalQuestion();
}

/* ─── Init ─────────────────────────────────────────────────────────────────── */
(async function init() {
  await loadSettings();
  await refreshDashboard();
  await loadCodalData();
  renderCodalList();

  // Check if API key is configured and show a hint
  const settings = (await window.api.storage.get('settings')) || {};
  const aiMode = settings.aiMode || 'local';
  if (aiMode === 'local') {
    setTimeout(() => {
      toast('👋 Welcome to LSB2! Running in Local AI mode — no API key needed. Make sure Ollama is running.', 'info', 8000);
    }, 1000);
  } else if (!settings.openaiApiKey) {
    setTimeout(() => {
      toast('👋 Welcome to LSB2! Go to ⚙ Settings to add your OpenAI API key.', 'info', 8000);
    }, 1000);
  }
})();
