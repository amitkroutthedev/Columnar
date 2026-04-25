use std::sync::Arc;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use parking_lot::RwLock;
use memmap2::Mmap;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use anyhow::Context;
use tauri::{
    Manager, Emitter,
    menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder, PredefinedMenuItem},
    AppHandle, Wry,
};
use tauri_plugin_dialog::DialogExt;

// ── State ─────────────────────────────────────────────────────

#[derive(Default)]
struct CsvState {
    /// File stays memory-mapped for the lifetime of this state.
    /// Arc'd so we can cheaply clone it into spawn_blocking closures.
    mmap:         Option<Arc<Mmap>>,
    headers:      Vec<String>,
    /// Byte offset in the file where each data row starts.
    /// Length = number of data rows (excludes header).
    row_offsets:  Vec<u64>,
    /// Maps display position → original row index.
    /// Default is (0..N). After sorting, reordered accordingly.
    sorted_order: Vec<u32>,
    col_count:    usize,
    delimiter:    u8,
    file_path:    String,
    file_size:    u64,
}

type SharedState = Arc<RwLock<CsvState>>;

// ── Recent files ──────────────────────────────────────────────

const MAX_RECENT: usize = 10;
const RECENT_FILE: &str = "recent_files.json";
const MAX_ROWS: usize = u32::MAX as usize; // sorted_order uses u32

#[derive(Serialize, Deserialize, Clone, Debug)]
struct RecentEntry {
    name: String,
    path: String,
}

#[derive(Default, Serialize, Deserialize)]
struct RecentFiles {
    entries: Vec<RecentEntry>,
}

impl RecentFiles {
    fn load(app: &AppHandle) -> Self {
        let Ok(dir) = app.path().app_data_dir() else { return Self::default(); };
        let path = dir.join(RECENT_FILE);
        let Ok(bytes) = std::fs::read(&path) else { return Self::default(); };
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    fn save(&self, app: &AppHandle) -> anyhow::Result<()> {
        let dir = app.path().app_data_dir()
            .map_err(|e| anyhow::anyhow!("no app data dir: {e}"))?;
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join(RECENT_FILE);
        let json = serde_json::to_vec_pretty(self)?;
        std::fs::write(path, json)?;
        Ok(())
    }

    fn push(&mut self, path: String) {
        self.entries.retain(|e| e.path != path);

        let name = PathBuf::from(&path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&path)
            .to_string();

        self.entries.insert(0, RecentEntry { name, path });
        if self.entries.len() > MAX_RECENT {
            self.entries.truncate(MAX_RECENT);
        }
    }
}

type SharedRecents = Arc<RwLock<RecentFiles>>;

// ── Menu construction ─────────────────────────────────────────

fn build_menu(app: &AppHandle, recents: &RecentFiles) -> tauri::Result<Menu<Wry>> {
    let open_item = MenuItemBuilder::with_id("menu_open", "Open File…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;

    let quit_item = PredefinedMenuItem::quit(app, Some("Quit"))?;

    let mut recent_builder = SubmenuBuilder::new(app, "Recent Files");

    if recents.entries.is_empty() {
        let empty = MenuItemBuilder::with_id("menu_recent_empty", "No recent files")
            .enabled(false)
            .build(app)?;
        recent_builder = recent_builder.item(&empty);
    } else {
        for (i, entry) in recents.entries.iter().enumerate() {
            let label = format!("{}  —  {}", entry.name, entry.path);
            let id = format!("menu_recent_{}", i);
            let item = MenuItemBuilder::with_id(id, label).build(app)?;
            recent_builder = recent_builder.item(&item);
        }
        let sep = PredefinedMenuItem::separator(app)?;
        let clear = MenuItemBuilder::with_id("menu_recent_clear", "Clear Recent Files").build(app)?;
        recent_builder = recent_builder.item(&sep).item(&clear);
    }

    let recent_submenu = recent_builder.build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_item)
        .item(&recent_submenu)
        .separator()
        .item(&quit_item)
        .build()?;

    let menu = MenuBuilder::new(app).item(&file_menu).build()?;
    Ok(menu)
}

fn attach_menu(app: &AppHandle, recents: &RecentFiles) {
    let menu = match build_menu(app, recents) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("build_menu failed: {e}");
            return;
        }
    };

    let _ = app.set_menu(menu.clone());

    for (_label, window) in app.webview_windows() {
        if let Err(e) = window.set_menu(menu.clone()) {
            eprintln!("window.set_menu failed: {e}");
        }
    }
}

