//! Research on this machine: web and image searches through the local
//! Chrome, headless, in a throwaway profile (not signed in, no cookies,
//! nothing kept), so nothing lands in anyone's search history; they leave
//! from this machine's own connection. Articles come from DuckDuckGo, images
//! from Bing (Google blocks headless browsers).
//!
//! Found images are collected per project in `<home>/research/<project>/`
//! for the user to review; the ones they keep go into the media bin.

use parking_lot::Mutex;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
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
    COLLECTING.lock().iter().any(|id| id == project)
}

pub fn items(home: &Path, project: &str) -> Vec<Item> {
    let _guard = INDEX.lock();
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
    let _guard = INDEX.lock();
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

/// An article page: kept for a few minutes (read_page then add_article on
/// the same story fetched it twice), fetched plainly first (most news pages
/// are rendered on the server, and a plain fetch takes a second where a
/// fresh headless Chrome takes ten or twenty), the browser only when the plain
/// page is a shell, a block or too thin to be the story.
fn article_page(url: &str) -> Result<String, String> {
    type Pages = Mutex<Vec<(String, std::time::Instant, String)>>;
    static PAGES: std::sync::OnceLock<Pages> = std::sync::OnceLock::new();
    let pages = PAGES.get_or_init(Default::default);
    let fresh = Duration::from_secs(600);
    if let Some((_, _, page)) = pages
        .lock()
        .iter()
        .find(|(own, at, _)| own == url && at.elapsed() < fresh)
    {
        return Ok(page.clone());
    }
    let page = match plain(url) {
        Some(page) => page,
        None => dump(url)?,
    };
    let mut kept = pages.lock();
    kept.retain(|(own, at, _)| own != url && at.elapsed() < fresh);
    if kept.len() >= 24 {
        kept.remove(0);
    }
    kept.push((url.to_owned(), std::time::Instant::now(), page.clone()));
    Ok(page)
}

/// The page as the server sends it, when that's already the story: a 200
/// with a couple of thousand characters of readable text and no sign of a
/// bot check.
fn plain(url: &str) -> Option<String> {
    let output = Command::new("curl")
        .args([
            "-sSL",
            "--compressed",
            "--proto",
            "=https,http",
            "--max-time",
            "15",
        ])
        .args(["-A", USER_AGENT, "-H", "Accept-Language: en-US,en;q=0.9"])
        .args(["-w", "\n%{http_code}", url])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let out = String::from_utf8_lossy(&output.stdout);
    let (page, code) = out.rsplit_once('\n')?;
    if code.trim() != "200" {
        return None;
    }
    // Judged on the readable text: a <noscript> "enable JavaScript" note on
    // a server-rendered story isn't a block.
    let text = readable(page);
    let lower = text.to_ascii_lowercase();
    let blocked = [
        "captcha",
        "verify you are human",
        "human verification",
        "access denied",
        "please enable javascript",
    ]
    .iter()
    .any(|sign| lower.contains(sign));
    (!blocked && text.len() >= 2000).then(|| page.to_owned())
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
            page.extend_from_slice(chunk.get(..read).unwrap_or_default());
            let tail = page
                .get(page.len().saturating_sub(64)..)
                .unwrap_or_default();
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
    Ok(readable(&article_page(url)?).chars().take(limit).collect())
}

/// A page's readable text: scripts, styles and tags dropped.
fn readable(page: &str) -> String {
    let mut text = page.to_owned();
    // Drop what's never read: scripts, styles, svg and the like.
    for tag in ["script", "style", "noscript", "svg", "template"] {
        let (open, close) = (format!("<{tag}"), format!("</{tag}>"));
        let mut kept = String::with_capacity(text.len());
        let mut rest = text.as_str();
        while let Some((before, from)) = rest.split_once(open.as_str()) {
            kept.push_str(before);
            rest = from
                .split_once(close.as_str())
                .map_or("", |(_, after)| after);
        }
        kept.push_str(rest);
        text = kept;
    }
    text_of(&text)
}

/// A news article about the case, kept for the user to read in the project.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Article {
    pub id: String,
    pub url: String,
    pub title: String,
    /// The site (KING 5, Kent Reporter).
    pub outlet: String,
    /// As the page gives it (ISO), if it does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    /// What it adds to the case, in the agent's words.
    pub summary: String,
    /// Its readable text.
    pub text: String,
}

