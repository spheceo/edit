//! Notifications on a Mac (the server's notices.ts decides when: a draft or a
//! revision done while Edit isn't in front). They come on the long poll the
//! window already makes (`GET /api/window/next`) and are posted in
//! Notification Center as Edit's own; a click brings the window forward on
//! the notice's page (the page hears `edit:open`, apps/web/src/lib/notices.ts).
//!
//! Only Edit.app has a bundle for macOS to post as: the window `edit app`
//! starts (`<home>/bin/Edit`, a bare program) says it through AppleScript
//! instead, which can't open the page.

use std::process::Command;
use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Manager};

use crate::Notice;

/// The app, for a click to bring its window forward.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Whether this program is Edit.app's, which macOS posts notifications for
/// (asking for a bare program's notification center throws).
fn bundled() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this has no Drop.
    #[unsafe(super = NSObject)]
    #[name = "EditNoticeDelegate"]
    struct Delegate;

    // SAFETY: NSObjectProtocol has no safety requirements.
    unsafe impl NSObjectProtocol for Delegate {}

    // SAFETY: the methods' signatures are the protocol's.
    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // A notice that lands as Edit comes forward still shows.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            if let Some(path) = path_of(&id) {
                open(path);
            }
            handler.call(());
        }
    }
);

impl Delegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: NSObject's init.
        unsafe { msg_send![super(this), init] }
    }
}

/// A notice's identifier: its key, then the page a click opens.
fn identifier(notice: &Notice) -> String {
    format!("{}|{}", notice.key.replace('|', "/"), notice.path)
}

/// The page in an identifier made by `identifier`.
fn path_of(identifier: &str) -> Option<&str> {
    identifier
        .split_once('|')
        .map(|(_, path)| path)
        .filter(|path| path.starts_with('/'))
}

/// Brings the window forward on `path`.
fn open(path: &str) {
    let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let Ok(detail) = serde_json::to_string(path) else {
        return;
    };
    let _ = window.eval(format!(
        "window.dispatchEvent(new CustomEvent('edit:open', {{ detail: {detail} }}))"
    ));
}

/// Gets ready to post: a click is handled, and macOS asks the person once
/// whether Edit may notify them (the first time Edit.app opens).
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if !bundled() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let delegate = Delegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center keeps its delegate weakly: this one lives as long as the app.
    std::mem::forget(delegate);
    let answered = RcBlock::new(|granted: Bool, _error: *mut NSError| {
        if !granted.as_bool() {
            eprintln!(
                "edit: notifications aren't allowed for Edit (System Settings → Notifications)"
            );
        }
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &answered,
    );
}

/// Posts `notice` in Notification Center.
pub fn post(notice: &Notice) {
    if !bundled() {
        say_by_applescript(notice);
        return;
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&notice.title));
    content.setBody(&NSString::from_str(&notice.body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&identifier(notice)),
        &content,
        None,
    );
    let posted = RcBlock::new(|error: *mut NSError| {
        // SAFETY: the error macOS hands the handler is null or a live NSError for its duration.
        if let Some(error) = unsafe { error.as_ref() } {
            eprintln!(
                "edit: macOS didn't post a notification: {}",
                error.localizedDescription()
            );
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&posted));
}

/// AppleScript's string for `text`.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

fn say_by_applescript(notice: &Notice) {
    let script = format!(
        "display notification {} with title {} sound name \"default\"",
        quoted(&notice.body),
        quoted(&notice.title)
    );
    let _ = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::{identifier, path_of, quoted};
    use crate::Notice;

    #[test]
    fn a_click_finds_the_page_in_the_identifier() {
        let notice = Notice {
            key: "script:a|b:1".into(),
            title: "First draft is ready".into(),
            body: "Mom Leaves 5 Kids".into(),
            path: "/scripts/abc".into(),
        };
        assert_eq!(path_of(&identifier(&notice)), Some("/scripts/abc"));
        assert_eq!(path_of("nothing"), None);
        assert_eq!(quoted("say \"hi\" \\"), "\"say \\\"hi\\\" \\\\\"");
    }
}
