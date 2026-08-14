use serde::Serialize;
use serde::Deserialize;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::process::Command;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use zip::ZipArchive;

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

/// ===================== EPUB 只读支持 =====================
/// EPUB 本质是 ZIP 包：META-INF/container.xml -> content.opf（manifest + spine）-> 多个 XHTML 章节。
/// 本模块只做「只读预览」：open_epub 解析出章节目录，get_epub_chapter 取出单章并内联图片/CSS 为自包含 HTML。

#[derive(Serialize)]
pub struct EpubChapter {
    pub id: String,
    pub title: String,
    /// 相对 OPF 目录归一化后的 ZIP 内路径
    pub href: String,
}

#[derive(Serialize)]
pub struct EpubMeta {
    pub chapters: Vec<EpubChapter>,
}

#[derive(Serialize)]
pub struct EpubChapterHtml {
    pub html: String,
}

/// 把 ZIP 内某条目读为字符串（EPUB 多为 UTF-8，顺手去 BOM）。
fn read_zip_string(archive: &mut ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Result<String, String> {
    let mut f = archive
        .by_name(name)
        .map_err(|e| format!("读取 {} 失败：{}", name, e))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| format!("读取 {} 失败：{}", name, e))?;
    let s = String::from_utf8_lossy(&buf).into_owned();
    Ok(s.strip_prefix('\u{feff}').unwrap_or(&s).to_string())
}

/// 路径工具：取父目录（以 / 分隔）
fn parent_dir(p: &str) -> String {
    match p.rfind('/') {
        Some(i) => p[..i].to_string(),
        None => String::new(),
    }
}

/// 路径工具：拼接 base/rel
fn join_path(base: &str, rel: &str) -> String {
    if base.is_empty() {
        rel.to_string()
    } else {
        format!("{}/{}", base, rel)
    }
}

/// 路径工具：解析 . 与 .. 归一化
fn normalize_path(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        } else if seg == ".." {
            parts.pop();
        } else {
            parts.push(seg);
        }
    }
    parts.join("/")
}

/// 解析 container.xml，取出 OPF 的 full-path
fn parse_container_opf(xml: &str) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if tag == "rootfile" {
                    for a in e.attributes().flatten() {
                        let key = String::from_utf8_lossy(a.key.as_ref()).to_lowercase();
                        if key == "full-path" {
                            return Ok(String::from_utf8_lossy(&a.value).to_string());
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("解析 container.xml 失败：{}", e)),
            _ => {}
        }
        buf.clear();
    }
    Err("container.xml 中未找到 rootfile".to_string())
}

/// 解析 OPF：返回 (manifest[id] -> (href, media_type), spine 顺序的 idref 列表)
fn parse_opf(xml: &str) -> Result<(HashMap<String, (String, String)>, Vec<String>), String> {
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut manifest: HashMap<String, (String, String)> = HashMap::new();
    let mut spine: Vec<String> = Vec::new();
    let mut in_manifest = false;
    let mut in_spine = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if tag == "manifest" {
                    in_manifest = true;
                } else if tag == "spine" {
                    in_spine = true;
                } else if (in_manifest && tag == "item") || (in_spine && tag == "itemref") {
                    let mut id = String::new();
                    let mut href = String::new();
                    let mut mt = String::new();
                    for a in e.attributes().flatten() {
                        let key = String::from_utf8_lossy(a.key.as_ref()).to_lowercase();
                        let val = String::from_utf8_lossy(&a.value).to_string();
                        match key.as_str() {
                            "id" | "idref" => id = val,
                            "href" => href = val,
                            "media-type" => mt = val,
                            _ => {}
                        }
                    }
                    if in_manifest {
                        if !id.is_empty() && !href.is_empty() {
                            manifest.insert(id.clone(), (href, mt));
                        }
                    } else if in_spine && !id.is_empty() {
                        spine.push(id);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if tag == "manifest" {
                    in_manifest = false;
                } else if tag == "spine" {
                    in_spine = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("解析 OPF 失败：{}", e)),
            _ => {}
        }
        buf.clear();
    }
    Ok((manifest, spine))
}

