#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod actions;
mod ai_provider;
#[cfg(windows)]
mod automatic_memory;
mod capture;
mod capture_backend;
mod change_detection;
mod commands;
mod error;
mod frame_optimizer;
mod jev;
mod laya;
mod memory_commands;
mod observer;
mod perception;
mod persistent_memory;
mod platform;
#[cfg(windows)]
mod promoted_keyframes;
#[cfg(windows)]
mod recent_gpu_cache;
mod routing;
mod session;
mod temporal_memory;
mod visual_analysis;
mod visual_context;
mod visual_events;
mod visual_preparation;
mod voice;

fn main() {
    if let Err(error) = tauri::Builder::default()
        .manage(commands::AppState::default())
        .setup(|app| {
            use tauri::Manager;
            let memory_root = app
                .path()
                .app_local_data_dir()
                .ok()
                .and_then(memory_commands::storage_root);
            app.manage(memory_commands::MemoryState::new(memory_root));
            app.manage(ai_provider::ProviderState::new(
                app.path()
                    .app_local_data_dir()
                    .ok()
                    .and_then(ai_provider::storage_root),
            ));
            #[cfg(windows)]
            app.state::<memory_commands::MemoryState>()
                .start_automatic(&app.state::<commands::AppState>());
            commands::start_observer(app.state::<commands::AppState>().0.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            actions::actions_configure,
            actions::actions_begin,
            actions::actions_cancel,
            actions::actions_classify,
            actions::actions_confirm,
            actions::actions_reject,
            actions::actions_status,
            ai_provider::ai_profiles_list,
            ai_provider::ai_profile_save,
            ai_provider::ai_profile_delete,
            ai_provider::ai_profile_has_key,
            ai_provider::ai_profile_save_key,
            ai_provider::ai_profile_delete_key,
            ai_provider::transport::ai_complete,
            ai_provider::transport::ai_transcribe,
            ai_provider::transport::ai_synthesize,
            ai_provider::ai_cancel,
            ai_provider::ai_provider_diagnostics,
            memory_commands::memory_status,
            memory_commands::memory_configure,
            memory_commands::memory_search,
            memory_commands::memory_get,
            memory_commands::memory_bookmark,
            memory_commands::memory_delete,
            memory_commands::memory_delete_range,
            memory_commands::memory_clear,
            memory_commands::memory_asset,
            memory_commands::memory_remember,
            laya::laya_start,
            laya::laya_status,
            laya::laya_unload,
            laya::laya_begin,
            laya::laya_cancel,
            laya::laya_decide,
            jev::jev_status,
            jev::jev_save_key,
            jev::jev_delete_key,
            visual_context::visual_context_availability,
            visual_context::visual_context_begin_turn,
            visual_context::visual_context_mark_turn,
            visual_context::visual_context_cancel,
            visual_context::visual_context_note_delivery,
            visual_context::visual_context_complete_turn,
            visual_context::visual_context_follow_up,
            visual_context::visual_context_request,
            visual_context::visual_context_validate,
            visual_context::visual_context_diagnostics,
            capture_backend::capture_backend_select,
            capture_backend::capture_backend_status,
            capture_backend::perception_configure,
            capture_backend::capture_wgc_test_frame,
            capture_backend::temporal_sample_preview,
            capture_backend::recent_gpu_preview,
            capture_backend::recent_gpu_correlate,
            capture_backend::promoted_keyframe_preview,
            commands::start_session,
            commands::stop_session,
            commands::capture_screen,
            commands::observer_snapshot,
            commands::configure_observer,
            commands::set_ai_visual_access,
            commands::detection_config,
            voice::save_voice_key,
            voice::has_voice_key,
            voice::delete_voice_key,
            voice::voice_credential
        ])
        .build(tauri::generate_context!())
        .map(|app| {
            app.run(|handle, event| {
                if matches!(event, tauri::RunEvent::Exit) {
                    use tauri::Manager;
                    let memory = handle.state::<memory_commands::MemoryState>();
                    memory.shutdown();
                    handle.state::<ai_provider::ProviderState>().shutdown();
                    handle.state::<commands::AppState>().3.unload();
                    handle.state::<commands::AppState>().4.cancel(None);
                }
            })
        })
    {
        eprintln!("Application failed: {error}");
        std::process::exit(1);
    }
}