// ── Menu-triggered file picker ────────────────────────────────

fn menu_pick_and_load(app: AppHandle) {
    let app_clone = app.clone();
    app.dialog()
        .file()
        .add_filter("CSV Files", &["csv", "tsv"])
        .pick_file(move |file_path| {
            if let Some(fp) = file_path {
                if let Some(path_str) = fp.as_path().map(|p| p.to_string_lossy().into_owned()) {
                    let _ = app_clone.emit("menu://load-path", path_str);
                }
            }
        });
}

// ── Index building & row access ──────────────────────────────

#[derive(Serialize, Clone)]
struct LoadProgress {
    bytes_read:  u64,
    bytes_total: u64,
}

/// Strip a UTF-8 BOM from the start of the byte slice, if present.
fn strip_bom(data: &[u8]) -> &[u8] {
    if data.starts_with(&[0xEF, 0xBB, 0xBF]) { &data[3..] } else { data }
}

/// Build a byte-offset index over the file. Returns (headers, row_offsets).
/// Emits `load-progress` events roughly every 100ms so the UI can show progress.
fn build_index(
    app: &AppHandle,
    mmap: &Mmap,
    delimiter: u8,
) -> anyhow::Result<(Vec<String>, Vec<u64>)> {
    let bytes = strip_bom(mmap.as_ref());
    let bom_offset = (mmap.len() - bytes.len()) as u64;
    let total = mmap.len() as u64;

    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(true)
        .flexible(true)
        .from_reader(bytes);

    let headers: Vec<String> = reader
        .headers()
        .context("Failed to read CSV headers")?
        .iter()
        .map(|h| h.to_string())
        .collect();

    let mut row_offsets: Vec<u64> = Vec::new();
    // Rough heuristic preallocation: assume ~100 bytes per row on average.
    row_offsets.reserve(((total / 100).min(50_000_000)) as usize);

    let mut record = csv::ByteRecord::new();
    let mut last_emit = Instant::now();
    let emit_interval = Duration::from_millis(100);

    while reader.read_byte_record(&mut record)? {
        // position().byte() is the offset into the reader's input, which is
        // the BOM-stripped slice — add bom_offset to get the real file offset.
        let pos = record.position()
            .map(|p| p.byte())
            .unwrap_or(0);
        row_offsets.push(pos + bom_offset);

        if row_offsets.len() > MAX_ROWS {
            anyhow::bail!(
                "File has more than {} rows, which exceeds the current limit.",
                MAX_ROWS
            );
        }

        if last_emit.elapsed() >= emit_interval {
            let read = pos + bom_offset;
            let _ = app.emit("load-progress", LoadProgress {
                bytes_read: read,
                bytes_total: total,
            });
            last_emit = Instant::now();
        }
    }

    // Final progress tick at 100%.
    let _ = app.emit("load-progress", LoadProgress {
        bytes_read: total,
        bytes_total: total,
    });

    Ok((headers, row_offsets))
}

/// Given the row index, compute (start, end) byte offsets in the mmap.
/// `end` is the next row's offset, or file_size for the last row.
#[inline]
fn row_range(row_offsets: &[u64], row_idx: usize, file_size: u64) -> (u64, u64) {
    let start = row_offsets[row_idx];
    let end = if row_idx + 1 < row_offsets.len() {
        row_offsets[row_idx + 1]
    } else {
        file_size
    };
    (start, end)
}

/// Parse a single row from the mmap given its byte range.
/// Pads/truncates to col_count. Uses a one-shot csv reader over the slice.
fn parse_row_at(
    mmap: &Mmap,
    start: u64,
    end: u64,
    delimiter: u8,
    col_count: usize,
) -> Vec<String> {
    let slice = &mmap[start as usize .. end as usize];

    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(slice);

    let mut rec = csv::StringRecord::new();
    let mut row: Vec<String> = match reader.read_record(&mut rec) {
        Ok(true) => rec.iter().map(|f| f.to_string()).collect(),
        _ => Vec::new(),
    };

    while row.len() < col_count { row.push(String::new()); }
    row.truncate(col_count);
    row
}

// ── Commands ──────────────────────────────────────────────────

