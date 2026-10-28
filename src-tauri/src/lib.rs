mod commands;
mod file_kind;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::save_file,
            commands::read_image_base64,
            commands::read_file_base64,
            commands::save_file_bytes,
            commands::save_files_bytes,
            commands::get_app_version,
            commands::open_containing_folder,
            commands::list_supported_files,
            commands::read_config,
            commands::write_config,
            commands::load_signatures,
            commands::save_signatures,
            commands::get_initial_file,
            commands::open_new_instance,
            commands::register_file_associations,
            commands::get_file_association_state,
            commands::open_epub,
            commands::get_epub_chapter,
        ])
        .setup(|app| {
            // 启动窗口：按「屏幕黄金分割」定尺寸并居中，隐藏态一步到位再显示，杜绝闪动，
            // 且窗口显示不再依赖前端 JS（否则 webview 任一初始化异常都会让窗口停在隐藏态，
            // 表现为「双击 exe 打不开」）。窗口在 tauri.conf.json 设为 visible:false。
            if let Some(win) = app.get_webview_window("main") {
                // 取主显示器（Result<Option<Monitor>>）；取不到则退而求其次取窗口所在显示器
                let monitor = app.primary_monitor().ok().flatten()
                    .or_else(|| win.current_monitor().ok().flatten());
                if let Some(monitor) = monitor {
                    let scale = monitor.scale_factor(); // 例如 150% 缩放 → 1.5
                    let screen_w = monitor.size().width as f64 / scale; // 逻辑像素宽
                    let screen_h = monitor.size().height as f64 / scale; // 逻辑像素高
                    let phi = 1.6180339887_f64;
                    // 窗口高 = 屏高黄金分割、窗口宽 = 屏宽黄金分割（逻辑像素）
                    let gw = (screen_w / phi).round().max(200.0) as u32;
                    let gh = (screen_h / phi).round().max(150.0) as u32;
                    let _ = win.set_size(tauri::LogicalSize::new(gw, gh));
                    let _ = win.center();
                }
                // 无论上面是否成功，都必须显示窗口，避免「双击 exe 打不开」
                let _ = win.show();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
