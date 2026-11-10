//! The native preview's place in the window (docs/plans/2026-11-06-native-player.md):
//! a Core Animation layer under the page, where the engine draws the edit
//! (crates/edit-engine/src/player.rs) instead of the page drawing it in WebKit.
//!
//! The page asks for it (`preview_open`), says where its viewer is
//! (`preview_place`, in the page's points), sends the edit as its engine took
//! it (`preview_project`, then only what changed: `preview_patch`), each
//! answered with the revision now drawn or why it was refused, and at rest
//! asks for each frame (`preview_frame`, answered once it's on screen with how
//! long it took and where the time went). Playing is the player's
//! (`preview_play`, `preview_pause`): it runs on the speaker's clock, draws
//! the frames as they come due and says where it is when the page asks
//! (`preview_position`, once an animation frame); `preview_hint` names a
//! frame the playhead is about to land on, so its pictures are made ready.
//! `preview_rate` is the speed it plays at (Script mode's 2×, the sound's
//! pitch kept) and `preview_volume` how loud, both kept until changed and 1
//! in a preview just opened.
//! The page turns see-through over its viewer while the
//! layer shows (the webview stops drawing its own background), so everything
//! the page draws over the picture (notes, menus, dialogs, loaders) stays on
//! top of it, and the window looks as it did. One player thread owns the GPU
//! and the decoders; a frame asked for while another is drawn waits, and only
//! the newest of those waiting is drawn.