#[tauri::command]
async fn load_csv(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
    recents: tauri::State<'_, SharedRecents>,
    file_path: String,
) -> Result<LoadResult, String> {
    let state_arc = state.inner().clone();
    let recents_arc = recents.inner().clone();
    let app_for_task = app.clone();
    let file_path_task = file_path.clone();

    // Heavy CPU work runs on the blocking thread pool so the IPC thread
    // and the UI stay responsive throughout.
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<LoadResult, String> {
        let file = std::fs::File::open(&file_path_task)
            .with_context(|| format!("Cannot open file: {}", file_path_task))
            .map_err(|e| e.to_string())?;

        let file_size = file.metadata().map(|m| m.len()).unwrap_or(0);

        let mmap: Mmap = unsafe {
            Mmap::map(&file)
                .context("Failed to memory-map file")
                .map_err(|e| e.to_string())?
        };

        let delimiter = if file_path_task.ends_with(".tsv") { b'\t' } else { b',' };

        let (headers, row_offsets) = build_index(&app_for_task, &mmap, delimiter)
            .map_err(|e| e.to_string())?;

        let col_count = headers.len();
        let total_rows = row_offsets.len();
        let sorted_order: Vec<u32> = (0..total_rows as u32).collect();

        // Swap new state in under a short write lock.
        {
            let mut s = state_arc.write();
            s.mmap         = Some(Arc::new(mmap));
            s.headers      = headers.clone();
            s.row_offsets  = row_offsets;
            s.sorted_order = sorted_order;
            s.col_count    = col_count;
            s.delimiter    = delimiter;
            s.file_path    = file_path_task.clone();
            s.file_size    = file_size;
        }

        // Update recents.
        {
            let mut r = recents_arc.write();
            r.push(file_path_task.clone());
            let _ = r.save(&app_for_task);
            attach_menu(&app_for_task, &r);
        }

        Ok(LoadResult {
            headers,
            total_rows,
            file_size_bytes: file_size,
        })
    })
    .await
    .map_err(|e| format!("task join failed: {e}"))?;

    result
}

#[tauri::command]
fn get_recent_files(recents: tauri::State<SharedRecents>) -> Vec<RecentEntry> {
    recents.read().entries.clone()
}

#[tauri::command]
fn clear_recent_files(
    app: AppHandle,
    recents: tauri::State<SharedRecents>,
) -> Result<(), String> {
    let mut r = recents.write();
    r.entries.clear();
    r.save(&app).map_err(|e| e.to_string())?;
    attach_menu(&app, &r);
    Ok(())
}

#[derive(Serialize)]
struct LoadResult {
    headers:         Vec<String>,
    total_rows:      usize,
    file_size_bytes: u64,
}

#[derive(Serialize)]
struct ColumnStats {
    col_type:      String,
    count:         usize,
    unique_count:  usize,
    null_count:    usize,
    min:           Option<String>,
    max:           Option<String>,
    mean:          Option<f64>,
    median:        Option<f64>,
    std_dev:       Option<f64>,
    sample_values: Vec<String>,
}

/// Return a page of rows in current display order. Rows are parsed on demand
/// from the mmap — no full-file iteration, regardless of total row count.
#[tauri::command]
fn get_page(
    state: tauri::State<SharedState>,
    page: usize,
    page_size: usize,
) -> Result<Vec<Vec<String>>, String> {
    let s = state.read();
    let Some(mmap) = s.mmap.as_ref() else { return Ok(vec![]); };
    if s.sorted_order.is_empty() { return Ok(vec![]); }

    let start = page * page_size;
    if start >= s.sorted_order.len() { return Ok(vec![]); }
    let end = (start + page_size).min(s.sorted_order.len());

    let page_rows: Vec<Vec<String>> = s.sorted_order[start..end]
        .iter()
        .map(|&orig_idx| {
            let (s_off, e_off) = row_range(&s.row_offsets, orig_idx as usize, s.file_size);
            parse_row_at(mmap, s_off, e_off, s.delimiter, s.col_count)
        })
        .collect();

    Ok(page_rows)
}

