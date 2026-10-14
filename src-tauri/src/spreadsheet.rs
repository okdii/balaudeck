//! Spreadsheet reading (Excel `.xlsx`/`.xls`/`.xlsb`, OpenDocument `.ods`) for
//! the Import Wizard, via the pure-Rust `calamine`. Every cell is flattened to a
//! string so the wizard can map columns and bind them like CSV values.
//!
//! Writing `.xlsx` (for the result-grid export) goes through the pure-Rust
//! `rust_xlsxwriter`.

use calamine::{open_workbook_auto, Data, Reader};
use rust_xlsxwriter::{Format, Workbook};
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

/// Excel caps a sheet name at 31 chars and forbids `[]:*?/\`; it also cannot be
/// blank. Return a safe name, falling back to "Sheet1".
fn safe_sheet_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "[]:*?/\\".contains(c) { '_' } else { c })
        .take(31)
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "Sheet1".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Decide whether a grid string should become a real Excel number. Conservative
/// on purpose: identifiers and codes must survive a round-trip unchanged, so we
/// reject leading-zero values (`007`), a leading `+`, anything with more than 15
/// significant digits (f64 would lose precision on big BIGINTs), and anything
/// `f64` parses as non-finite.
fn as_excel_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() || t.starts_with('+') {
        return None;
    }
    let body = t.strip_prefix('-').unwrap_or(t);
    // "007" / "00.5" are codes; "0" and "0.5" are fine.
    if body.len() > 1 && body.starts_with('0') && !body.starts_with("0.") {
        return None;
    }
    if t.chars().filter(|c| c.is_ascii_digit()).count() > 15 {
        return None;
    }
    match t.parse::<f64>() {
        Ok(n) if n.is_finite() => Some(n),
        _ => None,
    }
}

/// Write a result grid to an `.xlsx` file: a bold header row, then the data.
/// Cells that look like plain numbers are written as numbers (so Excel can sum
/// them); everything else stays text; nulls/blanks are left empty.
#[tauri::command]
pub fn write_xlsx(
    path: String,
    sheet: Option<String>,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
) -> Result<(), String> {
    // Excel's hard limits — guard so a huge grid fails cleanly, not mid-write.
    if columns.len() > 16_384 {
        return Err(format!("too many columns for Excel: {} (max 16384)", columns.len()));
    }
    if rows.len() > 1_048_575 {
        return Err(format!("too many rows for Excel: {} (max 1048575)", rows.len()));
    }

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    if let Some(name) = sheet.as_deref() {
        ws.set_name(safe_sheet_name(name)).map_err(|e| e.to_string())?;
    }

    let bold = Format::new().set_bold();
    for (c, col) in columns.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, col, &bold)
            .map_err(|e| e.to_string())?;
    }
    for (r, row) in rows.iter().enumerate() {
        let rr = (r + 1) as u32;
        for (c, cell) in row.iter().enumerate() {
            let cc = c as u16;
            match cell {
                None => {}
                Some(v) if v.is_empty() => {}
                Some(v) => match as_excel_number(v) {
                    Some(n) => {
                        ws.write_number(rr, cc, n).map_err(|e| e.to_string())?;
                    }
                    None => {
                        ws.write_string(rr, cc, v).map_err(|e| e.to_string())?;
                    }
                },
            }
        }
    }

    wb.save(&path).map_err(|e| format!("write xlsx failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlsx_round_trips_numbers_and_text() {
        let path = std::env::temp_dir().join(format!("iw_xlsx_{}.xlsx", std::process::id()));
        let p = path.to_string_lossy().to_string();
        let cols = vec!["id".into(), "code".into(), "name".into(), "amt".into()];
        let rows = vec![
            vec![Some("1".into()), Some("007".into()), Some("Alice".into()), Some("12.5".into())],
            vec![Some("9007199254740993".into()), Some("+5".into()), None, Some("3".into())],
        ];
        write_xlsx(p.clone(), Some("Result".into()), cols, rows).unwrap();

        let mut wb = open_workbook_auto(&p).unwrap();
        assert_eq!(wb.sheet_names().len(), 1);
        assert_eq!(wb.sheet_names()[0], "Result");
        let range = wb.worksheet_range("Result").unwrap();
        // header row is text
        assert!(matches!(range.get_value((0, 0)), Some(Data::String(s)) if s.as_str() == "id"));
        // clean integer -> real number; leading-zero code stays text
        assert!(matches!(range.get_value((1, 0)), Some(Data::Float(f)) if (*f - 1.0).abs() < 1e-9));
        assert!(matches!(range.get_value((1, 1)), Some(Data::String(s)) if s.as_str() == "007"));
        assert!(matches!(range.get_value((1, 3)), Some(Data::Float(f)) if (*f - 12.5).abs() < 1e-9));
        // 16-digit integer -> text (f64 would lose precision); leading + -> text
        assert!(matches!(range.get_value((2, 0)), Some(Data::String(s)) if s.as_str() == "9007199254740993"));
        assert!(matches!(range.get_value((2, 1)), Some(Data::String(s)) if s.as_str() == "+5"));

        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn safe_sheet_name_clamps_and_sanitizes() {
        assert_eq!(safe_sheet_name(""), "Sheet1");
        assert_eq!(safe_sheet_name("a/b:c"), "a_b_c");
        assert_eq!(safe_sheet_name(&"x".repeat(40)).len(), 31);
    }
}
