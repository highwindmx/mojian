//! 文档类型分类（按后缀 / 文件名）。
//!
//! - 已知富文本 / 二进制类型 -> 固定 kind（markdown / html / json / svg / pdf / epub）
//! - 纯文本后缀白名单、以及常见的无后缀文件名 -> `"text"`（可编辑）
//! - 其它后缀 -> `Unknown`：由 `open_file` 做二进制嗅探后按文本打开（可编辑，仍做二进制嗅探保护）
//!
//! `Unknown` 不等于「不支持」：墨笺允许拖入 / 打开任意文本文件，
//! 但不抢系统文件关联（尤其不抢 .txt 的默认程序），也不注册新的文件类型图标。

pub enum FileClass {
    Known(String),
    Unknown,
}

/// 常见纯文本 / 代码后缀（小写，不含点）。
/// 这些后缀走纯源码编辑器（不进 WYSIWYG），保存时原样写回。
const TEXT_EXTS: &[&str] = &[
    "txt", "text", "log", "csv", "tsv", "ini", "cfg", "conf", "config",
    "yaml", "yml", "xml", "css", "scss", "less", "js", "mjs", "cjs",
    "ts", "tsx", "jsx", "json5", "jsonc", "py", "rb", "go", "rs", "java",
    "kt", "c", "h", "cc", "cpp", "hpp", "cs", "sh", "bash", "zsh", "bat",
    "cmd", "ps1", "sql", "toml", "properties", "diff", "patch", "tex",
    "rst", "srt", "vtt", "lua", "php", "pl", "swift", "scala", "dart",
    "vue", "svelte", "gradle", "make", "am", "asm", "s", "r", "m",
];

/// 常见无后缀 / 点开头的文件名（小写，全名匹配）。
const TEXT_NAMES: &[&str] = &[
    "makefile", "dockerfile", "readme", "license", "changelog",
    "contributing", "gemfile", "rakefile", "procfile", "vagrantfile",
    "cmakelists", "authors", "notice", "todo", "install", "news",
    ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig",
    ".env", ".npmrc", ".nvmrc", ".dockerignore", ".eslintignore",
    ".prettierignore", ".gitconfig", ".bashrc", ".zshrc", ".profile",
];

/// 取小写文件名（不含目录），兼容 Windows / Unix 两种分隔符。
fn file_name_lower(path: &str) -> String {
    let s = path.replace('\\', "/");
    let name = s.rsplit('/').next().unwrap_or("");
    name.to_lowercase()
}

/// 统一分类入口。
pub fn classify(path: &str) -> FileClass {
    let lower = path.to_lowercase();
    // 既有已知类型优先（这些后缀不走纯文本通道，避免覆盖专门的渲染逻辑）
    let known = if lower.ends_with(".md") || lower.ends_with(".markdown") {
        Some("markdown")
    } else if lower.ends_with(".html") || lower.ends_with(".htm") {
        Some("html")
    } else if lower.ends_with(".json") {
        Some("json")
    } else if lower.ends_with(".svg") {
        Some("svg")
    } else if lower.ends_with(".pdf") {
        Some("pdf")
    } else if lower.ends_with(".epub") {
        Some("epub")
    } else {
        None
    };
    if let Some(k) = known {
        return FileClass::Known(k.to_string());
    }

    let name = file_name_lower(path);
    // 1) 无后缀 / 点开头的已知文件名（Makefile、.gitignore 等）
    if TEXT_NAMES.contains(&name.as_str()) {
        return FileClass::Known("text".to_string());
    }
    // 2) 明确的纯文本后缀；ext == name 说明压根没有后缀，交给 Unknown 只读通道
    let ext = name.rsplit('.').next().unwrap_or("");
    if !ext.is_empty() && ext != name && TEXT_EXTS.contains(&ext) {
        return FileClass::Known("text".to_string());
    }
    FileClass::Unknown
}

/// 兼容既有调用：已知类型返回 Ok(kind)。
/// `Unknown` 单独返回 Err，调用方（`open_file`）已改用 `classify` 按只读文本处理，
/// `read_file_base64` 等二进制通道仍可用此函数做白名单校验。
pub fn detect_kind(path: &str) -> Result<String, String> {
    match classify(path) {
        FileClass::Known(k) => Ok(k),
        FileClass::Unknown => Err(format!(
            "未知文件类型：{}（可按文本只读打开；二进制文件会被拒绝）",
            path
        )),
    }
}

/// 目录导航（上一个 / 下一个）只列「明确支持」的文件，
/// 不把整个目录里的杂项都塞进导航列表。
pub fn is_listed(path: &str) -> bool {
    matches!(classify(path), FileClass::Known(_))
}
