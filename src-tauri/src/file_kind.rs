//! 根据文件后缀判断文档类型：
//! - .html / .htm  -> "html"
//! - .md / .markdown -> "markdown"
//! - .pdf -> "pdf"
//! 其他后缀返回错误。

pub fn detect_kind(path: &str) -> Result<String, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") {
        Ok("markdown".to_string())
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        Ok("html".to_string())
    } else if lower.ends_with(".pdf") {
        Ok("pdf".to_string())
    } else {
        Err(format!(
            "不支持的文件类型：{}（仅支持 .html / .htm / .md / .markdown / .pdf）",
            path
        ))
    }
}
