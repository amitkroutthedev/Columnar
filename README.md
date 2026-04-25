<div align="center">

<img src="https://raw.githubusercontent.com/amitkroutthedev/Columnar/refs/heads/main/src-tauri/icons/128x128.png" alt="Columnar logo" width="96" height="96" />

# Columnar

**A lightweight desktop CSV viewer built for large datasets.**  
Open, explore, and sort files with millions of rows — without breaking a sweat.

[![Release](https://img.shields.io/github/v/release/amitkroutthedev/Columnar?style=flat-square&color=2563eb)](https://github.com/amitkroutthedev/Columnar/releases/latest)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-2563eb?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2563eb?style=flat-square)](#download)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%20v2-2563eb?style=flat-square)](https://tauri.app)

[Download](#download) · [Features](#features) · [Build from source](#build-from-source) · [Contributing](#contributing)

</div>

---

## What is Columnar?

Columnar is a native desktop application for opening and exploring CSV and TSV files of any size. Most spreadsheet tools struggle or crash with files over a few hundred megabytes. Columnar handles hundreds of millions of rows by indexing the file on open and reading rows on demand — memory usage stays low regardless of file size.

It is intentionally minimal. No cloud sync, no formulas, no editing. Just a fast, clean viewer you can drop any dataset into.

---

## Download

Get the latest installer for your operating system from the [Releases page](https://github.com/amitkroutthedev/Columnar/releases/latest).

| Platform | File |
|---|---|
| Windows | `Columnar_x.x.x_x64-setup.exe` or `Columnar_x.x.x_x64.msi` |
| macOS (Apple Silicon) | `Columnar_x.x.x_aarch64.dmg` |
| Linux | `Columnar_x.x.x_amd64.deb` or `Columnar_x.x.x_amd64.AppImage` |

> **Windows note**: You may see a SmartScreen warning on first launch because the app is currently unsigned. Click "More info" → "Run anyway" to proceed. This is expected for unsigned open-source applications.

> **macOS note**: If macOS blocks the app on first launch, right-click the `.app` and choose "Open" to bypass Gatekeeper.

---

## Features

### Core viewer
- Opens CSV and TSV files of any size — tested up to 28 million rows and 14 GB
- Virtual scroll — only the visible rows are rendered, keeping the UI fast at all row counts
- Lazy row loading — rows are read from disk on demand, not loaded into memory all at once
- Progress indicator during file indexing so you always know what's happening

### Sorting and search
- Click any column header to sort ascending, click again to sort descending
- Full-text search across all cells with highlighted matches and match count
- Parallel search and sort using all available CPU cores via Rayon

### Column stats
- Double-click any column header to open a stats panel
- Shows type (Numeric or String), count, unique count, null count, min, max, mean, median, standard deviation, and sample values

### Navigation
- Go to any row instantly via the Go to Row dialog (`Ctrl+G`)
- Keyboard navigation with arrow keys, Page Up/Down, Home, End
- Column resize by dragging the header edge
- Drag and drop a file onto the window to open it

### File management
- Native menu bar with File → Open File and File → Recent Files
- Recent files persist between sessions (last 10 files)
- Clear recent files from the menu

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Open file | `Ctrl+O` |
| Search | `Ctrl+F` |
| Go to row | `Ctrl+G` |
| Close modal / clear search | `Escape` |
| Navigate rows | `↑` `↓` `Page Up` `Page Down` |
| Jump to top / bottom | `Home` / `End` |
| Column stats | Double-click header |
| Sort column | Click header |

---

## How it works

Most CSV viewers parse the entire file into memory on open. For a 14 GB file that means 14+ GB of RAM consumed before you can see a single row.

Columnar uses a different approach:

1. **Index pass** — on open, a single pass through the file records the byte offset of every row. For 28 million rows this index is about 225 MB and takes 20–30 seconds on a large file. The window stays responsive throughout and shows live progress.
2. **On-demand parsing** — `get_page` takes the byte offsets for the requested rows, seeks directly to those positions in the memory-mapped file, and parses just those rows. 80 rows at a time, imperceptible latency.
3. **Parallel sort and search** — sort and search do a single parallel pass extracting only what they need, using Rayon across all CPU cores.

Peak memory usage is roughly: `row_count × 8 bytes` for the index, plus `displayed_rows × row_size` for the visible page. For a 28M-row file that is well under 1 GB regardless of file size.

---

## Tech stack

| Layer | Technology |
|---|---|
| App framework | [Tauri v2](https://tauri.app) |
| Backend | Rust — `csv`, `memmap2`, `rayon`, `parking_lot` |
| Frontend | Vanilla HTML, CSS, JavaScript — no framework, no bundler |
| Fonts | Syne (UI) + JetBrains Mono (data) |
| Build / release | GitHub Actions |

---

## Build from source

### Prerequisites

- [Rust](https://rustup.rs/) stable toolchain
- [Node.js](https://nodejs.org/) v18 or later
- Platform dependencies:

**Linux:**
```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf
```

**macOS:** Xcode Command Line Tools
```bash
xcode-select --install
```

**Windows:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

### Run in development

```bash
git clone https://github.com/amitkroutthedev/Columnar.git
cd Columnar
npm install
npm run tauri dev
```

### Build a release binary

```bash
npm run tauri build
```

Installers will be in `src-tauri/target/release/bundle/`.

---

## Supported file formats

| Format | Extension | Notes |
|---|---|---|
| Comma-separated | `.csv` | Standard RFC 4180, quoted fields supported |
| Tab-separated | `.tsv` | Auto-detected from extension |

Quoted newlines inside fields are handled correctly. UTF-8 BOM is stripped automatically if present.

---

## Known limitations

- **Read-only** — Columnar is a viewer. Editing cells is not supported.
- **No column filtering** — filtering by column value is not yet implemented.
- **Sort speed on very large files** — sorting a 14 GB file requires a full parallel pass and takes 5–15 seconds depending on hardware. A progress indicator for sort is planned.
- **Single file at a time** — only one file can be open per window.
- **No Excel support** — `.xlsx` files are not supported. Convert to CSV first.

---

## Roadmap

- Sort progress indicator
- Column value filtering
- Freeze / pin columns
- Export filtered/sorted subset as CSV
- Multiple tabs
- Dark / light theme toggle

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

```bash
git clone https://github.com/amitkroutthedev/Columnar.git
cd Columnar
npm install
npm run tauri dev
```

For bug reports, include your OS, file size, row count, and the exact error or behavior you saw.

---

## License

BSD-3-Clause — see [LICENSE](LICENSE) for details.

---

<div align="center">
  <sub>Built with Tauri · Rust · Vanilla JS</sub>
</div>