/// Sort by column. Does one parallel pass extracting the sort column,
/// then sorts a key vector and writes the new display order.
#[tauri::command]
async fn sort_column(
    state: tauri::State<'_, SharedState>,
    col_index: usize,
    ascending: bool,
) -> Result<(), String> {
    // Snapshot what we need before spawning the blocking task.
    let (mmap, row_offsets, col_count, delimiter, file_size, total_rows, headers_len) = {
        let s = state.read();
        let Some(mmap) = s.mmap.clone() else { return Ok(()); };
        if s.sorted_order.is_empty() { return Ok(()); }
        if col_index >= s.headers.len() {
            return Err(format!("Column index {} out of range", col_index));
        }
        (
            mmap,
            s.row_offsets.clone(),
            s.col_count,
            s.delimiter,
            s.file_size,
            s.row_offsets.len(),
            s.headers.len(),
        )
    };
    let _ = headers_len;

    let state_arc = state.inner().clone();

    let new_order = tauri::async_runtime::spawn_blocking(move || -> Vec<u32> {
        // Helper to extract one column value from a row by index.
        let extract = |row_idx: usize| -> String {
            let (s_off, e_off) = row_range(&row_offsets, row_idx, file_size);
            let row = parse_row_at(&mmap, s_off, e_off, delimiter, col_count);
            row.get(col_index).cloned().unwrap_or_default()
        };

        // Sample first 100 non-empty values to decide numeric vs text.
        let sample_n = total_rows.min(100);
        let mut non_empty = 0usize;
        let mut parseable = 0usize;
        for i in 0..sample_n {
            let v = extract(i);
            if !v.is_empty() {
                non_empty += 1;
                if v.parse::<f64>().is_ok() { parseable += 1; }
            }
        }
        let is_numeric = non_empty > 0 && parseable == non_empty;

        // Parallel extraction of (original_row_idx, sort_key) pairs.
        if is_numeric {
            let mut keys: Vec<(u32, f64)> = (0..total_rows as u32)
                .into_par_iter()
                .map(|i| {
                    let v = extract(i as usize);
                    let k = v.parse::<f64>().unwrap_or(f64::NEG_INFINITY);
                    (i, k)
                })
                .collect();

            keys.par_sort_unstable_by(|a, b| {
                let ord = a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal);
                if ascending { ord } else { ord.reverse() }
            });

            keys.into_iter().map(|(i, _)| i).collect()
        } else {
            let mut keys: Vec<(u32, String)> = (0..total_rows as u32)
                .into_par_iter()
                .map(|i| (i, extract(i as usize)))
                .collect();

            keys.par_sort_unstable_by(|a, b| {
                let ord = a.1.cmp(&b.1);
                if ascending { ord } else { ord.reverse() }
            });

            keys.into_iter().map(|(i, _)| i).collect()
        }
    })
    .await
    .map_err(|e| format!("sort task failed: {e}"))?;

    {
        let mut s = state_arc.write();
        s.sorted_order = new_order;
    }

    Ok(())
}

