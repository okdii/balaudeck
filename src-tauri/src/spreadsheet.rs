//! Spreadsheet reading (Excel `.xlsx`/`.xls`/`.xlsb`, OpenDocument `.ods`) for
//! the Import Wizard, via the pure-Rust `calamine`. Every cell is flattened to a
//! string so the wizard can map columns and bind them like CSV values.

use calamine::{open_workbook_auto, Data, Reader};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spreadsheet {
    /// Every sheet in the workbook (so the UI can offer a sheet picker).
    pub sheets: Vec<String>,
    /// The sheet actually read.
    pub sheet: String,
    /// Column labels — the first row when `has_header`, else `Column N`.
    pub header: Vec<String>,
    /// Data rows (header excluded when `has_header`); blank cells become null.
    pub rows: Vec<Vec<Option<String>>>,
}

/// Flatten one cell to a SQL-friendly string. Whole floats lose the trailing
/// `.0` (ids/counts), serial dates become `YYYY-MM-DD HH:MM:SS`, blanks → null.
fn cell(c: &Data) -> Option<String> {
    match c {
        Data::Empty => None,
        Data::String(s) => {
            if s.trim().is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
        Data::Int(i) => Some(i.to_string()),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                Some((*f as i64).to_string())
            } else {
                Some(f.to_string())
            }
        }
        Data::Bool(b) => Some(if *b { "1" } else { "0" }.to_string()),
        Data::DateTime(dt) => dt
            .as_datetime()
            .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string()),
        Data::DateTimeIso(s) => Some(s.clone()),
        Data::DurationIso(s) => Some(s.clone()),
        Data::Error(e) => Some(format!("{e:?}")),
    }
}

/// Read one sheet of a spreadsheet file. Returns the header + data rows as
/// strings and the list of sheet names. The UI parses CSV itself; this covers
/// the binary formats it can't.
#[tauri::command]
pub fn read_spreadsheet(
    path: String,
    sheet: Option<String>,
    has_header: bool,
) -> Result<Spreadsheet, String> {
    let mut wb = open_workbook_auto(&path).map_err(|e| format!("open spreadsheet failed: {e}"))?;
    let sheets: Vec<String> = wb.sheet_names().to_vec();
    let target = sheet
        .filter(|s| !s.is_empty())
        .or_else(|| sheets.first().cloned())
        .ok_or("the workbook has no sheets")?;
    let range = wb
        .worksheet_range(&target)
        .map_err(|e| format!("read sheet '{target}' failed: {e}"))?;

    let width = range.width();
    let mut iter = range.rows();
    let header: Vec<String> = if has_header {
        iter.next()
            .map(|r| {
                (0..width)
                    .map(|i| {
                        r.get(i)
                            .and_then(cell)
                            .unwrap_or_else(|| format!("Column {}", i + 1))
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        (1..=width).map(|i| format!("Column {i}")).collect()
    };

    let rows: Vec<Vec<Option<String>>> = iter
        .map(|r| (0..width).map(|i| r.get(i).and_then(cell)).collect())
        .collect();

    Ok(Spreadsheet {
        sheets,
        sheet: target,
        header,
        rows,
    })
}