// Tauri's `#[command]` on an async function borrowing `State` expands to an `unreachable!()`.
#![allow(clippy::unreachable)]

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{msg_send, MainThreadMarker};
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_core_foundation::{CGFloat, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{kCGColorSpaceSRGB, CGColor, CGColorSpace};
use objc2_foundation::{NSNumber, NSString};
use objc2_quartz_core::{
    kCAGravityResizeAspect, CACornerMask, CALayer, CAMetalLayer, CATransaction,
};
use tauri::{State, WebviewWindow};

use edit_engine::excerpts::Excerpt;
use edit_engine::player::{describe_draw, trace, DrawTimes, Player};

/// The playhead resting this long is settled: its sound armed, the cuts ahead decoded.
const SETTLE: Duration = Duration::from_millis(250);

/// An update's answer: the revision the window now draws, or why it refused (the last one stays).
type Accepted = mpsc::Sender<Result<u64, String>>;

enum Command {
    Project {
        json: String,
        revision: u64,
        sources: HashMap<String, String>,
        sounds: HashMap<String, String>,
        excerpts: HashMap<String, Vec<Excerpt>>,
        cache: String,
        reply: Accepted,
    },
    Patch {
        base: u64,
        revision: u64,
        patch: String,
        reply: Accepted,
    },
    Resize {
        width: u32,
        height: u32,
    },
    Draw {
        frame: i64,
        reply: mpsc::Sender<Result<Drawn, String>>,
    },
    Play {
        frame: i64,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Pause {
        reply: mpsc::Sender<Result<Option<i64>, String>>,
    },
    Position {
        reply: mpsc::Sender<Result<Where, String>>,
    },
    Hint {
        frame: i64,
    },
    Rate {
        rate: f64,
    },
    Volume {
        level: f64,
    },
    Rest,
}

/// Where the player is: the playhead (a frame and a fraction), whether it's
/// playing and whether it reached the end since the last ask, and how playing
/// went since then: frames drawn, frames the clock passed undrawn, slow draws
/// (over 33 ms), their times, the speaker's output calls that ran short, and
/// why the sound went silent when it did (a file that won't open).
#[derive(serde::Serialize, Clone, Default)]
pub struct Where {
    frame: f64,
    playing: bool,
    ended: bool,
    drawn: u64,
    skipped: u64,
    slow: u64,
    draws: Vec<f64>,
    starved: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<String>,
}

/// A frame's answer to the page: the revision it shows, whether it was drawn
/// (not: already on screen, or a newer ask took its place) and where its
/// time went, in milliseconds, for the page's diagnostics.
#[derive(serde::Serialize, Clone, Copy, Default)]
pub struct Drawn {
    revision: u64,
    drawn: bool,
    skipped: bool,
    ms: f64,
    decode: f64,
    composite: f64,
    present: f64,
    opens: u64,
    seeks: u64,
    ffmpeg: u64,
}

impl Drawn {
    fn of(revision: u64, ms: f64, times: Option<DrawTimes>) -> Self {
        let Some(t) = times else {
            return Self {
                revision,
                ms,
                ..Self::default()
            };
        };
        Self {
            revision,
            drawn: true,
            skipped: false,
            ms,
            decode: t.decode,
            composite: t.composite,
            present: t.present,
            opens: t.decoders.opens,
            seeks: t.decoders.seeks,
            ffmpeg: t.decoders.ffmpeg,
        }
    }
}

/// The preview open in the window: its player thread, and its view (kept as
/// an address: it's only touched on the main thread).
struct Open {
    commands: mpsc::Sender<Command>,
    thread: std::thread::JoinHandle<()>,
    view: usize,
    webview: usize,
}

#[derive(Default)]
pub struct Previews(Mutex<Option<Open>>);

/// The player's thread: commands in order, a frame asked for while others
/// wait drawn only if it's the newest. Playing, it draws the clock's frames
/// as they come due between commands; at rest, a playhead left alone for a
/// moment is settled (its sound armed, the cuts ahead decoded).
fn player_thread(layer: usize, commands: mpsc::Receiver<Command>) {
    // SAFETY: the layer is retained by its view until `preview_close` has
    // stopped this thread (its sender dropped, then the view removed).
    let mut player = match unsafe { Player::new(layer as *mut std::ffi::c_void, 1, 1) } {
        Ok(player) => player,
        Err(error) => {
            eprintln!("edit: the native preview couldn't start: {error}");
            for command in commands {
                match command {
                    Command::Draw { reply, .. } => {
                        let _ = reply.send(Err(error.clone()));
                    }
                    Command::Project { reply, .. } | Command::Patch { reply, .. } => {
                        let _ = reply.send(Err(error.clone()));
                    }
                    Command::Play { reply, .. } => {
                        let _ = reply.send(Err(error.clone()));
                    }
                    Command::Pause { reply } => {
                        let _ = reply.send(Err(error.clone()));
                    }
                    Command::Position { reply } => {
                        let _ = reply.send(Err(error.clone()));
                    }
                    Command::Resize { .. }
                    | Command::Rest
                    | Command::Hint { .. }
                    | Command::Rate { .. }
                    | Command::Volume { .. } => {}
                }
            }
            return;
        }
    };
    let mut wait = SETTLE;
    let mut settled = false;
    // When the last command was done with: the playhead has rested since.
    let mut rested = std::time::Instant::now();
    loop {
        let first = match commands.recv_timeout(wait) {
            Ok(command) => Some(command),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        };
        let mut waiting: Vec<Command> = first.into_iter().collect();
        waiting.extend(commands.try_iter());
        let asked = !waiting.is_empty();
        let newest = waiting
            .iter()
            .rposition(|command| matches!(command, Command::Draw { .. }));
        for (index, command) in waiting.into_iter().enumerate() {
            match command {
                Command::Project {
                    json,
                    revision,
                    sources,
                    sounds,
                    excerpts,
                    cache,
                    reply,
                } => {
                    let started = std::time::Instant::now();
                    let bytes = json.len();
                    let count = sources.len();
                    let set = player.set_project(
                        &json,
                        revision,
                        sources,
                        sounds,
                        excerpts,
                        cache.into(),
                    );
                    trace(|| {
                        format!(
                            "project of {bytes} bytes, {count} sources, revision {revision}, set in {:.1} ms",
                            started.elapsed().as_secs_f64() * 1000.0
                        )
                    });
                    if let Err(error) = &set {
                        eprintln!("edit: the native preview refused the edit: {error}");
                    }
                    let _ = reply.send(set);
                }
                Command::Patch {
                    base,
                    revision,
                    patch,
                    reply,
                } => {
                    let started = std::time::Instant::now();
                    let bytes = patch.len();
                    let applied = player.apply_patch(base, revision, &patch);
                    trace(|| {
                        format!(
                            "patch of {bytes} bytes, revision {base} to {revision}, applied in {:.1} ms: {}",
                            started.elapsed().as_secs_f64() * 1000.0,
                            applied.as_ref().err().map_or("Ok", String::as_str)
                        )
                    });
                    let _ = reply.send(applied);
                }
                Command::Resize { width, height } => player.resize(width, height),
                Command::Rest => player.rest(),
                Command::Hint { frame } => player.hint(frame),
                Command::Rate { rate } => player.set_rate(rate),
                Command::Volume { level } => player.set_volume(level),
                Command::Play { frame, reply } => {
                    let _ = reply.send(player.play(frame));
                }
                Command::Pause { reply } => {
                    let _ = reply.send(Ok(player.pause()));
                }
                Command::Position { reply } => {
                    let at = player.position();
                    let _ = reply.send(Ok(Where {
                        frame: at.frame,
                        playing: at.playing,
                        ended: at.ended,
                        drawn: at.report.drawn,
                        skipped: at.report.skipped,
                        slow: at.report.slow,
                        draws: at.report.draws,
                        starved: at.report.starved,
                        problem: at.report.problem,
                    }));
                }
                Command::Draw { frame, reply } => {
                    // An older ask: the newer one is drawn instead (the page asks for the frame it's on).
                    // Playing, the clock draws: the ask is answered as is.
                    if Some(index) != newest || player.is_playing() {
                        if !player.is_playing() {
                            trace(|| format!("frame {frame} skipped: a newer one was asked"));
                        }
                        let _ = reply.send(Ok(Drawn {
                            revision: player.revision(),
                            skipped: Some(index) != newest,
                            ..Drawn::default()
                        }));
                        continue;
                    }
                    let started = std::time::Instant::now();
                    let drawn = player.draw(frame);
                    let ms = started.elapsed().as_secs_f64() * 1000.0;
                    trace(|| describe_draw(frame, ms, &drawn, player.last));
                    let _ =
                        reply.send(drawn.map(|()| Drawn::of(player.revision(), ms, player.last)));
                }
            }
        }
        if asked {
            settled = false;
            rested = std::time::Instant::now();
        }
        if player.is_playing() {
            wait = player.tick().unwrap_or(SETTLE);
        } else if settled {
            wait = SETTLE;
        } else {
            // Settled only once it has rested: after every command, a drag armed its sound at each
            // frame it passed (a mixer started and stopped thirty times a second, and the pictures
            // fell from 24 a second to 5 behind them).
            let quiet = rested.elapsed();
            if quiet >= SETTLE {
                player.settle();
                settled = true;
                wait = SETTLE;
            } else {
                wait = SETTLE - quiet;
            }
        }
    }
}

/// Runs `work` on the main thread with the window's webview, and waits for its answer.
fn on_main<T: Send + 'static>(
    window: &WebviewWindow,
    work: impl FnOnce(usize, usize) -> T + Send + 'static,
) -> Result<T, String> {
    let (send, answer) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let _ = send.send(work(webview.inner() as usize, webview.ns_window() as usize));
        })
        .map_err(|error| error.to_string())?;
    answer.recv().map_err(|error| error.to_string())
}

