//! Research on this machine: web and image searches through the local
//! Chrome, headless, in a throwaway profile (not signed in, no cookies,
//! nothing kept), so nothing lands in anyone's search history; they leave
//! from this machine's own connection. Articles come from DuckDuckGo, images
//! from Bing (Google blocks headless browsers).
//!
//! Found images are collected per project in `<home>/research/<project>/`
//! for the user to review; the ones they keep go into the media bin.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/// Smaller than this on its short side isn't worth a look (thumbnails, icons).
const MIN_SIDE: u32 = 360;
const MAX_BYTES: u64 = 25_000_000;
/// Bing's pages of image results.
const PAGE: usize = 35;

/// One web search result.
#[derive(Clone, Debug, Serialize)]
pub struct Found {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// A found image awaiting review (or reviewed).
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Item {
    /// The first 16 hex digits of the file's SHA-256.
    pub id: String,
    pub file: String,
    pub width: u32,
    pub height: u32,
    /// The image's title on the page it came from.
    pub title: String,
    /// The page it's on.
    pub page: String,
    /// The image itself.
    pub image: String,
    /// The search that found it.
    pub query: String,
    /// new | kept | rejected.
    pub status: String,
    /// The media it became once kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
}

/// Collections in progress (by project), and the lock on every index.
static COLLECTING: Mutex<Vec<String>> = Mutex::new(Vec::new());
static INDEX: Mutex<()> = Mutex::new(());

pub fn dir(home: &Path, project: &str) -> PathBuf {
    home.join("research").join(project)
}

pub fn collecting(project: &str) -> bool {
    COLLECTING.lock().unwrap().iter().any(|id| id == project)
}

pub fn items(home: &Path, project: &str) -> Vec<Item> {
    let _guard = INDEX.lock().unwrap();
    read_index(home, project)
}

fn read_index(home: &Path, project: &str) -> Vec<Item> {
    std::fs::read(dir(home, project).join("index.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_index(home: &Path, project: &str, items: &[Item]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(items).map_err(|error| error.to_string())?;
    crate::store::write_atomic(&dir(home, project).join("index.json"), &bytes)
        .map_err(|error| error.to_string())
}

/// Changes one item (its status, the media it became).
pub fn update(
    home: &Path,
    project: &str,
    id: &str,
    change: impl FnOnce(&mut Item),
) -> Result<Item, String> {
    let _guard = INDEX.lock().unwrap();
    let mut items = read_index(home, project);
    let item = items
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("no found image {id}"))?;
    change(item);
    let item = item.clone();
    write_index(home, project, &items)?;
    Ok(item)
}

/// A page as the browser renders it (scripts run), from a fresh profile
/// that's deleted afterwards.
fn dump(url: &str) -> Result<String, String> {
    let browser =
        crate::broll::chrome().ok_or("research needs Google Chrome (or Chromium) installed")?;
    let profile = std::env::temp_dir().join(format!(
        "edit-research-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |time| time.as_nanos())
    ));
    let mut child = Command::new(browser)
        .args([
            "--headless=new",
            "--no-first-run",
            "--no-default-browser-check",
            "--mute-audio",
            "--disable-extensions",
            "--virtual-time-budget=6000",
            &format!("--user-agent={USER_AGENT}"),
            &format!("--user-data-dir={}", profile.display()),
            "--dump-dom",
            url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("chrome: {error}"))?;
    let mut stdout = child.stdout.take().ok_or("chrome stdout")?;
    // Headless Chrome prints the page and then may not exit: stop it once the page is out.
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut page = Vec::new();
        let mut chunk = [0; 65536];
        while let Ok(read) = stdout.read(&mut chunk) {
            if read == 0 {
                break;
            }
            page.extend_from_slice(&chunk[..read]);
            let tail = &page[page.len().saturating_sub(64)..];
            if tail.windows(7).any(|window| window == b"</html>") {
                break;
            }
        }
        let _ = sender.send(page);
    });
    let page = receiver.recv_timeout(Duration::from_secs(45));
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&profile);
    let page = page.map_err(|_| "the page took too long to load".to_owned())?;
    Ok(String::from_utf8_lossy(&page).into_owned())
}

