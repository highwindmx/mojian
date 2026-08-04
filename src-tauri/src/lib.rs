mod commands;
mod file_kind;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::open_file,
            commands::save_file,
            commands::read_image_base64,
            commands::get_app_version,
            commands::open_containing_folder,
            commands::read_config,
            commands::write_config,
            commands::get_initial_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