/// Whether the webview draws its own background (off: the page is see-through where it draws nothing).
///
/// # Safety
/// `webview` is the window's live WKWebView, and this runs on the main thread.
unsafe fn draws_background(webview: usize, on: bool) {
    let webview = webview as *mut AnyObject;
    let value = NSNumber::new_bool(on);
    let key = NSString::from_str("drawsBackground");
    // SAFETY: WKWebView answers drawsBackground (wry's transparent webviews set it the same way).
    let _: () = unsafe { msg_send![webview, setValue: &*value, forKey: &*key] };
}

/// Opens the preview's layer under the page (hidden until placed). False when this Mac can't.
#[tauri::command]
pub async fn preview_open(
    window: WebviewWindow,
    previews: State<'_, Previews>,
) -> Result<bool, String> {
    if previews
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        trace(|| "open: already open".to_owned());
        return Ok(true);
    }
    let made = on_main(&window, |webview, _| {
        let main = MainThreadMarker::new()?;
        let wk = webview as *mut AnyObject;
        // SAFETY: on the main thread, with the window's live webview.
        unsafe {
            let parent: *mut NSView = msg_send![wk, superview];
            let parent = parent.as_ref()?;
            let layer = CAMetalLayer::new();
            // The page's canvas is sRGB: drawn as such, its colours are the same here.
            if let Some(space) = CGColorSpace::with_name(Some(kCGColorSpaceSRGB)) {
                layer.setColorspace(Some(&space));
            }
            layer.setOpaque(true);
            // Between a new size and the frame drawn at it, the old picture is fitted into the
            // new shape, not stretched to it (a view changed, a panel dragged: the picture squashed).
            layer.setContentsGravity(kCAGravityResizeAspect);
            let black = CGColor::new_generic_gray(0.0, 1.0);
            layer.setBackgroundColor(Some(&black));
            let view = NSView::initWithFrame(
                main.alloc(),
                CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(1.0, 1.0)),
            );
            // A layer-hosting view: the layer is ours, set before it wants one.
            view.setLayer(Some(&layer));
            view.setWantsLayer(true);
            view.setHidden(true);
            let below: &NSView = &*(wk as *const NSView);
            parent.addSubview_positioned_relativeTo(
                &view,
                NSWindowOrderingMode::Below,
                Some(below),
            );
            draws_background(webview, false);
            let address = Retained::as_ptr(&layer) as usize;
            Some((Retained::into_raw(view) as usize, address, webview))
        }
    })?;
    let Some((view, layer, webview)) = made else {
        trace(|| "couldn't open".to_owned());
        return Ok(false);
    };
    trace(|| "opened".to_owned());
    let (commands, received) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("edit preview".to_owned())
        .spawn(move || player_thread(layer, received))
        .map_err(|error| error.to_string())?;
    *previews.0.lock().map_err(|error| error.to_string())? = Some(Open {
        commands,
        thread,
        view,
        webview,
    });
    Ok(true)
}

