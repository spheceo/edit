#[derive(Clone, Copy)]
#[cfg_attr(test, allow(dead_code))]
pub enum NativeMenuAction {
    NewProject,
    CloseProject,
    Import,
    Export,
    Undo,
    Redo,
    ZoomIn,
    ZoomOut,
    ResetZoom,
}

#[cfg(all(not(test), any(target_os = "macos", target_os = "windows")))]
mod platform {
    use muda::{
        accelerator::{Accelerator, Code, CMD_OR_CTRL},
        AboutMetadata, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu,
    };

    use super::NativeMenuAction;

    pub struct NativeMenu {
        _menu: Menu,
        new_project: MenuItem,
        close_project: MenuItem,
        import: MenuItem,
        export: MenuItem,
        undo: MenuItem,
        redo: MenuItem,
        zoom_in: MenuItem,
        zoom_out: MenuItem,
        reset_zoom: MenuItem,
        enabled_state: Option<[bool; 6]>,
        #[cfg(target_os = "windows")]
        attached: bool,
    }

    impl NativeMenu {
        pub fn new() -> Self {
            let new_project = item("New Project…", Code::KeyN);
            let close_project = MenuItem::new("Close Project", false, None);
            let import = item("Import Video…", Code::KeyI);
            let export = item("Export…", Code::KeyE);
            let undo = item("Undo", Code::KeyZ);
            let redo = MenuItem::new(
                "Redo",
                false,
                Some(Accelerator::new(
                    Some(CMD_OR_CTRL | muda::accelerator::Modifiers::SHIFT),
                    Code::KeyZ,
                )),
            );
            let zoom_in = item("Zoom In", Code::Equal);
            let zoom_out = item("Zoom Out", Code::Minus);
            let reset_zoom = item("Actual Size", Code::Digit0);

            let file = Submenu::with_items(
                "File",
                true,
                &[
                    &new_project,
                    &PredefinedMenuItem::separator(),
                    &import,
                    &export,
                    &PredefinedMenuItem::separator(),
                    &close_project,
                    &PredefinedMenuItem::separator(),
                    &PredefinedMenuItem::close_window(None),
                ],
            )
            .expect("native File menu should be created");
            let edit = Submenu::with_items(
                "Edit",
                true,
                &[
                    &undo,
                    &redo,
                    &PredefinedMenuItem::separator(),
                    &PredefinedMenuItem::cut(None),
                    &PredefinedMenuItem::copy(None),
                    &PredefinedMenuItem::paste(None),
                    &PredefinedMenuItem::select_all(None),
                ],
            )
            .expect("native Edit menu should be created");
            let view = Submenu::with_items(
                "View",
                true,
                &[
                    &zoom_in,
                    &zoom_out,
                    &reset_zoom,
                    &PredefinedMenuItem::fullscreen(None),
                ],
            )
            .expect("native View menu should be created");
            let window = Submenu::with_items(
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(None),
                    &PredefinedMenuItem::maximize(None),
                    &PredefinedMenuItem::bring_all_to_front(None),
                ],
            )
            .expect("native Window menu should be created");
            #[cfg(target_os = "macos")]
            window.set_as_windows_menu_for_nsapp();

            let about = AboutMetadata {
                name: Some("Kuro".to_owned()),
                version: Some(env!("CARGO_PKG_VERSION").to_owned()),
                comments: Some("A precise, local video editor".to_owned()),
                ..Default::default()
            };
            let help = Submenu::with_items(
                "Help",
                true,
                &[&PredefinedMenuItem::about(
                    Some("About Kuro"),
                    Some(about.clone()),
                )],
            )
            .expect("native Help menu should be created");

            let menu = Menu::new();
            #[cfg(target_os = "macos")]
            {
                let app = Submenu::with_items(
                    "Kuro",
                    true,
                    &[
                        &PredefinedMenuItem::about(Some("About Kuro"), Some(about)),
                        &PredefinedMenuItem::separator(),
                        &PredefinedMenuItem::services(None),
                        &PredefinedMenuItem::separator(),
                        &PredefinedMenuItem::hide(None),
                        &PredefinedMenuItem::hide_others(None),
                        &PredefinedMenuItem::show_all(None),
                        &PredefinedMenuItem::separator(),
                        &PredefinedMenuItem::quit(None),
                    ],
                )
                .expect("native application menu should be created");
                menu.append(&app)
                    .expect("application menu should be installed");
            }
            for submenu in [&file, &edit, &view, &window, &help] {
                menu.append(submenu)
                    .expect("native menu should be installed");
            }
            #[cfg(target_os = "macos")]
            menu.init_for_nsapp();