/// Web results for `query` (DuckDuckGo).
pub fn search_web(query: &str) -> Result<Vec<Found>, String> {
    let page = dump(&format!(
        "https://html.duckduckgo.com/html/?q={}",
        crate::library::encode(query)
    ))?;
    let mut found = Vec::new();
    for block in page.split("class=\"result__a\"").skip(1) {
        let href = attribute(block, "href").unwrap_or_default();
        let url = href
            .split("uddg=")
            .nth(1)
            .and_then(|rest| rest.split('&').next())
            .map(decode)
            .unwrap_or(href);
        let title = text_of(
            block
                .split_once('>')
                .map_or("", |(_, rest)| rest)
                .split("</a>")
                .next()
                .unwrap_or(""),
        );
        let snippet = block
            .split("class=\"result__snippet\"")
            .nth(1)
            .and_then(|rest| rest.split_once('>'))
            .map(|(_, rest)| text_of(rest.split("</a>").next().unwrap_or("")))
            .unwrap_or_default();
        if url.starts_with("http") && !title.is_empty() {
            found.push(Found {
                title,
                url,
                snippet,
            });
        }
    }
    if found.is_empty() && page.to_lowercase().contains("anomaly") {
        return Err(
            "DuckDuckGo wants a check that a person is searching; try again in a few minutes"
                .into(),
        );
    }
    Ok(found)
}

/// A page's readable text (scripts, styles and tags dropped), cut at `limit` characters.
pub fn read_page(url: &str, limit: usize) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("give a web address (http or https)".into());
    }
    let mut text = dump(url)?;
    // Drop what's never read: scripts, styles, svg and the like.
    for tag in ["script", "style", "noscript", "svg", "template"] {
        let (open, close) = (format!("<{tag}"), format!("</{tag}>"));
        let mut kept = String::with_capacity(text.len());
        let mut rest = text.as_str();
        while let Some(start) = rest.find(&open) {
            kept.push_str(&rest[..start]);
            rest = rest[start..]
                .find(&close)
                .map_or("", |end| &rest[start + end + close.len()..]);
        }
        kept.push_str(rest);
        text = kept;
    }
    Ok(text_of(&text).chars().take(limit).collect())
}

/// Searches images for each query (Bing), downloads them, and adds the new
/// ones (big enough, not seen before) to the project's review. Returns
/// (added, already had, failed).
pub fn collect(
    home: &Path,
    project: &str,
    queries: &[String],
    per_query: usize,
) -> Result<(usize, usize, usize), String> {
    {
        let mut collecting = COLLECTING.lock().unwrap();
        if collecting.iter().any(|id| id == project) {
            return Err("already collecting images for this project; wait for it to finish".into());
        }
        collecting.push(project.to_owned());
    }
    let result = collect_inner(home, project, queries, per_query);
    COLLECTING.lock().unwrap().retain(|id| id != project);
    result
}

/// One Bing image result: (image, page, title).
type Hit = (String, String, String);

fn collect_inner(
    home: &Path,
    project: &str,
    queries: &[String],
    per_query: usize,
) -> Result<(usize, usize, usize), String> {
    let folder = dir(home, project);
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let seen: HashSet<String> = items(home, project)
        .iter()
        .flat_map(|item| [item.id.clone(), item.image.clone()])
        .collect();
    let (mut added, mut had, mut failed) = (0, 0, 0);
    for query in queries {
        let mut hits: Vec<Hit> = Vec::new();
        let mut first = 1;
        while hits.len() < per_query {
            let url = if first == 1 {
                format!(
                    "https://www.bing.com/images/search?q={}&first=1",
                    crate::library::encode(query)
                )
            } else {
                format!(
                    "https://www.bing.com/images/async?q={}&first={first}&count={PAGE}&mmasync=1",
                    crate::library::encode(query)
                )
            };
            let page = dump(&url)?;
            let before = hits.len();
            hits.extend(image_hits(&page));
            if hits.len() == before {
                break;
            }
            first += PAGE;
        }
        hits.truncate(per_query);
        let fresh: Vec<Hit> = hits
            .into_iter()
            .filter(|(image, ..)| {
                let new = !seen.contains(image);
                if !new {
                    had += 1;
                }
                new
            })
            .collect();
        // A few downloads at a time.
        for batch in fresh.chunks(8) {
            let results: Vec<Option<Item>> = std::thread::scope(|scope| {
                let handles: Vec<_> = batch
                    .iter()
                    .map(|hit| scope.spawn(|| download(&folder, hit, query)))
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| handle.join().ok().flatten())
                    .collect()
            });
            let _guard = INDEX.lock().unwrap();
            let mut index = read_index(home, project);
            for result in results {
                match result {
                    Some(item) if index.iter().any(|known| known.id == item.id) => had += 1,
                    Some(item) => {
                        index.push(item);
                        added += 1;
                    }
                    None => failed += 1,
                }
            }
            write_index(home, project, &index)?;
        }
    }
    Ok((added, had, failed))
}