/// Where the viewer is in the page (points from its top left), the radius of
/// its top corners, and whether the layer shows.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn preview_place(
    window: WebviewWindow,
    previews: State<'_, Previews>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    radius: f64,
    visible: bool,
) -> Result<(), String> {
    let (view, commands) = {
        let open = previews.0.lock().map_err(|error| error.to_string())?;
        let Some(open) = open.as_ref() else {
            return Err("the preview isn't open".to_owned());
        };
        (open.view, open.commands.clone())
    };
    let scale = on_main(&window, move |webview, ns_window| {
        // SAFETY: on the main thread; the view is ours until `preview_close`, the webview and window the app's.
        unsafe {
            let view = &*(view as *const NSView);
            let wk = &*(webview as *const NSView);
            let frame = wk.frame();
            // The page's points go down from its top; its parent's go up, unless it's flipped.
            let flipped = wk.superview().is_some_and(|parent| parent.isFlipped());
            let top = if flipped {
                frame.origin.y + y
            } else {
                frame.origin.y + frame.size.height - y - height
            };
            CATransaction::begin();
            // Moved and sized at once with the page, never animated there.
            CATransaction::setDisableActions(true);
            view.setFrame(CGRect::new(
                CGPoint::new(frame.origin.x + x, top),
                CGSize::new(width.max(1.0), height.max(1.0)),
            ));
            view.setHidden(!visible);
            let scale: CGFloat = msg_send![ns_window as *mut AnyObject, backingScaleFactor];
            if let Some(layer) = view.layer() {
                let layer: &CALayer = &layer;
                layer.setContentsScale(scale);
                layer.setCornerRadius(radius);
                layer.setMasksToBounds(radius > 0.0);
                // The viewer's top corners (y points up in the layer).
                layer.setMaskedCorners(
                    CACornerMask::LayerMinXMaxYCorner | CACornerMask::LayerMaxXMaxYCorner,
                );
            }
            CATransaction::commit();
            scale
        }
    })?;
    trace(|| {
        format!("placed at {x},{y} {width}×{height} (×{scale}), radius {radius}, visible {visible}")
    });
    let to_pixels = |points: f64| (points * scale).round().max(1.0) as u32;
    let _ = commands.send(if visible {
        Command::Resize {
            width: to_pixels(width),
            height: to_pixels(height),
        }
    } else {
        Command::Rest
    });
    Ok(())
}

/// The commands to the player thread, while the preview is open.
fn commands(previews: &State<'_, Previews>) -> Result<mpsc::Sender<Command>, String> {
    let open = previews.0.lock().map_err(|error| error.to_string())?;
    Ok(open
        .as_ref()
        .ok_or("the preview isn't open")?
        .commands
        .clone())
}

