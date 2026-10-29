// Where Script mode's menus, pop-overs and selection pills open: a layer at
// the top of the page carrying Script mode's styles (writer.css is scoped to
// `.writer-root`), so a portal out of the screen's own tree still looks right.

let layer: HTMLElement | null = null;

export function portalRoot(): HTMLElement {
  if (layer === null || !layer.isConnected) {
    layer = document.createElement("div");
    layer.className = "writer-root writer-portal";
    document.body.append(layer);
  }
  return layer;
}
