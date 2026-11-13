//! 文本文件编解码：保真读写的核心。
//!
//! 解决的问题（纯文本 / CSV / 日志等尤其敏感）：
//! 1. **编码不往返**：打开时读出实际编码，保存时按同一编码写回，GBK 不会被悄悄改成 UTF-8；
//!    支持 UTF-8 / GBK / UTF-16 LE / UTF-16 BE，含 BOM 识别与还原。
//! 2. **CRLF 被吞**：HTML `<textarea>` 会把 CRLF 规范化成 LF，故打开时统一归一成 LF、
//!    保存时按「主行尾」还原成 CRLF / CR / LF。
//! 3. **二进制误判**：采样检查 NUL 与控制字符比例，未知后缀还要求 GBK 解码无明显错误，
//!    否则明确报错，避免把 .exe / .png 解成乱码后还允许保存。

use std::fs;
use std::io::Read;

/// 解码结果：文本 + 原文件格式元数据（保存时原样回传）
pub struct DecodedText {
    pub content: String,
    pub encoding: String,
    pub bom: String,
    pub line_ending: String,
}

/// 解码文件字节。`strict_binary=true` 用于未知后缀（只读通道），额外要求 GBK 解码无错误。
pub fn decode(bytes: &[u8], hint: Option<&str>, strict_binary: bool) -> Result<DecodedText, String> {
    // 1) BOM 优先（UTF-16 正文天然含大量 0x00，必须先识别再决定要不要做二进制嗅探）
    let (body, bom, bom_enc): (&[u8], &str, Option<&str>) =
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            (&bytes[3..], "utf-8", Some("utf-8"))
        } else if bytes.starts_with(&[0xFF, 0xFE]) {
            (&bytes[2..], "utf-16le", Some("utf-16le"))
        } else if bytes.starts_with(&[0xFE, 0xFF]) {
            (&bytes[2..], "utf-16be", Some("utf-16be"))
        } else {
            (bytes, "", None)
        };

    // 2) 二进制防护：UTF-16 不做 NUL 检查；其余一律采样检查
    let is_utf16 = matches!(bom_enc, Some("utf-16le") | Some("utf-16be"));
    if !is_utf16 {
        let sample = &body[..body.len().min(8192)];
        if looks_binary(sample) {
            return Err("这不是文本文件（检测到二进制数据），已拒绝打开以防损坏文件".to_string());
        }
    }

    // 3) 解码
    let hint_lc = hint.map(|s| s.to_ascii_lowercase());
    let (text, encoding): (String, String) = if let Some(be) = bom_enc {
        // BOM 优先级最高，覆盖下拉的手动选择
        let s = match be {
            "utf-16le" => decode_utf16(body, true)?,
            "utf-16be" => decode_utf16(body, false)?,
            _ => String::from_utf8(body.to_vec())
                .map_err(|e| format!("UTF-8 解码失败：{}", e))?,
        };
        (s, be.to_string())
    } else {
        match hint_lc.as_deref() {
            Some("gbk") | Some("gb2312") => {
                (encoding_rs::GBK.decode(body).0.into_owned(), "gbk".to_string())
            }
            Some("utf-16le") => (decode_utf16(body, true)?, "utf-16le".to_string()),
            Some("utf-16be") => (decode_utf16(body, false)?, "utf-16be".to_string()),
            Some("utf-8") | Some("utf8") => (
                String::from_utf8(body.to_vec())
                    .map_err(|e| format!("UTF-8 解码失败：{}", e))?,
                "utf-8".to_string(),
            ),
            _ => match String::from_utf8(body.to_vec()) {
                Ok(s) => (s, "utf-8".to_string()),
                Err(_) => {
                    let (cow, _, had_errors) = encoding_rs::GBK.decode(body);
                    // 未知后缀（只读通道）：GBK 解码有明显错误就判定为二进制
                    if strict_binary && had_errors {
                        return Err("无法识别为文本（编码解码失败），已拒绝打开".to_string());
                    }
                    (cow.into_owned(), "gbk".to_string())
                }
            },
        }
    };

    // 4) 行尾归一 + 记录主行尾
    let (line_ending, content) = normalize_line_endings(&text);
    Ok(DecodedText {
        content,
        encoding,
        bom: bom.to_string(),
        line_ending,
    })
}

