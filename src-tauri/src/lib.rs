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
            commands::register_file_associations,
            commands::get_file_association_state,
            commands::open_epub,
            commands::get_epub_chapter,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
