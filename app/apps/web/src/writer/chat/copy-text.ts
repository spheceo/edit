/**
 * Copies text and says whether it worked. The clipboard API only exists on
 * secure pages (HTTPS or localhost), so a development server opened by its
 * network name falls back to copying from a hidden field.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused or unavailable: try the older way below.
  }
  const field = document.createElement("textarea");
  field.value = text;
  // Kept off screen and out of the keyboard's way while it is selected.
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  const focused = document.activeElement as HTMLElement | null;
  try {
    field.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    focused?.focus();
  }
}
