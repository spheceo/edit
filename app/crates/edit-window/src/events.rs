//! An exception thrown while macOS hands the window an event is caught and
//! the window carries on, as any Mac app does, instead of the whole app
//! aborting.
//!
//! Nightly-51 crashed on Sphe's Mac (macOS 27, Nov 3) on Escape in the note
//! box: AppKit or WebKit threw an Objective-C exception while handling the
//! key. `-[NSApplication run]` would have caught and logged it, but tao's
//! `sendEvent:` override (a Rust `extern "C"` fn, which can't be unwound
//! through) sits between, so Rust aborted the app (`abort() called`, nothing
//! but tao's frames under `-[NSApplication _handleEvent:]`). tao calls
//! NSApplication's own `sendEvent:` as `super`; that's swapped here for one
//! that runs the original inside `@try`, so the exception stops below tao.

use std::panic::AssertUnwindSafe;
use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;

type SendEvent = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

/// AppKit's own `-[NSApplication sendEvent:]`.
static ORIGINAL: OnceLock<SendEvent> = OnceLock::new();

/// Guards every event from here on. Call on the main thread before the event
/// loop runs; calling it again does nothing.
pub fn guard() {
    if ORIGINAL.get().is_some() {
        return;
    }
    let Some(class) = AnyClass::get(c"NSApplication") else {
        return;
    };
    let Some(method) = class.instance_method(sel!(sendEvent:)) else {
        return;
    };
    // SAFETY: `sendEvent:` is `- (void)sendEvent:(NSEvent *)event`: a receiver,
    // the selector and one object, returning nothing, which is `SendEvent`.
    let original = unsafe { std::mem::transmute::<Imp, SendEvent>(method.implementation()) };
    if ORIGINAL.set(original).is_err() {
        return;
    }
    let ours: SendEvent = send_event;
    // SAFETY: the same signature as the method it replaces, and it calls that
    // method with the same arguments; only an exception's path changes.
    unsafe { method.set_implementation(std::mem::transmute::<SendEvent, Imp>(ours)) };
}

unsafe extern "C-unwind" fn send_event(app: *mut AnyObject, sel: Sel, event: *mut AnyObject) {
    let Some(original) = ORIGINAL.get().copied() else {
        return;
    };
    // SAFETY: AppKit's own implementation, with the arguments AppKit gave us.
    if let Err(caught) = caught(|| unsafe { original(app, sel, event) }) {
        eprintln!(
            "edit: the window caught an exception handling an event and carried on: {caught}"
        );
    }
}

/// Runs `call`; an Objective-C exception it throws comes back as its description.
fn caught(call: impl FnOnce()) -> Result<(), String> {
    objc2::exception::catch(AssertUnwindSafe(call)).map_err(|exception| match exception {
        Some(exception) => format!("{exception:?}"),
        None => "an exception (nil)".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    use super::caught;

    #[test]
    fn an_exception_is_caught_not_an_abort() {
        let class = AnyClass::get(c"NSArray").unwrap();
        let error = caught(|| unsafe {
            let empty: *mut AnyObject = msg_send![class, array];
            // Out of range: NSRangeException.
            let _: *mut AnyObject = msg_send![empty, objectAtIndex: 3_usize];
        })
        .unwrap_err();
        assert!(error.contains("NSRangeException"), "{error}");
        assert_eq!(caught(|| {}), Ok(()));
    }

    /// AppKit's real `sendEvent:` throwing (handed something that isn't an
    /// event) under the guard: the call returns instead of aborting the test.
    #[test]
    fn appkit_throwing_in_send_event_is_survived() {
        super::guard();
        let app_class = AnyClass::get(c"NSApplication").unwrap();
        let array_class = AnyClass::get(c"NSArray").unwrap();
        unsafe {
            let app: *mut AnyObject = msg_send![app_class, sharedApplication];
            let not_an_event: *mut AnyObject = msg_send![array_class, array];
            let _: () = msg_send![app, sendEvent: not_an_event];
        }
    }
}