/// 从章节 XHTML 提取标题：优先 <title>，其次首个 <h1>
fn extract_title(archive: &mut ZipArchive<Cursor<Vec<u8>>>, href: &str) -> Option<String> {
    let html = read_zip_string(archive, href).ok()?;
    for tag in ["title", "h1"] {
        if let Some(t) = extract_tag_text(&html, tag) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

/// 提取某个标签内的纯文本（剔除嵌套标签）
fn extract_tag_text(html: &str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let start = html.find(&open)?;
    let gt = html[start..].find('>')? + start;
    let close = format!("</{}>", tag);
    let close_pos = html[gt..].find(&close)? + gt;
    let inner = &html[gt + 1..close_pos];
    let mut out = String::new();
    let mut in_tag = false;
    for c in inner.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }
    Some(out.trim().to_string())
}

/// 取资源的内联 data URI MIME
fn data_mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "css" => "text/css",
        "js" => "application/javascript",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

/// 把单个本地引用（src/href）解析为 ZIP 内路径并内联成 data URI；非本地引用原样返回。
fn inline_one(archive: &mut ZipArchive<Cursor<Vec<u8>>>, val: &str, base_dir: &str) -> String {
    let v = val.trim();
    if v.is_empty()
        || v.starts_with("http://")
        || v.starts_with("https://")
        || v.starts_with("data:")
        || v.starts_with("mailto:")
        || v.starts_with("javascript:")
        || v.starts_with('#')
    {
        return val.to_string();
    }
    let resolved = normalize_path(&join_path(base_dir, v));
    if let Ok(mut f) = archive.by_name(&resolved) {
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_ok() {
            let mime = data_mime(&resolved);
            let b64 = base64_encode(&buf);
            return format!("data:{};base64,{}", mime, b64);
        }
    }
    val.to_string()
}

/// 扫描 HTML 中所有 src="..." / href="..." / xlink:href="..."，将本地资源内联为 data URI。
fn inline_resources(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    html: &str,
    base_dir: &str,
) -> Result<String, String> {
    let attrs = [
        "src=\"", "src='", "href=\"", "href='", "xlink:href=\"", "xlink:href='",
    ];
    let mut result = String::with_capacity(html.len() * 2);
    let mut start = 0;
    loop {
        let mut best: Option<(usize, &str, char)> = None;
        for a in attrs.iter() {
            if let Some(p) = html[start..].find(a) {
                let abs = start + p;
                if best.is_none() || abs < best.as_ref().unwrap().0 {
                    let q = a.chars().last().unwrap();
                    best = Some((abs, a, q));
                }
            }
        }
        let (abs, a, q) = match best {
            Some(v) => v,
            None => {
                result.push_str(&html[start..]);
                break;
            }
        };
        result.push_str(&html[start..abs]);
        let val_start = abs + a.len();
        let closing = html[val_start..]
            .find(q)
            .ok_or_else(|| format!("未闭合的属性：{}", a))?;
        let val_end = val_start + closing;
        let val = &html[val_start..val_end];
        let replacement = inline_one(archive, val, base_dir);
        result.push_str(a);
        result.push_str(&replacement);
        result.push(q);
        start = val_end + 1;
    }
    Ok(result)
}

/// 打开 EPUB：解析出章节目录（顺序 + 标题）。
#[tauri::command]
pub fn open_epub(path: String) -> Result<EpubMeta, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败：{}", e))?;
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("不是有效的 EPUB（ZIP）文件：{}", e))?;

    let container = read_zip_string(&mut archive, "META-INF/container.xml")?;
    let opf_path = parse_container_opf(&container)?;
    let opf_dir = parent_dir(&opf_path);
    let opf = read_zip_string(&mut archive, &opf_path)?;
    let (manifest, spine) = parse_opf(&opf)?;

    let mut chapters = Vec::new();
    for idref in spine {
        if let Some((href, mt)) = manifest.get(&idref) {
            let media = mt.to_lowercase();
            if media.contains("xhtml") || media.contains("svg+xml") {
                let norm_href = normalize_path(&join_path(&opf_dir, href));
                let title = extract_title(&mut archive, &norm_href)
                    .unwrap_or_else(|| format!("第 {} 章", chapters.len() + 1));
                chapters.push(EpubChapter {
                    id: idref,
                    title,
                    href: norm_href,
                });
            }
        }
    }
    if chapters.is_empty() {
        return Err("EPUB 中未找到可阅读的 XHTML 章节".to_string());
    }
    Ok(EpubMeta { chapters })
}

