// Every input in the app kept away from macOS's Siri and dictation offers
// (Sphe, Nov 3: "i really hate this siri thing on mac… let's try to have ALL
// our inputs across our ENTIRE app not trigger it"): the fields themselves
// say no autocorrect, no capitalising, no autocomplete suggestions, and an
// Fn/Globe keypress that reaches the page is swallowed rather than handed
// on. What a page cannot do is take the system's own Dictation shortcut
// away — that one lives in System Settings, Keyboard, Dictation.
//
// Applied on focus and to whatever is added later, so a field made after
// load (a dialog's, a chat's) is covered without each input saying so.

type Quietable = { setAttribute(name: string, value: string): void };

/** One field's attributes set quiet; spell-check is left as its author set it. */
export function quietInput(field: Quietable): void {
  field.setAttribute("autocorrect", "off");
  field.setAttribute("autocapitalize", "off");
  field.setAttribute("autocomplete", "off");
}

const FIELDS = "input, textarea, [contenteditable]";

function quietWithin(root: ParentNode): void {
  for (const field of root.querySelectorAll(FIELDS)) quietInput(field);
}

/** Quiet every input in the app, now and as more are made, and keep Fn here. */
export function installQuietInputs(): void {
  quietWithin(document);
  document.addEventListener(
    "focusin",
    (event) => {
      const field = event.target;
      if (field instanceof HTMLElement && field.matches(FIELDS)) quietInput(field);
    },
    true,
  );
  new MutationObserver((records) => {
    for (const record of records)
      for (const added of record.addedNodes) {
        if (!(added instanceof HTMLElement)) continue;
        if (added.matches(FIELDS)) quietInput(added);
        quietWithin(added);
      }
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Fn" || event.key === "Globe") {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
}