            new_project.set_enabled(true);

            Self {
                _menu: menu,
                new_project,
                close_project,
                import,
                export,
                undo,
                redo,
                zoom_in,
                zoom_out,
                reset_zoom,
                enabled_state: None,
                #[cfg(target_os = "windows")]
                attached: false,
            }
        }

        #[cfg(target_os = "windows")]
        pub fn attach_to_window(&mut self, frame: &eframe::Frame) {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            if self.attached {
                return;
            }
            let Ok(handle) = frame.window_handle() else {
                return;
            };
            let RawWindowHandle::Win32(handle) = handle.as_raw() else {
                return;
            };
            let hwnd = handle.hwnd.get();
            if unsafe {
                self._menu
                    .init_for_hwnd_with_theme(hwnd, muda::MenuTheme::Dark)
            }
            .is_ok()
            {
                self.attached = true;
            }
        }

        #[cfg(target_os = "macos")]
        pub fn attach_to_window(&mut self, _frame: &eframe::Frame) {}

        pub fn update_enabled(
            &mut self,
            workspace_open: bool,
            can_export: bool,
            can_undo: bool,
            can_redo: bool,
            can_zoom: bool,
        ) {
            let state = [
                workspace_open,
                can_export,
                can_undo,
                can_redo,
                can_zoom,
                true,
            ];
            if self.enabled_state == Some(state) {
                return;
            }
            self.enabled_state = Some(state);
            self.new_project.set_enabled(true);
            self.close_project.set_enabled(workspace_open);
            self.import.set_enabled(workspace_open);
            self.export.set_enabled(can_export);
            self.undo.set_enabled(can_undo);
            self.redo.set_enabled(can_redo);
            self.zoom_in.set_enabled(can_zoom);
            self.zoom_out.set_enabled(can_zoom);
            self.reset_zoom.set_enabled(can_zoom);
        }

        pub fn poll(&self) -> Option<NativeMenuAction> {
            let event = MenuEvent::receiver().try_recv().ok()?;
            match_id(&event.id, &self.new_project, NativeMenuAction::NewProject)
                .or_else(|| match_id(&event.id, &self.close_project, NativeMenuAction::CloseProject))
                .or_else(|| match_id(&event.id, &self.import, NativeMenuAction::Import))
                .or_else(|| match_id(&event.id, &self.export, NativeMenuAction::Export))
                .or_else(|| match_id(&event.id, &self.undo, NativeMenuAction::Undo))
                .or_else(|| match_id(&event.id, &self.redo, NativeMenuAction::Redo))
                .or_else(|| match_id(&event.id, &self.zoom_in, NativeMenuAction::ZoomIn))
                .or_else(|| match_id(&event.id, &self.zoom_out, NativeMenuAction::ZoomOut))
                .or_else(|| match_id(&event.id, &self.reset_zoom, NativeMenuAction::ResetZoom))
        }
    }

    fn item(label: &str, code: Code) -> MenuItem {
        MenuItem::new(
            label,
            false,
            Some(Accelerator::new(Some(CMD_OR_CTRL), code)),
        )
    }

    fn match_id(
        event: &MenuId,
        item: &MenuItem,
        action: NativeMenuAction,
    ) -> Option<NativeMenuAction> {
        (event == item.id()).then_some(action)
    }
}

#[cfg(all(not(test), any(target_os = "macos", target_os = "windows")))]
pub use platform::NativeMenu;

#[cfg(any(test, not(any(target_os = "macos", target_os = "windows"))))]
pub struct NativeMenu;

#[cfg(any(test, not(any(target_os = "macos", target_os = "windows"))))]
impl NativeMenu {
    pub fn new() -> Self {
        Self
    }
    pub fn attach_to_window(&mut self, _frame: &eframe::Frame) {}
    pub fn update_enabled(&mut self, _: bool, _: bool, _: bool, _: bool, _: bool) {}
    pub fn poll(&self) -> Option<NativeMenuAction> {
        None
    }
}