/// 保存侧：按前端回传的格式元数据把文本还原成字节。
/// `bom` 与 `encoding` 不一致时不补 BOM（避免「UTF-8 BOM + GBK 正文」）。
pub fn encode_save(
    content: &str,
    encoding: Option<&str>,
    bom: Option<&str>,
    line_ending: Option<&str>,
) -> Result<Vec<u8>, String> {
    let enc = encoding.filter(|s| !s.is_empty()).unwrap_or("utf-8");
    let le = line_ending.unwrap_or("lf");
    let text = restore_line_endings(content, le);
    let mut bytes = encode_text(&text, enc)?;
    let bom_valid = matches!(
        (enc, bom),
        ("utf-8", Some("utf-8"))
            | ("utf-16le", Some("utf-16le"))
            | ("utf-16be", Some("utf-16be"))
    );
    if bom_valid {
        if let Some(b) = bom {
            bytes = prepend_bom(bytes, b);
        }
    }
    Ok(bytes)
}

/// 采样判断是否二进制：NUL 字节 / 高比例控制字符。
fn looks_binary(sample: &[u8]) -> bool {
    if sample.is_empty() {
        return false; // 空文件当文本处理
    }
    if sample.iter().any(|&b| b == 0) {
        return true;
    }
    let bad = sample
        .iter()
        .filter(|&&b| b < 0x20 && b != b'\t' && b != b'\n' && b != b'\r' && b != 0x0C)
        .count();
    (bad as f64 / sample.len() as f64) > 0.02
}

fn decode_utf16(body: &[u8], little: bool) -> Result<String, String> {
    if body.len() % 2 != 0 {
        return Err("UTF-16 数据长度不是偶数".to_string());
    }
    let units: Vec<u16> = body
        .chunks_exact(2)
        .map(|c| {
            if little {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        })
        .collect();
    String::from_utf16(&units).map_err(|e| format!("UTF-16 解码失败：{}", e))
}

fn encode_text(s: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding.to_ascii_lowercase().as_str() {
        "gbk" | "gb2312" => Ok(encoding_rs::GBK.encode(s).0.into_owned()),
        "utf-16le" => Ok(utf16_bytes(s, true)),
        "utf-16be" => Ok(utf16_bytes(s, false)),
        _ => Ok(s.as_bytes().to_vec()),
    }
}

fn utf16_bytes(s: &str, little: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 2 + 2);
    for u in s.encode_utf16() {
        let pair = if little { u.to_le_bytes() } else { u.to_be_bytes() };
        out.push(pair[0]);
        out.push(pair[1]);
    }
    out
}

fn prepend_bom(mut bytes: Vec<u8>, bom: &str) -> Vec<u8> {
    let prefix: &[u8] = match bom {
        "utf-8" => &[0xEF, 0xBB, 0xBF],
        "utf-16le" => &[0xFF, 0xFE],
        "utf-16be" => &[0xFE, 0xFF],
        _ => return bytes,
    };
    let mut out = Vec::with_capacity(prefix.len() + bytes.len());
    out.extend_from_slice(prefix);
    out.append(&mut bytes);
    out
}

/// 统计主行尾并把全部行尾归一成 LF。
fn normalize_line_endings(s: &str) -> (String, String) {
    let b = s.as_bytes();
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'\r' {
            if i + 1 < b.len() && b[i + 1] == b'\n' {
                crlf += 1;
                i += 2;
                continue;
            }
            cr += 1;
        } else if b[i] == b'\n' {
            lf += 1;
        }
        i += 1;
    }
    let le = if crlf > 0 && crlf >= lf && crlf >= cr {
        "crlf"
    } else if cr > 0 && cr > lf && cr > crlf {
        "cr"
    } else {
        "lf"
    };
    (
        le.to_string(),
        s.replace("\r\n", "\n").replace('\r', "\n"),
    )
}

/// 保存时按主行尾还原（先把可能的 CRLF 归一，保证幂等，不会写出 CRCRLF）。
fn restore_line_endings(s: &str, le: &str) -> String {
    let flat = s.replace("\r\n", "\n").replace('\r', "\n");
    match le {
        "crlf" => flat.replace('\n', "\r\n"),
        "cr" => flat.replace('\n', "\r"),
        _ => flat,
    }
}