/// 取出某章节并内联资源，返回自包含 HTML 字符串。
#[tauri::command]
pub fn get_epub_chapter(path: String, href: String) -> Result<EpubChapterHtml, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败：{}", e))?;
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("不是有效的 EPUB（ZIP）文件：{}", e))?;
    let chapter_dir = parent_dir(&href);
    let chapter = read_zip_string(&mut archive, &href)?;
    let html = inline_resources(&mut archive, &chapter, &chapter_dir)?;
    Ok(EpubChapterHtml { html })
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

/// 列出目录下所有「受支持类型」的文件（返回全路径，按文件名自然排序）。
/// 用于顶部「上一个 / 下一个文件」导航。目录不存在 / 无权限时返回空列表（不报错）。
#[tauri::command]
pub fn list_supported_files(dir: String) -> Result<Vec<String>, String> {
    let dir_path = std::path::Path::new(&dir);
    let mut out: Vec<String> = Vec::new();
    let entries = match fs::read_dir(dir_path) {
        Ok(e) => e,
        Err(e) => return Err(format!("读取目录失败：{}", e)),
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let s = p.to_string_lossy().to_string();
        // 仅保留受支持类型（与打开路由保持一致）
        if crate::file_kind::detect_kind(&s).is_ok() {
            out.push(s);
        }
    }
    out.sort_by(|a, b| {
        let na = std::path::Path::new(a)
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or(a);
        let nb = std::path::Path::new(b)
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or(b);
        natural_cmp(na, nb)
    });
    Ok(out)
}

/// 自然排序比较：数字段按数值比较（file2 < file10），其余按字符比较。
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ia = a.chars().peekable();
    let mut ib = b.chars().peekable();
    while ia.peek().is_some() && ib.peek().is_some() {
        let ca = *ia.peek().unwrap();
        let cb = *ib.peek().unwrap();
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let mut sa = String::new();
            let mut sb = String::new();
            while let Some(&c) = ia.peek() {
                if c.is_ascii_digit() {
                    sa.push(c);
                    ia.next();
                } else {
                    break;
                }
            }
            while let Some(&c) = ib.peek() {
                if c.is_ascii_digit() {
                    sb.push(c);
                    ib.next();
                } else {
                    break;
                }
            }
            let va: u64 = sa.parse().unwrap_or(0);
            let vb: u64 = sb.parse().unwrap_or(0);
            if va != vb {
                return va.cmp(&vb);
            }
            if sa.len() != sb.len() {
                return sa.len().cmp(&sb.len());
            }
        } else {
            if ca != cb {
                return ca.cmp(&cb);
            }
            ia.next();
            ib.next();
        }
    }
    ia.count().cmp(&ib.count())
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

/// 「我的签章」库文件路径：与 exe 同目录下的 mojian_signatures.json。
/// 放到 exe 旁边便于随程序携带 / 备份；若该目录不可写（如安装到 Program Files 无权限），
/// 则由前端回落到 localStorage。
fn signatures_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("mojian_signatures.json"))
}

/// 读取「我的签章」库（JSON 文本）。文件不存在时返回空数组 "[]"。
#[tauri::command]
pub fn load_signatures() -> Result<String, String> {
    let path = signatures_path().ok_or_else(|| "无法确定签章库路径".to_string())?;
    if !path.exists() {
        return Ok(String::from("[]"));
    }
    fs::read_to_string(&path).map_err(|e| format!("读取签章库失败：{}", e))
}

