p = 'src-tauri/src/commands.rs'
lines = open(p, encoding='utf-8').read().split('\n')
out = []
for ln in lines:
    out.append(ln)
    if '("epub",  "Mojian.EPUB",' in ln and 'icon-epub.ico' in ln:
        out.append('        ("json", "Mojian.JSON",      "墨笺 JSON 文档",      "icon-json.ico"),')
    elif '("epub",  "Mojian.EPUB"),' in ln:
        out.append('        ("json",  "Mojian.JSON"),')
    elif '"epub" => "Mojian.EPUB",' in ln:
        out.append('            "json" => "Mojian.JSON",')
    elif '"woff2" => "font/woff2",' in ln:
        out.append('        "json" => "application/json",')
open(p, 'w', encoding='utf-8').write('\n'.join(out))
print('patched')
