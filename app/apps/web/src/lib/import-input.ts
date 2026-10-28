/** A project name stays a name; known source URLs open the import preview. */
export const hasImportLinks = (text: string) => /https?:\/\/(?:www\.)?(?:docs\.google\.com\/document\/d\/|drive\.google\.com\/(?:file\/d\/|drive\/|open\?|uc\?)|(?:youtube\.com|youtu\.be)\/|trello\.com\/c\/|feedback\.spheceo\.com\/r\/)/iu.test(text);

/** Rich clipboard links must retain their targets, not only Trello's labels. */
export function importPaste(html: string, plain: string): string {
  if (!html || typeof DOMParser === "undefined") return plain;
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (![...doc.querySelectorAll("a[href]")].some((node) => hasImportLinks(node.getAttribute("href") ?? ""))) return plain;
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? "";
    if (!(node instanceof Element)) return [...node.childNodes].map(walk).join("");
    if (["SCRIPT", "STYLE"].includes(node.tagName)) return "";
    const content = [...node.childNodes].map(walk).join("");
    if (node.tagName === "A") return `[${content}](${node.getAttribute("href") ?? ""})`;
    if (node.tagName === "BR") return "\n";
    return content + (["P", "DIV", "LI", "H1", "H2", "H3"].includes(node.tagName) ? "\n" : "");
  };
  return walk(doc.body).trim();
}