/// 写入「我的签章」库（JSON 文本）。
/// 失败（如 exe 在受保护目录无写权限）返回错误，由前端回落到 localStorage。
#[tauri::command]
pub fn save_signatures(content: String) -> Result<(), String> {
    let path = signatures_path().ok_or_else(|| "无法确定签章库路径".to_string())?;
    fs::write(&path, content).map_err(|e| format!("写入签章库失败：{}", e))
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
    } else if lower.ends_with(".svg") {
        "image/svg+xml".to_string()
    } else if lower.ends_with(".pdf") {
        "application/pdf".to_string()
    } else if lower.ends_with(".epub") {
        "application/epub+zip".to_string()
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
            || lower.ends_with(".svg")
            || lower.ends_with(".pdf")
            || lower.ends_with(".epub");
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

/// 按传入的类型列表注册/取消注册文件关联（分色墨字图标）。
/// `types` 中出现的类型（md/html/pdf/svg）将被注册为墨笺默认打开程序；
/// 未出现的已知类型将被解除注册（仅清除本程序写入的注册表项）。
/// 写入 HKEY_CURRENT_USER\Software\Classes（普通用户权限即可，无需管理员提权）。
#[cfg(windows)]
#[tauri::command]
pub fn register_file_associations(app: tauri::AppHandle, types: Vec<String>) -> Result<String, String> {
    use tauri::Manager;
    use std::process::Command;

    // 定位图标目录：优先用 Tauri 资源目录；直接运行 release exe（未打包）时
    // resource_dir 可能解析不到，退回 exe 相对路径（target/release/../../icons = src-tauri/icons）。
    let mut icons: Option<std::path::PathBuf> = None;
    if let Ok(rd) = app.path().resource_dir() {
        let p = rd.join("icons");
        if p.exists() {
            icons = Some(p);
        }
    }
    if icons.is_none() {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                let fb = exe_dir.join("../../icons");
                if fb.exists() {
                    icons = Some(fb);
                }
            }
        }
    }
    let icons = match icons {
        Some(p) => p,
        None => return Err("找不到图标目录 src-tauri/icons，无法注册分色图标。".into()),
    };

    let all: &[(&str, &str, &str, &str)] = &[
        ("md",   "Mojian.Markdown", "墨笺 Markdown 文档", "icon-md.ico"),
        ("html", "Mojian.HTML",     "墨笺 HTML 文档",     "icon-html.ico"),
        ("pdf",  "Mojian.PDF",      "墨笺 PDF 文档",      "icon-pdf.ico"),
        ("svg",  "Mojian.SVG",      "墨笺 SVG 文档",      "icon-svg.ico"),
        ("epub",  "Mojian.EPUB",     "墨笺 EPUB 电子书",   "icon-epub.ico"),
    ];

    let exe = std::env::current_exe().map_err(|e| format!("无法获取 exe 路径: {e}"))?;
    let exe_quoted = format!("\"{}\" \"%1\"", exe.display());
    let base = "HKEY_CURRENT_USER\\Software\\Classes";

    let mut registered: Vec<&str> = Vec::new();
    let mut unregistered: Vec<&str> = Vec::new();

    for (ext, progid, desc, icon) in all {
        let want = types.iter().any(|t| t.eq_ignore_ascii_case(ext));
        let ext_key = format!("{base}\\.{ext}");
        let progid_key = format!("{base}\\{progid}");
        if want {
            let icon_path = icons.join(icon);
            if !icon_path.exists() {
                return Err(format!("图标文件缺失: {}", icon_path.display()));
            }
            let icon_str = format!("\"{}\"", icon_path.to_string_lossy().replace('/', "\\"));
            let default_icon_key = format!("{progid_key}\\DefaultIcon");
            let cmd_key = format!("{progid_key}\\shell\\open\\command");
            reg_set(&ext_key, None, progid)?;
            reg_set(&progid_key, None, desc)?;
            reg_set(&default_icon_key, None, &icon_str)?;
            reg_set(&cmd_key, None, &exe_quoted)?;
            registered.push(ext);
        } else {
            // 解除注册：仅删除本程序写入的 ProgID，以及指向它的 .ext 默认值
            reg_delete_key(&progid_key)?;
            if let Some(cur) = reg_get_default(&ext_key) {
                if cur == *progid {
                    let _ = reg_delete_value(&ext_key, None);
                }
            }
            unregistered.push(ext);
        }
    }

    // 温和刷新资源管理器图标缓存（部分系统无效则忽略）
    let _ = Command::new("ie4uinit").arg("-show").status();

    let reg_str = if registered.is_empty() { "（无）".to_string() } else { registered.join("、") };
    let unreg_str = if unregistered.is_empty() { "（无）".to_string() } else { unregistered.join("、") };
    Ok(format!(
        "已注册：{reg_str}；已解除：{unreg_str}。\n若资源管理器图标未立即更新，请重启资源管理器或重新登录。"
    ))
}