pub fn articles(home: &Path, project: &str) -> Vec<Article> {
    std::fs::read(dir(home, project).join("articles.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Saves an article to the project (its text, title, outlet and date read
/// from the page), and puts the photos it carries into the review: they're
/// of this case, unlike most image search results. Returns the article and
/// how many photos were added.
pub fn add_article(
    home: &Path,
    project: &str,
    url: &str,
    summary: &str,
) -> Result<(Article, usize), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("give a web address (http or https)".into());
    }
    let page = article_page(url)?;
    let metas = metas(&page);
    let meta = |names: &[&str]| {
        names.iter().find_map(|name| {
            metas
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        })
    };
    let title = meta(&["og:title", "twitter:title"]).unwrap_or_else(|| {
        page.split("<title")
            .nth(1)
            .and_then(|rest| rest.split_once('>'))
            .map(|(_, rest)| text_of(rest.split("</title>").next().unwrap_or("")))
            .unwrap_or_default()
    });
    let outlet = meta(&["og:site_name", "application-name"]).unwrap_or_else(|| site(url));
    let article = Article {
        id: hex(&Sha256::digest(url.as_bytes()))
            .chars()
            .take(16)
            .collect(),
        url: url.to_owned(),
        title: title.clone(),
        outlet: outlet.clone(),
        published: meta(&["article:published_time", "datePublished", "pubdate"]),
        summary: summary.to_owned(),
        text: readable(&page).chars().take(60_000).collect(),
    };
    {
        let _guard = INDEX.lock();
        std::fs::create_dir_all(dir(home, project)).map_err(|error| error.to_string())?;
        let mut all = articles(home, project);
        all.retain(|known| known.url != article.url);
        all.push(article.clone());
        let bytes = serde_json::to_vec_pretty(&all).map_err(|error| error.to_string())?;
        crate::store::write_atomic(&dir(home, project).join("articles.json"), &bytes)
            .map_err(|error| error.to_string())?;
    }
    // Its photos: the lead image and the ones in the story itself.
    let body = page
        .split("<article")
        .nth(1)
        .map(|rest| rest.split("</article>").next().unwrap_or(rest))
        .unwrap_or(&page);
    let mut images: Vec<String> = meta(&["og:image", "twitter:image"]).into_iter().collect();
    for tag in body.split("<img").skip(1) {
        let source = attribute(&format!(" {tag}"), "src")
            .or_else(|| attribute(&format!(" {tag}"), "data-src"))
            .unwrap_or_default();
        let lower = source.to_lowercase();
        let decoration = [
            "logo", "icon", "avatar", "sprite", "pixel", "badge", ".svg", ".gif",
        ]
        .iter()
        .any(|word| lower.contains(word));
        if source.starts_with("http") && !decoration && !images.contains(&source) {
            images.push(source);
        }
    }
    images.truncate(12);
    let hits: Vec<Hit> = images
        .into_iter()
        .map(|image| (image, url.to_owned(), title.clone()))
        .collect();
    let (added, ..) = store_hits(home, project, &format!("article: {outlet}"), hits)?;
    Ok((article, added))
}

/// `<meta>` tags: (property or name, content).
fn metas(page: &str) -> Vec<(String, String)> {
    page.split("<meta")
        .skip(1)
        .filter_map(|tag| {
            let tag = format!(" {tag}");
            let key = attribute(&tag, "property")
                .or_else(|| attribute(&tag, "name"))
                .or_else(|| attribute(&tag, "itemprop"))?;
            Some((key, attribute(&tag, "content")?))
        })
        .collect()
}

fn site(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .map(|host| host.trim_start_matches("www.").to_owned())
        .unwrap_or_default()
}

/// Removes the found images with a status (new: unreviewed, rejected) and their files.
pub fn clear(home: &Path, project: &str, status: &str) -> Result<usize, String> {
    if status == "kept" {
        return Err("kept images stay (they're in the media bin)".into());
    }
    let _guard = INDEX.lock();
    let (gone, kept): (Vec<Item>, Vec<Item>) = read_index(home, project)
        .into_iter()
        .partition(|item| item.status == status);
    for item in &gone {
        let _ = std::fs::remove_file(&item.file);
    }
    write_index(home, project, &kept)?;
    Ok(gone.len())
}

/// Rejects found images (the agent's own pass before the user looks).
pub fn reject(home: &Path, project: &str, ids: &[String]) -> Result<usize, String> {
    let _guard = INDEX.lock();
    let mut items = read_index(home, project);
    let mut count = 0;
    for item in items
        .iter_mut()
        .filter(|item| ids.contains(&item.id) && item.status == "new")
    {
        item.status = "rejected".into();
        count += 1;
    }
    write_index(home, project, &items)?;
    Ok(count)
}

/// A found image shrunk into a 320×240 cell (letterboxed), for contact sheets.
pub fn thumbnail(path: &Path) -> Option<crate::render::RgbaImage> {
    let (width, height) = (320, 240);
    let output = Command::new(crate::tools::ffmpeg())
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
        ])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    (output.stdout.len() == (width * height * 4) as usize).then_some(crate::render::RgbaImage {
        width,
        height,
        pixels: output.stdout,
    })
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
        let mut collecting = COLLECTING.lock();
        if collecting.iter().any(|id| id == project) {
            return Err("already collecting images for this project; wait for it to finish".into());
        }
        collecting.push(project.to_owned());
    }
    // Released even if it crashes, or the project could never collect again.
    let result = crate::guard::catch("collecting images", || {
        collect_inner(home, project, queries, per_query)
    })
    .and_then(|result| result);
    COLLECTING.lock().retain(|id| id != project);
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
        let hits: Vec<Hit> = hits
            .into_iter()
            .filter(|(image, ..)| {
                let new = !seen.contains(image);
                if !new {
                    had += 1;
                }
                new
            })
            .collect();
        let (new, already, broken) = store_hits(home, project, query, hits)?;
        added += new;
        had += already;
        failed += broken;
    }
    Ok((added, had, failed))
}

