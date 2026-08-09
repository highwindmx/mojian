use serde::Serialize;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

/// 打开文件返回的结构体
#[derive(Serialize)]
pub struct FileContent {
    pub path: String,
    pub kind: String,
    pub content: String,
}

/// 保存文件返回的结构体
#[derive(Serialize)]
pub struct SaveResult {
    pub path: String,
    pub kind: String,
}

/// 图片 base64 返回的结构体
#[derive(Serialize)]
pub struct ImageData {
    pub mime: String,
    pub data: String,
}

/// 任意文件（二进制）按 base64 返回的结构体，用于 PDF 等需要字节而非文本的场景。
#[derive(Serialize)]
pub struct FileBlob {
    pub kind: String,
    pub mime: String,
    pub data: String,
}

/// 批量写入文件的单项（base64 字节）
#[derive(Deserialize)]
pub struct BytesFile {
    pub path: String,
    pub data: String,
}

/// 打开本地文件：按后缀路由类型，返回原始文本。
/// encoding: 可选 "gbk" / "utf-8"；省略时优先 UTF-8，失败后回退 GBK 兜底。
#[tauri::command]
pub fn open_file(path: String, encoding: Option<String>) -> Result<FileContent, String> {
    let kind = crate::file_kind::detect_kind(&path)?;
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败：{}", e))?;
    let content = decode_bytes(&bytes, encoding.as_deref())?;
    Ok(FileContent { path, kind, content })
}

/// 保存文件：content 已是最终要写盘的文本，原样（按编码）写回指定路径。
/// encoding: 可选 "gbk" / "utf-8"；省略默认 UTF-8。
#[tauri::command]
pub fn save_file(
    path: String,
    kind: String,
    content: String,
    encoding: Option<String>,
) -> Result<SaveResult, String> {
    let bytes = encode_string(&content, encoding.as_deref())?;
    fs::write(&path, bytes).map_err(|e| format!("写入文件失败：{}", e))?;
    Ok(SaveResult { path, kind })
}

/// 字节按编码解码为字符串
fn decode_bytes(bytes: &[u8], encoding: Option<&str>) -> Result<String, String> {
    match encoding.map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("gbk") | Some("gb2312") => {
            let (cow, _, _) = encoding_rs::GBK.decode(bytes);
            Ok(cow.into_owned())
        }
        Some("utf-8") | Some("utf8") => {
            String::from_utf8(bytes.to_vec()).map_err(|e| format!("UTF-8 解码失败：{}", e))
        }
        _ => match String::from_utf8(bytes.to_vec()) {
            Ok(s) => Ok(s),
            Err(_) => {
                // 未指定编码时，UTF-8 失败再尝试 GBK（兼容国内老文档）
                let (cow, _, _) = encoding_rs::GBK.decode(bytes);
                Ok(cow.into_owned())
            }
        },
    }
}

/// 字符串按编码编码为字节
fn encode_string(s: &str, encoding: Option<&str>) -> Result<Vec<u8>, String> {
    match encoding.map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("gbk") | Some("gb2312") => {
            let (cow, _, _) = encoding_rs::GBK.encode(s);
            Ok(cow.into_owned())
        }
        _ => Ok(s.as_bytes().to_vec()),
    }
}

/// 读取本地图片并返回 base64（含 MIME），用于编辑器内嵌图片。
#[tauri::command]
pub fn read_image_base64(path: String) -> Result<ImageData, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取图片失败：{}", e))?;
    let mime = infer_mime(&path);
    let data = base64_encode(&bytes);
    Ok(ImageData { mime, data })
}

/// 读取任意本地文件并按 base64 返回字节（含类型与 MIME）。
/// 用于 PDF 等二进制文档：前端拿到字节后用 pdf.js / pdf-lib 渲染或改写。
#[tauri::command]
pub fn read_file_base64(path: String) -> Result<FileBlob, String> {
    let kind = crate::file_kind::detect_kind(&path)?;
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败：{}", e))?;
    let mime = infer_mime(&path);
    let data = base64_encode(&bytes);
    Ok(FileBlob { kind, mime, data })
}

/// 把 base64 字节写回指定路径（用于 PDF 旋转/合并/拆分后的保存回写）。
#[tauri::command]
pub fn save_file_bytes(path: String, data: String) -> Result<SaveResult, String> {
    let bytes = base64_decode(&data)?;
    fs::write(&path, bytes).map_err(|e| format!("写入文件失败：{}", e))?;
    let kind = crate::file_kind::detect_kind(&path).unwrap_or_else(|_| "pdf".to_string());
    Ok(SaveResult { path, kind })
}

/// 批量把多份 base64 字节写入各自路径（用于 PDF 拆分产出多个文件）。
#[tauri::command]
pub fn save_files_bytes(files: Vec<BytesFile>) -> Result<(), String> {
    for f in files {
        let bytes = base64_decode(&f.data)?;
        fs::write(&f.path, bytes)
            .map_err(|e| format!("写入 {} 失败：{}", f.path, e))?;
    }
    Ok(())
}