/// Sends `command` and waits (off the main thread) for its answer.
async fn ask<T: Send + 'static>(
    previews: &State<'_, Previews>,
    command: impl FnOnce(mpsc::Sender<Result<T, String>>) -> Command,
) -> Result<T, String> {
    let (reply, answer) = mpsc::channel();
    commands(previews)?
        .send(command(reply))
        .map_err(|_| "the preview stopped".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        answer.recv().map_err(|_| "the preview stopped".to_owned())
    })
    .await
    .map_err(|error| error.to_string())??
}

/// The edit to draw at the page's `revision`, as the page's engine takes it,
/// what each media is decoded from and the local excerpts of streamed ones.
/// Answers the revision now drawn, or why it was refused.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn preview_project(
    previews: State<'_, Previews>,
    json: String,
    revision: u64,
    sources: HashMap<String, String>,
    sounds: Option<HashMap<String, String>>,
    excerpts: Option<HashMap<String, Vec<Excerpt>>>,
    cache: String,
) -> Result<u64, String> {
    ask(&previews, |reply| Command::Project {
        json,
        revision,
        sources,
        sounds: sounds.unwrap_or_default(),
        excerpts: excerpts.unwrap_or_default(),
        cache,
        reply,
    })
    .await
}

/// What changed in the edit since revision `base` (the page's lib/patch.ts),
/// making `revision`. Refused when the window isn't at `base` or it doesn't
/// fit: the page sends the whole edit then.
#[tauri::command]
pub async fn preview_patch(
    previews: State<'_, Previews>,
    base: u64,
    revision: u64,
    patch: String,
) -> Result<u64, String> {
    ask(&previews, |reply| Command::Patch {
        base,
        revision,
        patch,
        reply,
    })
    .await
}

/// Draws `frame`; answers once it's on screen (or a newer ask took its place).
#[tauri::command]
pub async fn preview_frame(previews: State<'_, Previews>, frame: i64) -> Result<Drawn, String> {
    ask(&previews, |reply| Command::Draw { frame, reply }).await
}

/// Plays from `frame` on the player's clock (the speaker's), the picture following.
#[tauri::command]
pub async fn preview_play(previews: State<'_, Previews>, frame: i64) -> Result<(), String> {
    ask(&previews, |reply| Command::Play { frame, reply }).await
}

/// Stops playing; the frame the playhead rests on (None: it wasn't playing).
#[tauri::command]
pub async fn preview_pause(previews: State<'_, Previews>) -> Result<Option<i64>, String> {
    ask(&previews, |reply| Command::Pause { reply }).await
}

/// Where the player is, and how playing went since the last ask.
#[tauri::command]
pub async fn preview_position(previews: State<'_, Previews>) -> Result<Where, String> {
    ask(&previews, |reply| Command::Position { reply }).await
}

/// The playhead is about to land on `frame`: its pictures are made ready.
#[tauri::command]
pub fn preview_hint(previews: State<'_, Previews>, frame: i64) -> Result<(), String> {
    commands(&previews)?
        .send(Command::Hint { frame })
        .map_err(|_| "the preview stopped".to_owned())
}

/// The speed it plays at, from now until changed: 1 as the edit is, 2 twice
/// as fast with the sound's pitch kept (held within 0.25–4). Playing, it
/// plays on from where it is at the new speed.
#[tauri::command]
pub fn preview_rate(previews: State<'_, Previews>, rate: f64) -> Result<(), String> {
    commands(&previews)?
        .send(Command::Rate { rate })
        .map_err(|_| "the preview stopped".to_owned())
}

/// How loud it plays, 0 (silent) to 1, at once and until changed.
#[tauri::command]
pub fn preview_volume(previews: State<'_, Previews>, level: f64) -> Result<(), String> {
    commands(&previews)?
        .send(Command::Volume { level })
        .map_err(|_| "the preview stopped".to_owned())
}

