use serde::Serialize;
use std::fs;

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

/// 打开本地文件：按后缀路由类型，返回原始文本。
/// 注意：这里不区分文件是否存在/可读，错误统一以 String 返回给前端处理。
#[tauri::command]
pub fn open_file(path: String) -> Result<FileContent, String> {
    let kind = crate::file_kind::detect_kind(&path)?;
    let content = fs::read_to_string(&path).map_err(|e| format!("读取文件失败：{}", e))?;
    Ok(FileContent { path, kind, content })
}

/// 保存文件：content 已是最终要写盘的文本，原样写回指定路径。
/// kind 仅用于回传，便于前端确认保存类型。
#[tauri::command]
pub fn save_file(path: String, kind: String, content: String) -> Result<SaveResult, String> {
    fs::write(&path, content).map_err(|e| format!("写入文件失败：{}", e))?;
    Ok(SaveResult { path, kind })
}

/// 读取本地图片并返回 base64（含 MIME），用于编辑器内嵌图片。
#[tauri::command]
pub fn read_image_base64(path: String) -> Result<ImageData, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取图片失败：{}", e))?;
    let mime = infer_mime(&path);
    let data = base64_encode(&bytes);
    Ok(ImageData { mime, data })
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
        // 采用规范写法 `explorer /select, "路径"`（逗号后空格、路径作为独立参数），
        // 此前把整条合进一个带引号的参数会因 Rust 对引号转义而破坏命令行，定位到错误位置。
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
    } else {
        "application/octet-stream".to_string()
    }
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