/// 返回应用版本号（取 Cargo 包版本）。
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 在系统文件管理器中打开文件所在位置。
/// Windows: explorer /select,"<path>"（高亮选中该文件）；
/// macOS: open -R <path>；Linux: xdg-open <目录>。
#[tauri::command]
pub fn open_containing_folder(path: String) -> Result<(), String> {
    use std::process::Command;
    let p = std::path::Path::new(&path);
    let status = if cfg!(target_os = "windows") {
        // 注意：explorer 在已有实例运行时会把请求委派给现有实例并以退出码 1 退出，
        // 即便操作实际成功；因此 Windows 下不按退出码判错，只要进程能启动即视为成功。
        // 采用规范写法 `explorer /select, "路径"`（逗号后空格、路径作为独立参数）。
        Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .status()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg("-R").arg(&path).status()
    } else {
        let dir = if p.is_dir() {
            p.to_path_buf()
        } else {
            p.parent()
                .map(|x| x.to_path_buf())
                .unwrap_or_else(|| std::path::PathBuf::from("."))
        };
        Command::new("xdg-open").arg(&dir).status()
    };
    match status {
        Err(e) => Err(format!("打开文件位置失败：{}", e)),
        Ok(s) => {
            if cfg!(target_os = "windows") || s.success() {
                Ok(())
            } else {
                Err(format!("打开文件位置失败，命令退出码 {:?}", s.code()))
            }
        }
    }
}

/// 配置文件的路径：与当前 exe 同目录下的 mojian.config.json
fn config_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("mojian.config.json"))
}

/// 读取配置（JSON 文本）。文件不存在时返回空对象 "{}"。
#[tauri::command]
pub fn read_config() -> Result<String, String> {
    let path = config_path().ok_or_else(|| "无法确定配置路径".to_string())?;
    if !path.exists() {
        return Ok(String::from("{}"));
    }
    fs::read_to_string(&path).map_err(|e| format!("读取配置失败：{}", e))
}

/// 写入配置（JSON 文本）。
#[tauri::command]
pub fn write_config(content: String) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "无法确定配置路径".to_string())?;
    fs::write(&path, content).map_err(|e| format!("写入配置失败：{}", e))
}

/// 根据后缀推断图片 MIME（不依赖外部 crate，覆盖常见类型）。
fn infer_mime(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png".to_string()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg".to_string()
    } else if lower.ends_with(".gif") {
        "image/gif".to_string()
    } else if lower.ends_with(".webp") {
        "image/webp".to_string()
    } else if lower.ends_with(".bmp") {
        "image/bmp".to_string()
    } else if lower.ends_with(".mp4") {
        "video/mp4".to_string()
    } else if lower.ends_with(".webm") {
        "video/webm".to_string()
    } else if lower.ends_with(".ogg") || lower.ends_with(".ogv") {
        "video/ogg".to_string()
    } else if lower.ends_with(".mov") {
        "video/quicktime".to_string()
    } else if lower.ends_with(".avi") {
        "video/x-msvideo".to_string()
    } else if lower.ends_with(".pdf") {
        "application/pdf".to_string()
    } else {
        "application/octet-stream".to_string()
    }
}

/// 返回启动时通过命令行参数传入、需要打开的本地文件路径（文件关联双击场景）。
/// Windows 双击 .md/.html/.pdf 时，系统把路径作为 argv 传给 exe，Tauri 不会自动打开，
/// 故在此读取：仅取第一个后缀为 .md/.markdown/.html/.htm/.pdf 且确实存在的文件参数；无则 None。
/// 兼容以 file:// 形式传入的路径（剥离前缀与多余斜杠）。
#[tauri::command]
pub fn get_initial_file() -> Option<String> {
    for arg in std::env::args().skip(1) {
        let path = match arg.strip_prefix("file://") {
            Some(s) => s.strip_prefix('/').unwrap_or(s).to_string(),
            None => arg.clone(),
        };
        let lower = path.to_lowercase();
        let is_supported = lower.ends_with(".md")
            || lower.ends_with(".markdown")
            || lower.ends_with(".html")
            || lower.ends_with(".htm")
            || lower.ends_with(".pdf");
        if is_supported && std::path::Path::new(&path).is_file() {
            return Some(path);
        }
    }
    None
}

/// 不依赖外部 crate 的 base64 编码实现（标准字母表，输出含 '=' 填充）。
fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[b0 >> 2] as char);
        out.push(CHARS[((b0 & 0x03) << 4) | (b1 >> 4)] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[b2 & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// 不依赖外部 crate 的 base64 解码（标准字母表，支持 '=' 填充与空白字符）。
/// 与 base64_encode 配对，用于将前端传回的字节写盘。
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (i, &c) in CHARS.iter().enumerate() {
        lookup[c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;
    for &b in s.as_bytes() {
        if b == b'=' {
            break;
        }
        if b == b'\n' || b == b'\r' || b == b' ' || b == b'\t' {
            continue;
        }
        let v = lookup[b as usize];
        if v == 255 {
            return Err("非法 base64 字符".to_string());
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}