/// Takes the layer away and gives the page its background back.
#[tauri::command]
pub async fn preview_close(
    window: WebviewWindow,
    previews: State<'_, Previews>,
) -> Result<(), String> {
    let Some(open) = previews.0.lock().map_err(|error| error.to_string())?.take() else {
        return Ok(());
    };
    trace(|| "closed".to_owned());
    let Open {
        commands,
        thread,
        view,
        webview,
    } = open;
    // The thread ends once its commands are gone (after the frame it's on), before the layer it draws into goes.
    drop(commands);
    tauri::async_runtime::spawn_blocking(move || thread.join())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "the preview's thread failed".to_owned())?;
    let app = tauri::Manager::app_handle(&window).clone();
    on_main(&window, move |_, _| {
        // Opened again while this one's thread was ending (the script page left for the editor, each
        // with its own player): the page stays see-through for the new one. Its background given back
        // here would paint over the new picture.
        let open_again = tauri::Manager::state::<Previews>(&app)
            .0
            .lock()
            .is_ok_and(|open| open.is_some());
        // SAFETY: on the main thread; the view was retained by `preview_open` and is let go of here, once.
        unsafe {
            if !open_again {
                draws_background(webview, true);
            }
            let view = Retained::from_raw(view as *mut NSView);
            if let Some(view) = view {
                view.removeFromSuperview();
            }
        }
    })
}

/// A check of the native preview with nobody at the keys (`EDIT_PREVIEW_CHECK=<frame>`,
/// with `EDIT_PREVIEW_TRACE=1` to see each draw): once the page has had time to
/// open its project, it goes to that frame, scrubs on from there as a drag
/// would (a position every 16 ms), then plays ten seconds.
pub fn check(app: &tauri::AppHandle) {
    use tauri::Manager;
    // A scripted run instead (`EDIT_PREVIEW_JS=<file>`): the file's steps run in
    // the page in turn, a line `--- wait <seconds>` between them; a line
    // `--- shot <file.png>` saves the window's own picture then.
    if let Ok(file) = std::env::var("EDIT_PREVIEW_JS") {
        let Ok(text) = std::fs::read_to_string(&file) else {
            eprintln!("edit: EDIT_PREVIEW_JS: can't read {file}");
            return;
        };
        let app = app.clone();
        std::thread::spawn(move || {
            let mut step = String::new();
            let run = |js: &str| {
                if !js.trim().is_empty() {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval(js);
                    }
                }
            };
            for line in text.lines() {
                if let Some(seconds) = line.strip_prefix("--- wait ") {
                    run(&step);
                    step.clear();
                    let seconds = seconds.trim().parse::<f64>().unwrap_or(1.0);
                    trace(|| format!("script: wait {seconds} s"));
                    std::thread::sleep(std::time::Duration::from_secs_f64(seconds));
                } else if let Some(path) = line.strip_prefix("--- shot ") {
                    // The window as it is now (the page and the layer under it) into a PNG.
                    run(&step);
                    step.clear();
                    let path = path.trim().to_owned();
                    if let Some(window) = app.get_webview_window("main") {
                        let file = path.clone();
                        let shot = on_main(&window, move |_, ns_window| {
                            // SAFETY: on the main thread with the app's own window.
                            let number: isize =
                                unsafe { msg_send![ns_window as *mut AnyObject, windowNumber] };
                            // SAFETY: plain CoreGraphics / ImageIO calls on values made here.
                            unsafe { shoot(number, &file) }
                        });
                        trace(|| format!("script: shot {path}: {shot:?}"));
                    }
                } else {
                    step.push_str(line);
                    step.push('\n');
                }
            }
            run(&step);
            trace(|| "script: done".to_owned());
        });
        return;
    }
    let Some(from) = std::env::var("EDIT_PREVIEW_CHECK")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
    else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let run = |js: &str| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(js);
            }
        };
        let wait = |seconds: u64| std::thread::sleep(std::time::Duration::from_secs(seconds));
        wait(20);
        // A page that didn't start: WebKit's own reason, in Edit's log.
        run(
            r#"if (!window.__edit) { const src = document.querySelector("script[type=module]")?.getAttribute("src"); import(src).then(() => "loaded", (error) => `${error}`).then((said) => fetch("/api/diagnostics/client", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "warn", message: `preview check: the page didn't start (${src}): ${said}` }) })); }"#,
        );
        trace(|| format!("check: seek to {from}"));
        run(&format!("window.__edit?.preview.seek({from})"));
        wait(6);
        trace(|| "check: scrub".to_owned());
        run(&format!("(() => {{ const p = window.__edit.preview; let f = {from}; const step = () => {{ f += 8; p.seek(f); if (f < {from} + 1000) setTimeout(step, 16); }}; step(); }})()"));
        wait(6);
        run(&format!("window.__edit?.preview.seek({from})"));
        wait(3);
        trace(|| "check: play".to_owned());
        run("window.__edit?.preview.play()");
        wait(10);
        run("window.__edit?.preview.pause()");
        wait(2);
        // What the page paints where the picture is: said in Edit's log.
        run(
            r#"(() => { const at = (x, y) => { const out = []; for (let e = document.elementFromPoint(x, y); e; e = e.parentElement) out.push(`${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? "." + e.className.split(" ").slice(0, 2).join(".") : ""}=${getComputedStyle(e).backgroundColor}`); return out.join(" < "); }; fetch("/api/diagnostics/client", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "warn", message: `preview check: native=${window.__edit.preview.native} script=${document.querySelector("script[src*=index]")?.getAttribute("src")} inline=${document.documentElement.style.cssText} html=${document.documentElement.className} at the picture: ${at(300, 200)}` }) }); })()"#,
        );
        wait(1);
        if let Ok(path) = std::env::var("EDIT_PREVIEW_SHOT") {
            if let Some(window) = app.get_webview_window("main") {
                let shot = on_main(&window, move |_, ns_window| {
                    // SAFETY: on the main thread with the app's own window.
                    let number: isize =
                        unsafe { msg_send![ns_window as *mut AnyObject, windowNumber] };
                    // SAFETY: plain CoreGraphics / ImageIO calls on values made here.
                    unsafe { shoot(number, &path) }
                });
                trace(|| format!("check: shot {shot:?}"));
            }
        }
        trace(|| "check: done".to_owned());
    });
}

