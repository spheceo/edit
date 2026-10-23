// What Edit lets an admin grant, published for accounts.spheceo.com (its plan's
// "Contract v2"): kinds of work, not infrastructure (the user: "this person can
// do subtitles, but they can't do editing"). Served at
// `GET /.well-known/spheceo-app.json`, public. Capability ids are forever:
// rename a label, never an id. Edit itself enforces them from the token's
// `perms`; the relay needs only `use`, except voice generation, which is paid.

/** apps/../assets/brand/edit-icon.svg, the app icon (a test keeps it the same file). */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect x="92" y="92" width="840" height="840" rx="188" fill="#000"/>
  <rect x="92.5" y="92.5" width="839" height="839" rx="187.5" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>
  <g transform="translate(212 212) scale(9.375)"><rect x="8" y="16" width="46" height="9.5" rx="3" fill="#5b8cff"/><rect x="8" y="29" width="30" height="9.5" rx="3" fill="#ff4f9a"/><rect x="8" y="42" width="46" height="9.5" rx="3" fill="#ffc23d"/><path d="M40.5 6.5h9a1.5 1.5 0 0 1 1.5 1.5v4.2a2 2 0 0 1-.6 1.4L47.2 17v39.5h-4.4V17l-3.2-3.4a2 2 0 0 1-.6-1.4V8a1.5 1.5 0 0 1 1.5-1.5z" fill="#000"/><path d="M41.5 8h7a.5.5 0 0 1 .5.5v3.4a1 1 0 0 1-.3.7L46 15.4V55a1 1 0 0 1-2 0V15.4l-2.7-2.8a1 1 0 0 1-.3-.7V8.5a.5.5 0 0 1 .5-.5z" fill="#fff"/></g>
</svg>
`;

export const CAPABILITIES = {
  subtitles: "video.subtitles",
  bodycam: "edit.bodycam",
  interrogation: "edit.interrogation",
  courtroom: "edit.courtroom",
  voiceover: "extra.voiceover",
} as const;

export function manifest() {
  return {
    app: "edit",
    version: 1,
    name: "Edit",
    icon: `data:image/svg+xml;base64,${btoa(ICON_SVG)}`,
    capabilities: [
      { id: CAPABILITIES.subtitles, label: "Subtitled videos", description: "Make subtitled videos from Drive footage: subtitles, speakers, mutes, export and the Drive upload.", group: "Kinds of video" },
      { id: CAPABILITIES.bodycam, label: "Bodycam edits", description: "Full edits in the bodycam style: script import, cutting, the agent, research, maps, music, export and review.", group: "Kinds of video" },
      { id: CAPABILITIES.interrogation, label: "Interrogation edits", description: "Full edits in the interrogation style.", group: "Kinds of video" },
      { id: CAPABILITIES.courtroom, label: "Courtroom edits", description: "Full edits in the courtroom style.", group: "Kinds of video" },
      { id: CAPABILITIES.voiceover, label: "Voice-overs", description: "Generate and re-voice narration with the house voice (paid). Without it, an edit's import places no voice-over.", group: "Extras" },
    ],
    presets: [
      { id: "subtitles", label: "Subtitles only", capabilities: [CAPABILITIES.subtitles] },
      { id: "editor", label: "Editor", capabilities: [CAPABILITIES.bodycam, CAPABILITIES.interrogation, CAPABILITIES.courtroom, CAPABILITIES.voiceover, CAPABILITIES.subtitles] },
      { id: "full", label: "Everything", capabilities: Object.values(CAPABILITIES) },
    ],
  };
}
