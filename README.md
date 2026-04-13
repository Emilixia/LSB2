# LSB2 – Philippine Law School AI Study Companion

> A desktop Electron app for Philippine law students powered by AI.

## Features

1. **📄 Document Analyzer** — Upload PDF, DOCX, or TXT files. AI summarizes the content and extracts key points. Offline-capable via caching.
2. **⚖️ Law Explainer** — Explain any Philippine law, rule, or legal concept: general principles, elements, exceptions, exceptions to exceptions, and landmark jurisprudence.
3. **🗺️ Mind Map & Flowchart Generator** — Visualize rules of court, appeals processes, legal relationships using AI-generated Mermaid diagrams.
4. **📋 Case Brief Automator** — Extract Facts, Issues, Ruling, Doctrine (FIRC) and generate an ALAC analysis plus a memorable one-liner from any SCRA decision.
5. **📚 Codal Reference** — Split-screen view with your notes/cases on one side and Philippine codal provisions (Constitution, Civil Code, RPC, Rules of Court, Family Code) on the other. Click any article to pop up its full text.
6. **🎙️ Recit Mode** — AI-powered Socratic mock oral exams. Type or speak your answers; the AI grades each response and drills deeper.
7. **🃏 Flashcards** — Anki-style spaced-repetition cards with cloze deletions auto-generated from your study material or case briefs. SM-2 algorithm.
8. **🔔 Legislation Tracker** — Check if a case has been overturned or a law has been amended by newer Republic Acts, verified via web search.
9. **🌐 Web Search Integration** — Jurisprudence lookup via SerpAPI (Google). Always cites real sources; no hallucinated cases.
10. **💾 Offline Support** — All AI analyses are cached locally in `electron-store`; flashcard decks and briefs are available 100% offline after first generation.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 28 |
| Document parsing | `pdf-parse`, `mammoth` |
| AI | OpenAI GPT-4o via official SDK |
| Web search | SerpAPI |
| Diagrams | Mermaid.js |
| Storage | `electron-store` (JSON, offline) |
| UI | Vanilla HTML/CSS/JS |

## Setup & Run

### Prerequisites
- Node.js ≥ 18
- An OpenAI API key ([get one here](https://platform.openai.com/api-keys))
- A SerpAPI key ([free tier available](https://serpapi.com)) — required for web search features

### Installation

```bash
git clone https://github.com/Emilixia/LSB2.git
cd LSB2
npm install
npm start
```

On first launch, go to **⚙ Settings** and enter your:
- **OpenAI API Key** — for all AI features (document analysis, law explanations, case briefs, flashcard generation, recit mode, legislation tracking)
- **SerpAPI Key** — for web search and jurisprudence lookup

### Build (Windows installer)

```bash
npm run build
```

Output: `dist/LSB2-Law-Companion-Setup.exe`

## Usage Guide

### Document Analyzer
1. Click **📄 Analyze** in the sidebar
2. Drop a PDF or DOCX file onto the upload zone (or click to browse)
3. The AI will summarize and extract key points
4. Use **Create Flashcards** or **Generate Brief** to continue studying

### Law Explainer
1. Click **⚖️ Laws** in the sidebar
2. Type a law name (e.g., "Rule 65 Certiorari", "Art. 1318 Civil Code", "Psychological Incapacity")
3. Click **Explain** for a comprehensive breakdown with principles, exceptions, and jurisprudence
4. Click **Search Cases** to find related Supreme Court decisions online

### Case Brief
1. Click **📋 Brief** in the sidebar
2. Upload a case PDF or paste the text / GR number
3. Click **Generate Brief** for the FIRC + ALAC breakdown
4. The memorable **One-Liner Recall** appears at the top

### Recit Mode
1. Click **🎙️ Recit** in the sidebar
2. Enter a topic and select difficulty
3. Optionally paste reference material
4. Click **Start Recit Session** — the AI will begin questioning you
5. Type your answer or click **Start Recording** to speak

### Flashcards
1. Click **🃏 Cards** in the sidebar
2. Create a deck with **+ New Deck**
3. Generate cards with AI by pasting text and clicking **✨ Generate**
4. Click a deck to start studying; rate each card (Again / Hard / Good / Easy)

### Legislation Tracker
1. Click **🔔 Track** in the sidebar
2. Enter a case citation or law name
3. Click **Check Status** — the AI reports if it's current, amended, or overturned, plus links to online sources

## Data & Privacy

- API keys are stored locally in your OS's app data folder (encrypted by `electron-store`)
- No data is sent anywhere except directly to OpenAI and SerpAPI when you trigger an AI/search action
- All cached content is stored locally for offline use

## License

MIT