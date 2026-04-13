const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Electron Store for persistent settings
const Store = require('electron-store');
const store = new Store();

// Libraries for document parsing
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const axios = require('axios');
const { OpenAI } = require('openai');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#0a0f1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'src/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// ─── Window Controls ──────────────────────────────────────────────────────────
ipcMain.handle('window:minimize', () => {
  mainWindow.minimize();
});

ipcMain.handle('window:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.handle('window:close', () => {
  mainWindow.close();
});

// ─── File Dialog ──────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openFile', async (event, options) => {
  return await dialog.showOpenDialog(mainWindow, options);
});

// ─── File Reading / Parsing ───────────────────────────────────────────────────
ipcMain.handle('file:read', async (event, filePath) => {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.pdf') {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return {
        success: true,
        text: data.text,
        pages: data.numpages,
        fileName: path.basename(filePath),
      };
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ path: filePath });
      return {
        success: true,
        text: result.value,
        pages: null,
        fileName: path.basename(filePath),
      };
    } else if (ext === '.txt') {
      const text = fs.readFileSync(filePath, 'utf8');
      return { success: true, text, pages: null, fileName: path.basename(filePath) };
    }
    return { success: false, error: `Unsupported file type: ${ext}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── File Reading from ArrayBuffer (drag-drop / file-input) ──────────────────
ipcMain.handle('file:readBuffer', async (event, { name, buffer }) => {
  try {
    const ext = path.extname(name).toLowerCase();
    const buf = Buffer.from(buffer);
    if (ext === '.pdf') {
      const data = await pdfParse(buf);
      return { success: true, text: data.text, pages: data.numpages, fileName: name };
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ buffer: buf });
      return { success: true, text: result.value, pages: null, fileName: name };
    } else if (ext === '.txt') {
      return { success: true, text: buf.toString('utf8'), pages: null, fileName: name };
    }
    return { success: false, error: `Unsupported file type: ${ext}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── AI Query ─────────────────────────────────────────────────────────────────
ipcMain.handle('ai:query', async (event, { prompt, systemPrompt, model, temperature }) => {
  try {
    const settings = store.get('settings') || {};
    const aiMode = settings.aiMode || 'local';

    let openai;
    let resolvedModel;

    if (aiMode === 'local') {
      openai = new OpenAI({
        baseURL: 'http://localhost:11434/v1',
        // Ollama does not require a real API key; any non-empty string works.
        apiKey: 'ollama',
      });
      resolvedModel = model || settings.localModel || 'llama3.2';
    } else {
      const apiKey = settings.openaiApiKey;
      if (!apiKey) {
        return {
          success: false,
          error: 'OpenAI API key not configured. Please go to ⚙ Settings and enter your API key.',
        };
      }
      openai = new OpenAI({ apiKey });
      resolvedModel = model || settings.aiModel || 'gpt-4o';
    }

    const response = await openai.chat.completions.create({
      model: resolvedModel,
      messages: [
        {
          role: 'system',
          content:
            systemPrompt ||
            'You are an expert Philippine law professor and practicing lawyer with deep knowledge of Philippine jurisprudence, the Civil Code, Revised Penal Code, Rules of Court, Constitution, and all major statutes. You explain the law clearly, accurately, and comprehensively.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: temperature ?? 0.3,
      max_tokens: 4096,
    });

    return { success: true, content: response.choices[0].message.content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Local AI (Ollama) Status Check ──────────────────────────────────────────
ipcMain.handle('ai:checkLocal', async () => {
  try {
    const response = await axios.get('http://localhost:11434/api/tags', { timeout: 3000 });
    const models = (response.data.models || []).map((m) => m.name);
    return { available: true, models };
  } catch (err) {
    return { available: false, models: [], reason: err.message };
  }
});

// ─── Web Search (SerpAPI) ─────────────────────────────────────────────────────
ipcMain.handle('web:search', async (event, { query }) => {
  try {
    const serpApiKey = store.get('settings.serpApiKey');
    if (!serpApiKey) {
      return {
        success: false,
        error:
          'SerpAPI key not configured. Please go to ⚙ Settings and enter your SerpAPI key (free at serpapi.com).',
      };
    }

    const response = await axios.get('https://serpapi.com/search.json', {
      params: { q: query, api_key: serpApiKey, engine: 'google', num: 10, gl: 'ph', hl: 'en' },
      timeout: 15000,
    });

    const results = (response.data.organic_results || []).map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet,
    }));

    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── Persistent Storage ───────────────────────────────────────────────────────
ipcMain.handle('storage:get', async (event, key) => {
  return store.get(key);
});

ipcMain.handle('storage:set', async (event, { key, value }) => {
  store.set(key, value);
  return true;
});

ipcMain.handle('storage:delete', async (event, key) => {
  store.delete(key);
  return true;
});

ipcMain.handle('storage:getAll', async (event, prefix) => {
  const all = store.store;
  if (!prefix) return all;
  const result = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) result[k] = v;
  }
  return result;
});

// ─── Shell ────────────────────────────────────────────────────────────────────
ipcMain.handle('shell:openExternal', async (event, url) => {
  await shell.openExternal(url);
  return true;
});

// ─── App Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