#[cfg(windows)]
fn reg_set(key: &str, value: Option<&str>, data: &str) -> Result<(), String> {
    let mut cmd = Command::new("reg");
    cmd.arg("add").arg(key).arg("/t").arg("REG_SZ").arg("/f");
    match value {
        Some(v) => {
            cmd.arg("/v").arg(v).arg("/d").arg(data);
        }
        None => {
            cmd.arg("/ve").arg("/d").arg(data);
        }
    }
    let out = cmd
        .output()
        .map_err(|e| format!("调用 reg 命令失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "reg add 失败 [{key}]: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

/// 返回当前已由本程序注册的文件类型（md/html/pdf/svg 子集）。
#[cfg(windows)]
#[tauri::command]
pub fn get_file_association_state() -> Result<Vec<String>, String> {
    let all: &[(&str, &str)] = &[
        ("md",   "Mojian.Markdown"),
        ("html", "Mojian.HTML"),
        ("pdf",  "Mojian.PDF"),
        ("svg",  "Mojian.SVG"),
        ("epub",  "Mojian.EPUB"),
    ];
    let base = "HKEY_CURRENT_USER\\Software\\Classes";
    let mut registered: Vec<String> = Vec::new();
    for (ext, progid) in all {
        let ext_key = format!("{base}\\.{ext}");
        if let Some(cur) = reg_get_default(&ext_key) {
            if cur == *progid {
                registered.push((*ext).to_string());
            }
        }
    }
    Ok(registered)
}

#[cfg(windows)]
fn reg_key_exists(key: &str) -> bool {
    // 仅看退出码，避免解析本地化（GBK 等）报错文本导致误判
    match std::process::Command::new("reg").arg("query").arg(key).output() {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn reg_value_exists(key: &str, value: Option<&str>) -> bool {
    let mut cmd = std::process::Command::new("reg");
    cmd.arg("query").arg(key);
    match value {
        Some(v) => { cmd.arg("/v").arg(v); }
        None => { cmd.arg("/ve"); }
    }
    match cmd.output() {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn reg_delete_key(key: &str) -> Result<(), String> {
    // 项不存在视为成功（解除注册本就幂等）；先 query 判存在，绕开本地化报错文本
    if !reg_key_exists(key) {
        return Ok(());
    }
    let out = std::process::Command::new("reg")
        .arg("delete")
        .arg(key)
        .arg("/f")
        .output()
        .map_err(|e| format!("调用 reg 命令失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "reg delete 失败 [{key}]: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn reg_delete_value(key: &str, value: Option<&str>) -> Result<(), String> {
    if !reg_value_exists(key, value) {
        return Ok(());
    }
    let mut cmd = std::process::Command::new("reg");
    cmd.arg("delete").arg(key).arg("/f");
    match value {
        Some(v) => { cmd.arg("/v").arg(v); }
        None => { cmd.arg("/ve"); }
    }
    let out = cmd
        .output()
        .map_err(|e| format!("调用 reg 命令失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "reg delete value 失败 [{key}]: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn reg_get_default(key: &str) -> Option<String> {
    let out = std::process::Command::new("reg")
        .arg("query")
        .arg(key)
        .arg("/ve")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for line in s.lines() {
        if let Some(idx) = line.find("REG_SZ") {
            return Some(line[idx + 6..].trim().to_string());
        }
    }
    None
}

#[cfg(not(windows))]
#[tauri::command]
pub fn register_file_associations(_app: tauri::AppHandle, _types: Vec<String>) -> Result<String, String> {
    Err("文件关联注册目前仅支持 Windows。".into())
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_file_association_state() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