/// Downloads hits (a few at a time) into the review: (added, already there, failed).
fn store_hits(
    home: &Path,
    project: &str,
    query: &str,
    hits: Vec<Hit>,
) -> Result<(usize, usize, usize), String> {
    let folder = dir(home, project);
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let (mut added, mut had, mut failed) = (0, 0, 0);
    for batch in hits.chunks(8) {
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
        let _guard = INDEX.lock();
        let mut index = read_index(home, project);
        for result in results {
            match result {
                Some(item)
                    if index
                        .iter()
                        .any(|known| known.id == item.id || known.image == item.image) =>
                {
                    had += 1
                }
                Some(item) => {
                    index.push(item);
                    added += 1;
                }
                None => failed += 1,
            }
        }
        write_index(home, project, &index)?;
    }
    Ok((added, had, failed))
}

/// The image results on a Bing images page: their `m` attributes.
fn image_hits(page: &str) -> Vec<Hit> {
    page.split("class=\"iusc\"")
        .skip(1)
        .filter_map(|block| {
            let meta: Value = serde_json::from_str(&attribute(block, "m")?).ok()?;
            let field = |name: &str| meta.get(name).and_then(Value::as_str);
            let image = field("murl")?.to_owned();
            image.starts_with("http").then(|| {
                (
                    image,
                    field("purl").unwrap_or_default().to_owned(),
                    field("t").unwrap_or_default().to_owned(),
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
    let output = Command::new(crate::tools::ffprobe())
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
    let (_, rest) = tag.split_once(&format!(" {name}=\""))?;
    let (value, _) = rest.split_once('"')?;
    Some(unescape(value))
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
    while let Some(&byte) = bytes.get(index) {
        let escaped = (byte == b'%')
            .then(|| bytes.get(index + 1..index + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (escaped, byte) {
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