/// 读取文件头部做轻量文本嗅探（供启动参数 get_initial_file 使用，不在此做全量解码）。
pub fn file_head_is_text(path: &str) -> bool {
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut buf = vec![0u8; 8192];
    let n = f.read(&mut buf).unwrap_or(0);
    buf.truncate(n);
    // UTF-16 BOM 的正文含大量 0x00，直接放行；真正的解码校验交给 decode()
    if buf.starts_with(&[0xFF, 0xFE]) || buf.starts_with(&[0xFE, 0xFF]) {
        return true;
    }
    !looks_binary(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 走一遍「解码 → (前端 textarea) → 保存编码」，断言字节完全一致。
    fn roundtrip(bytes: &[u8], hint: Option<&str>, strict: bool) {
        let d = decode(bytes, hint, strict).expect("decode failed");
        let out = encode_save(
            &d.content,
            Some(&d.encoding),
            Some(&d.bom),
            Some(&d.line_ending),
        )
        .expect("encode failed");
        assert_eq!(out, bytes, "encoding={} bom={} le={}", d.encoding, d.bom, d.line_ending);
    }

    fn gbk(s: &str) -> Vec<u8> {
        encoding_rs::GBK.encode(s).0.into_owned()
    }

    fn utf8_bom(s: &str) -> Vec<u8> {
        let mut v = vec![0xEF, 0xBB, 0xBF];
        v.extend_from_slice(s.as_bytes());
        v
    }

    fn utf16_bom(s: &str, little: bool) -> Vec<u8> {
        let mut v: Vec<u8> = if little { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
        for u in s.encode_utf16() {
            let p = if little { u.to_le_bytes() } else { u.to_be_bytes() };
            v.push(p[0]);
            v.push(p[1]);
        }
        v
    }

    #[test]
    fn utf8_bom_crlf_roundtrip() {
        roundtrip(&utf8_bom("第一行\r\n第二行\r\n"), None, false);
    }

    #[test]
    fn utf8_plain_lf_roundtrip() {
        roundtrip(b"a\nb\nc\n", None, false);
    }

    #[test]
    fn utf8_cr_only_roundtrip() {
        roundtrip(b"a\rb\rc\r", None, false);
    }

    #[test]
    fn gbk_crlf_roundtrip() {
        roundtrip(&gbk("中文内容\r\n第二行\r\n"), None, false);
    }

    #[test]
    fn gbk_forced_hint_roundtrip() {
        roundtrip(&gbk("上海 临床数据\n"), Some("gbk"), false);
    }

    #[test]
    fn utf16le_bom_roundtrip() {
        roundtrip(&utf16_bom("中文\r\n第二行\r\n", true), None, false);
    }

    #[test]
    fn utf16be_bom_roundtrip() {
        roundtrip(&utf16_bom("中文\n第二行\n", false), None, false);
    }

    #[test]
    fn empty_file_is_text() {
        let d = decode(b"", None, true).unwrap();
        assert_eq!(d.content, "");
        assert_eq!(d.encoding, "utf-8");
        assert_eq!(d.line_ending, "lf");
    }

    #[test]
    fn nul_byte_rejected() {
        let mut v = b"hello ".to_vec();
        v.push(0);
        v.extend_from_slice(b"world");
        assert!(decode(&v, None, false).is_err(), "NUL 字节必须判为二进制");
    }

    #[test]
    fn control_char_flood_rejected() {
        let v: Vec<u8> = (0..200).map(|i| if i % 4 == 0 { 0x01 } else { b'A' }).collect();
        assert!(decode(&v, None, false).is_err(), "高比例控制字符必须判为二进制");
    }

    #[test]
    fn executable_like_bytes_rejected_in_strict_mode() {
        // 典型 PE 头：含 NUL，第一道就该拦住
        let mut v = b"MZ".to_vec();
        v.extend_from_slice(&[0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
        assert!(decode(&v, None, true).is_err());
    }

    #[test]
    fn bom_encoding_mismatch_drops_bom() {
        let out = encode_save("abc", Some("gbk"), Some("utf-8"), Some("lf")).unwrap();
        assert!(!out.starts_with(&[0xEF, 0xBB, 0xBF]), "编码改成 GBK 后不该保留 UTF-8 BOM");
        assert_eq!(out, gbk("abc"));
    }

    #[test]
    fn mixed_line_endings_never_double_cr() {
        let d = decode(b"a\r\nb\nc\r\n", None, false).unwrap();
        assert_eq!(d.line_ending, "crlf");
        let out = encode_save(&d.content, Some(&d.encoding), Some(&d.bom), Some(&d.line_ending)).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert_eq!(s, "a\r\nb\r\nc\r\n");
        assert!(!s.contains("\r\r"), "不能产生 CRCRLF");
    }

    #[test]
    fn textarea_simulation_keeps_content() {
        // 模拟 textarea 的换行规范化：把归一化后的内容再走一遍保存
        let src = utf8_bom("第一\r\n第二\r\n");
        let d = decode(&src, None, false).unwrap();
        let textarea_value = d.content.replace("\r\n", "\n"); // 浏览器行为
        assert_eq!(textarea_value, d.content);
        let out = encode_save(&textarea_value, Some(&d.encoding), Some(&d.bom), Some(&d.line_ending)).unwrap();
        assert_eq!(out, src);
    }
}