/// The window's own picture (the page and the layer under it, as on screen) into a PNG at `path`.
/// An app may capture its own windows without the screen-recording permission.
///
/// # Safety
/// Calls CoreGraphics and ImageIO directly; `number` is this app's window.
unsafe fn shoot(number: isize, path: &str) -> bool {
    use std::ffi::{c_void, CString};
    #[repr(C)]
    struct Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }
    // CoreGraphics and CoreFoundation come with their objc2 crates.
    #[link(name = "ImageIO", kind = "framework")]
    extern "C" {
        fn CGWindowListCreateImage(bounds: Rect, list: u32, window: u32, image: u32)
            -> *mut c_void;
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            text: *const i8,
            encoding: u32,
        ) -> *mut c_void;
        fn CFURLCreateWithFileSystemPath(
            alloc: *const c_void,
            path: *mut c_void,
            style: isize,
            directory: u8,
        ) -> *mut c_void;
        fn CGImageDestinationCreateWithURL(
            url: *mut c_void,
            kind: *mut c_void,
            count: usize,
            options: *const c_void,
        ) -> *mut c_void;
        fn CGImageDestinationAddImage(
            destination: *mut c_void,
            image: *mut c_void,
            properties: *const c_void,
        );
        fn CGImageDestinationFinalize(destination: *mut c_void) -> bool;
        fn CFRelease(value: *mut c_void);
    }
    let null = Rect {
        x: f64::INFINITY,
        y: f64::INFINITY,
        w: 0.0,
        h: 0.0,
    };
    // kCGWindowListOptionIncludingWindow, kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution.
    // SAFETY: (all below) plain calls on values made here, each released once.
    let image = unsafe { CGWindowListCreateImage(null, 1 << 3, number as u32, 1 | 8) };
    if image.is_null() {
        return false;
    }
    let (Ok(text), Ok(kind)) = (CString::new(path), CString::new("public.png")) else {
        return false;
    };
    unsafe {
        let path = CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), 0x0800_0100);
        let kind = CFStringCreateWithCString(std::ptr::null(), kind.as_ptr(), 0x0800_0100);
        let url = CFURLCreateWithFileSystemPath(std::ptr::null(), path, 0, 0);
        let destination = CGImageDestinationCreateWithURL(url, kind, 1, std::ptr::null());
        let done = !destination.is_null() && {
            CGImageDestinationAddImage(destination, image, std::ptr::null());
            CGImageDestinationFinalize(destination)
        };
        for value in [destination, url, kind, path, image] {
            if !value.is_null() {
                CFRelease(value);
            }
        }
        done
    }
}