/// The image results on a Bing images page: their `m` attributes.
fn image_hits(page: &str) -> Vec<Hit> {
    page.split("class=\"iusc\"")
        .skip(1)
        .filter_map(|block| {
            let meta: Value = serde_json::from_str(&attribute(block, "m")?).ok()?;
            let image = meta["murl"].as_str()?.to_owned();
            image.starts_with("http").then(|| {
                (
                    image,
                    meta["purl"].as_str().unwrap_or_default().to_owned(),
                    meta["t"].as_str().unwrap_or_default().to_owned(),
                )
            })
        })
        .collect()
}

/// Downloads one found image, if it's a real image big enough to use.
fn download(folder: &Path, (image, page, title): &Hit, query: &str) -> Option<Item> {
    let part = folder.join(format!(".{}.part", hex(&Sha256::digest(image.as_bytes()))));
    let output = Command::new("curl")
        .args([
            "-sSL",
            "--proto",
            "=http,https",
            "--max-time",
            "25",
            "--max-filesize",
        ])
        .arg(MAX_BYTES.to_string())
        .args(["-A", USER_AGENT, "-e", page, "-w", "%{http_code}", "-o"])
        .arg(&part)
        .arg(image)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let bytes = std::fs::read(&part).ok();
    let _ = std::fs::remove_file(&part);
    let bytes = bytes?;
    if String::from_utf8_lossy(&output.stdout).trim() != "200" {
        return None;
    }
    let extension = match bytes.get(..12)? {
        [0xFF, 0xD8, 0xFF, ..] => "jpg",
        [0x89, b'P', b'N', b'G', ..] => "png",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P'] => "webp",
        _ => return None,
    };
    let id: String = hex(&Sha256::digest(&bytes)).chars().take(16).collect();
    let path = folder.join(format!("{id}.{extension}"));
    if !path.exists() {
        std::fs::write(&path, &bytes).ok()?;
    }
    let (width, height) = dimensions(&path)?;
    if width.min(height) < MIN_SIDE {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    Some(Item {
        id,
        file: path.to_string_lossy().into_owned(),
        width,
        height,
        title: title.clone(),
        page: page.clone(),
        image: image.clone(),
        query: query.to_owned(),
        status: "new".into(),
        media: None,
    })
}

fn dimensions(path: &Path) -> Option<(u32, u32)> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let (width, height) = text.trim().split_once(',')?;
    Some((width.trim().parse().ok()?, height.trim().parse().ok()?))
}

/// An attribute's value in the tag that `block` starts inside, unescaped.
fn attribute(block: &str, name: &str) -> Option<String> {
    let tag = block.split('>').next()?;
    let start = tag.find(&format!(" {name}=\""))? + name.len() + 3;
    let end = tag[start..].find('"')? + start;
    Some(unescape(&tag[start..end]))
}

/// Markup to plain text: tags dropped, entities read, spaces collapsed.
fn text_of(markup: &str) -> String {
    let mut text = String::with_capacity(markup.len());
    let mut in_tag = false;
    for c in markup.chars() {
        match c {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' => in_tag = false,
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    unescape(&text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn unescape(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Percent-decoding (DuckDuckGo's redirect links).
fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = (bytes[index] == b'%')
            .then(|| bytes.get(index + 1..index + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (escaped, bytes[index]) {
            (Some(byte), _) => {
                out.push(byte);
                index += 3;
            }
            (None, b'+') => {
                out.push(b' ');
                index += 1;
            }
            (None, byte) => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_bing_image_results() {
        let page = r#"<a class="iusc" style="x" m="{&quot;purl&quot;:&quot;https://news.example/story&quot;,&quot;murl&quot;:&quot;https://img.example/a.jpg?x=1&amp;y=2&quot;,&quot;t&quot;:&quot;Crash scene&quot;}" href="/x">"#;
        assert_eq!(
            image_hits(page),
            vec![(
                "https://img.example/a.jpg?x=1&y=2".to_owned(),
                "https://news.example/story".to_owned(),
                "Crash scene".to_owned()
            )]
        );
    }

    #[test]
    fn decodes_duckduckgo_links() {
        assert_eq!(
            decode("https%3A%2F%2Fmynorthwest.com%2Fkent%2Dhit"),
            "https://mynorthwest.com/kent-hit"
        );
        assert_eq!(
            text_of("<b>Kent</b> police &amp; <i>the</i>\n  teen"),
            "Kent police & the teen"
        );
    }
}