/// Search all cells. Returns display positions of matching rows.
#[tauri::command]
async fn search_csv(
    state: tauri::State<'_, SharedState>,
    query: String,
) -> Result<Vec<usize>, String> {
    if query.is_empty() { return Ok(vec![]); }

    let (mmap, row_offsets, sorted_order, col_count, delimiter, file_size) = {
        let s = state.read();
        let Some(mmap) = s.mmap.clone() else { return Ok(vec![]); };
        if s.sorted_order.is_empty() { return Ok(vec![]); }
        (
            mmap,
            s.row_offsets.clone(),
            s.sorted_order.clone(),
            s.col_count,
            s.delimiter,
            s.file_size,
        )
    };

    let matches = tauri::async_runtime::spawn_blocking(move || -> Vec<usize> {
        let q = query.to_lowercase();

        sorted_order
            .par_iter()
            .enumerate()
            .filter_map(|(display_pos, &orig_idx)| {
                let (s_off, e_off) = row_range(&row_offsets, orig_idx as usize, file_size);
                let row = parse_row_at(&mmap, s_off, e_off, delimiter, col_count);
                if row.iter().any(|cell| cell.to_lowercase().contains(&q)) {
                    Some(display_pos)
                } else {
                    None
                }
            })
            .collect()
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?;

    Ok(matches)
}

/// Compute column stats via a single parallel pass.
#[tauri::command]
async fn get_column_stats(
    state: tauri::State<'_, SharedState>,
    col_index: usize,
) -> Result<ColumnStats, String> {
    let (mmap, row_offsets, col_count, delimiter, file_size, total_rows, headers_ok) = {
        let s = state.read();
        let Some(mmap) = s.mmap.clone() else { return Err("No file loaded".into()); };
        if s.sorted_order.is_empty() { return Err("No file loaded".into()); }
        if col_index >= s.headers.len() {
            return Err(format!("Column index {} out of range", col_index));
        }
        (
            mmap,
            s.row_offsets.clone(),
            s.col_count,
            s.delimiter,
            s.file_size,
            s.row_offsets.len(),
            true,
        )
    };
    let _ = headers_ok;

    let stats = tauri::async_runtime::spawn_blocking(move || -> ColumnStats {
        // Extract the entire column in parallel.
        let values: Vec<String> = (0..total_rows)
            .into_par_iter()
            .map(|i| {
                let (s_off, e_off) = row_range(&row_offsets, i, file_size);
                let row = parse_row_at(&mmap, s_off, e_off, delimiter, col_count);
                row.get(col_index).cloned().unwrap_or_default()
            })
            .collect();

        let count      = values.len();
        let null_count = values.iter().filter(|v| v.is_empty()).count();

        let mut seen = std::collections::HashSet::new();
        for v in &values { seen.insert(v.as_str().to_string()); }
        let unique_count = seen.len();

        let sample_values: Vec<String> = values
            .iter()
            .filter(|v| !v.is_empty())
            .take(5)
            .cloned()
            .collect();

        let numbers: Vec<f64> = values
            .iter()
            .filter(|v| !v.is_empty())
            .filter_map(|v| v.parse::<f64>().ok())
            .collect();

        let non_null = (count - null_count).max(1);
        let is_numeric = !numbers.is_empty()
            && numbers.len() as f64 / non_null as f64 > 0.8;

        if is_numeric {
            let n = numbers.len() as f64;
            let mean     = numbers.iter().sum::<f64>() / n;
            let variance = numbers.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / n;
            let std_dev  = variance.sqrt();

            let mut sorted_nums = numbers.clone();
            sorted_nums.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

            let median = if sorted_nums.len() % 2 == 0 {
                let mid = sorted_nums.len() / 2;
                (sorted_nums[mid - 1] + sorted_nums[mid]) / 2.0
            } else {
                sorted_nums[sorted_nums.len() / 2]
            };

            ColumnStats {
                col_type:     "Numeric".into(),
                count, unique_count, null_count,
                min:     sorted_nums.first().map(|v| v.to_string()),
                max:     sorted_nums.last().map(|v| v.to_string()),
                mean:    Some(round4(mean)),
                median:  Some(round4(median)),
                std_dev: Some(round4(std_dev)),
                sample_values,
            }
        } else {
            let non_empty: Vec<&String> = values.iter().filter(|v| !v.is_empty()).collect();
            ColumnStats {
                col_type:     "String".into(),
                count, unique_count, null_count,
                min:     non_empty.iter().min().map(|v| v.to_string()),
                max:     non_empty.iter().max().map(|v| v.to_string()),
                mean:    None,
                median:  None,
                std_dev: None,
                sample_values,
            }
        }
    })
    .await
    .map_err(|e| format!("stats task failed: {e}"))?;

    Ok(stats)
}

// ── Helpers ───────────────────────────────────────────────────

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

// ── App entry ─────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_state: SharedState = Arc::new(RwLock::new(CsvState::default()));
    let shared_recents: SharedRecents = Arc::new(RwLock::new(RecentFiles::default()));
    let recents_for_setup = shared_recents.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(shared_state)
        .manage(shared_recents)
        .setup(move |app| {
            let handle = app.handle().clone();

            let loaded = RecentFiles::load(&handle);
            {
                let mut r = recents_for_setup.write();
                *r = loaded;
            }

            let r = recents_for_setup.read();
            attach_menu(&handle, &r);

            println!("[columnar] menu attached to {} window(s)", handle.webview_windows().len());

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();

            match id.as_str() {
                "menu_open" => {
                    menu_pick_and_load(app.clone());
                }
                "menu_recent_clear" => {
                    if let Some(r_state) = app.try_state::<SharedRecents>() {
                        let mut r = r_state.write();
                        r.entries.clear();
                        let _ = r.save(app);
                        attach_menu(app, &r);
                    }
                }
                other if other.starts_with("menu_recent_") && other != "menu_recent_empty" => {
                    if let Some(idx_str) = other.strip_prefix("menu_recent_") {
                        if let Ok(idx) = idx_str.parse::<usize>() {
                            if let Some(r_state) = app.try_state::<SharedRecents>() {
                                let path_opt = r_state.read().entries.get(idx).map(|e| e.path.clone());
                                if let Some(path) = path_opt {
                                    let _ = app.emit("menu://load-path", path);
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_csv,
            get_page,
            sort_column,
            search_csv,
            get_column_stats,
            get_recent_files,
            clear_recent_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}