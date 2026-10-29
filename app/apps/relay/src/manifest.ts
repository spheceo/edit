// What Edit lets an admin grant, published for accounts.spheceo.com (its plan's
// "Contract v2"): kinds of work, not infrastructure (the user: "this person can
// do subtitles, but they can't do editing"). Served at
// `GET /.well-known/spheceo-app.json`, public. Capability ids are forever:
// rename a label, never an id. Edit itself enforces them from the token's
// `perms`; the relay needs only `use`, except voice generation, which is paid
// and comes with editing (the user: "if someone has the permission to edit,
// say bodycam, they should get full perms around voice generation"): any
// `edit.*` capability.

/** apps/../assets/brand/edit-icon.svg, the app icon (a test keeps it the same file). */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true"><defs><mask id="t2m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>
    <rect x="8" y="16" width="46" height="9.5" rx="3" fill="#fff"/><rect x="8" y="29" width="30" height="9.5" rx="3" fill="#fff"/><rect x="8" y="42" width="46" height="9.5" rx="3" fill="#fff"/>
    <path d="M40.5 6.5h9a1.5 1.5 0 0 1 1.5 1.5v4.2a2 2 0 0 1-.6 1.4L47.2 17v39.5h-4.4V17l-3.2-3.4a2 2 0 0 1-.6-1.4V8a1.5 1.5 0 0 1 1.5-1.5z" fill="#000"/>
    <path d="M41.5 8h7a.5.5 0 0 1 .5.5v3.4a1 1 0 0 1-.3.7L46 15.4V55a1 1 0 0 1-2 0V15.4l-2.7-2.8a1 1 0 0 1-.3-.7V8.5a.5.5 0 0 1 .5-.5z" fill="#fff"/></mask><filter id="t2f" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy="0.6" stdDeviation="0.7" flood-color="#000" flood-opacity="0.35"/></filter></defs>
  <g filter="url(#t2f)"><path d="M57.75 32L57.74 38.45L57.73 40.51L57.7 42.01L57.67 43.22L57.62 44.26L57.57 45.18L57.5 46L57.42 46.76L57.34 47.45L57.24 48.1L57.13 48.7L57.01 49.27L56.88 49.8L56.74 50.3L56.59 50.78L56.43 51.23L56.25 51.66L56.06 52.06L55.87 52.45L55.66 52.82L55.43 53.17L55.2 53.51L54.95 53.82L54.69 54.13L54.42 54.42L54.13 54.69L53.82 54.95L53.51 55.2L53.17 55.43L52.82 55.66L52.45 55.87L52.06 56.06L51.66 56.25L51.23 56.43L50.78 56.59L50.3 56.74L49.8 56.88L49.27 57.01L48.7 57.13L48.1 57.24L47.45 57.34L46.76 57.42L46 57.5L45.18 57.57L44.26 57.62L43.22 57.67L42.01 57.7L40.51 57.73L38.45 57.74L32 57.75L25.55 57.74L23.49 57.73L21.99 57.7L20.78 57.67L19.74 57.62L18.82 57.57L18 57.5L17.24 57.42L16.55 57.34L15.9 57.24L15.3 57.13L14.73 57.01L14.2 56.88L13.7 56.74L13.22 56.59L12.77 56.43L12.34 56.25L11.94 56.06L11.55 55.87L11.18 55.66L10.83 55.43L10.49 55.2L10.18 54.95L9.87 54.69L9.58 54.42L9.31 54.13L9.05 53.82L8.8 53.51L8.57 53.17L8.34 52.82L8.13 52.45L7.94 52.06L7.75 51.66L7.57 51.23L7.41 50.78L7.26 50.3L7.12 49.8L6.99 49.27L6.87 48.7L6.76 48.1L6.66 47.45L6.58 46.76L6.5 46L6.43 45.18L6.38 44.26L6.33 43.22L6.3 42.01L6.27 40.51L6.26 38.45L6.25 32L6.26 25.55L6.27 23.49L6.3 21.99L6.33 20.78L6.38 19.74L6.43 18.82L6.5 18L6.58 17.24L6.66 16.55L6.76 15.9L6.87 15.3L6.99 14.73L7.12 14.2L7.26 13.7L7.41 13.22L7.57 12.77L7.75 12.34L7.94 11.94L8.13 11.55L8.34 11.18L8.57 10.83L8.8 10.49L9.05 10.18L9.31 9.87L9.58 9.58L9.87 9.31L10.18 9.05L10.49 8.8L10.83 8.57L11.18 8.34L11.55 8.13L11.94 7.94L12.34 7.75L12.77 7.57L13.22 7.41L13.7 7.26L14.2 7.12L14.73 6.99L15.3 6.87L15.9 6.76L16.55 6.66L17.24 6.58L18 6.5L18.82 6.43L19.74 6.38L20.78 6.33L21.99 6.3L23.49 6.27L25.55 6.26L32 6.25L38.45 6.26L40.51 6.27L42.01 6.3L43.22 6.33L44.26 6.38L45.18 6.43L46 6.5L46.76 6.58L47.45 6.66L48.1 6.76L48.7 6.87L49.27 6.99L49.8 7.12L50.3 7.26L50.78 7.41L51.23 7.57L51.66 7.75L52.06 7.94L52.45 8.13L52.82 8.34L53.17 8.57L53.51 8.8L53.82 9.05L54.13 9.31L54.42 9.58L54.69 9.87L54.95 10.18L55.2 10.49L55.43 10.83L55.66 11.18L55.87 11.55L56.06 11.94L56.25 12.34L56.43 12.77L56.59 13.22L56.74 13.7L56.88 14.2L57.01 14.73L57.13 15.3L57.24 15.9L57.34 16.55L57.42 17.24L57.5 18L57.57 18.82L57.62 19.74L57.67 20.78L57.7 21.99L57.73 23.49L57.74 25.55Z" fill="#0a0a0a"/></g>
  <g transform="translate(6.25 6.25) scale(0.8046875)"><g transform="translate(10.023 9.314) scale(0.7089)"><g mask="url(#t2m)">
    <rect x="8" y="16" width="46" height="9.5" rx="3" fill="#5b8cff"/><rect x="8" y="29" width="30" height="9.5" rx="3" fill="#ff4f9a"/><rect x="8" y="42" width="46" height="9.5" rx="3" fill="#ffc23d"/>
    <path d="M40.5 6.5h9a1.5 1.5 0 0 1 1.5 1.5v4.2a2 2 0 0 1-.6 1.4L47.2 17v39.5h-4.4V17l-3.2-3.4a2 2 0 0 1-.6-1.4V8a1.5 1.5 0 0 1 1.5-1.5z" fill="transparent"/>
    <path d="M41.5 8h7a.5.5 0 0 1 .5.5v3.4a1 1 0 0 1-.3.7L46 15.4V55a1 1 0 0 1-2 0V15.4l-2.7-2.8a1 1 0 0 1-.3-.7V8.5a.5.5 0 0 1 .5-.5z" fill="#ffffff"/></g></g></g>
  
  <path d="M57.58 32L57.57 38.41L57.55 40.45L57.53 41.94L57.49 43.14L57.45 44.18L57.39 45.09L57.33 45.91L57.25 46.66L57.16 47.35L57.07 47.99L56.96 48.59L56.84 49.15L56.71 49.68L56.57 50.18L56.42 50.65L56.26 51.1L56.09 51.52L55.9 51.93L55.7 52.31L55.5 52.68L55.28 53.03L55.04 53.36L54.8 53.68L54.54 53.98L54.26 54.26L53.98 54.54L53.68 54.8L53.36 55.04L53.03 55.28L52.68 55.5L52.31 55.7L51.93 55.9L51.52 56.09L51.1 56.26L50.65 56.42L50.18 56.57L49.68 56.71L49.15 56.84L48.59 56.96L47.99 57.07L47.35 57.16L46.66 57.25L45.91 57.33L45.09 57.39L44.18 57.45L43.14 57.49L41.94 57.53L40.45 57.55L38.41 57.57L32 57.58L25.59 57.57L23.55 57.55L22.06 57.53L20.86 57.49L19.82 57.45L18.91 57.39L18.09 57.33L17.34 57.25L16.65 57.16L16.01 57.07L15.41 56.96L14.85 56.84L14.32 56.71L13.82 56.57L13.35 56.42L12.9 56.26L12.48 56.09L12.07 55.9L11.69 55.7L11.32 55.5L10.97 55.28L10.64 55.04L10.32 54.8L10.02 54.54L9.74 54.26L9.46 53.98L9.2 53.68L8.96 53.36L8.72 53.03L8.5 52.68L8.3 52.31L8.1 51.93L7.91 51.52L7.74 51.1L7.58 50.65L7.43 50.18L7.29 49.68L7.16 49.15L7.04 48.59L6.93 47.99L6.84 47.35L6.75 46.66L6.67 45.91L6.61 45.09L6.55 44.18L6.51 43.14L6.47 41.94L6.45 40.45L6.43 38.41L6.43 32L6.43 25.59L6.45 23.55L6.47 22.06L6.51 20.86L6.55 19.82L6.61 18.91L6.67 18.09L6.75 17.34L6.84 16.65L6.93 16.01L7.04 15.41L7.16 14.85L7.29 14.32L7.43 13.82L7.58 13.35L7.74 12.9L7.91 12.48L8.1 12.07L8.3 11.69L8.5 11.32L8.72 10.97L8.96 10.64L9.2 10.32L9.46 10.02L9.74 9.74L10.02 9.46L10.32 9.2L10.64 8.96L10.97 8.72L11.32 8.5L11.69 8.3L12.07 8.1L12.48 7.91L12.9 7.74L13.35 7.58L13.82 7.43L14.32 7.29L14.85 7.16L15.41 7.04L16.01 6.93L16.65 6.84L17.34 6.75L18.09 6.67L18.91 6.61L19.82 6.55L20.86 6.51L22.06 6.47L23.55 6.45L25.59 6.43L32 6.43L38.41 6.43L40.45 6.45L41.94 6.47L43.14 6.51L44.18 6.55L45.09 6.61L45.91 6.67L46.66 6.75L47.35 6.84L47.99 6.93L48.59 7.04L49.15 7.16L49.68 7.29L50.18 7.43L50.65 7.58L51.1 7.74L51.52 7.91L51.93 8.1L52.31 8.3L52.68 8.5L53.03 8.72L53.36 8.96L53.68 9.2L53.98 9.46L54.26 9.74L54.54 10.02L54.8 10.32L55.04 10.64L55.28 10.97L55.5 11.32L55.7 11.69L55.9 12.07L56.09 12.48L56.26 12.9L56.42 13.35L56.57 13.82L56.71 14.32L56.84 14.85L56.96 15.41L57.07 16.01L57.16 16.65L57.25 17.34L57.33 18.09L57.39 18.91L57.45 19.82L57.49 20.86L57.53 22.06L57.55 23.55L57.57 25.59Z" fill="none" stroke="#ffffff1a" stroke-width="0.35"/>
</svg>`;

export const CAPABILITIES = {
  subtitles: "video.subtitles",
  bodycam: "edit.bodycam",
  interrogation: "edit.interrogation",
  courtroom: "edit.courtroom",
  commentary: "edit.commentary",
  shorts: "edit.shorts",
} as const;

/** Whether a capability id is one of the edit styles (voice-overs come with any of them). */
export function isEditing(id: string): boolean {
  return id.startsWith("edit.");
}

export function manifest() {
  return {
    app: "edit",
    version: 1,
    name: "Edit",
    icon: `data:image/svg+xml;base64,${btoa(ICON_SVG)}`,
    capabilities: [
      { id: CAPABILITIES.subtitles, label: "Subtitled videos", description: "Make subtitled videos from Drive footage: subtitles, speakers, mutes, export and the Drive upload.", group: "Kinds of video" },
      { id: CAPABILITIES.bodycam, label: "Bodycam edits", description: "Full edits in the bodycam style: script import, cutting, voice-overs, the agent, research, maps, music, export and review.", group: "Kinds of video" },
      { id: CAPABILITIES.interrogation, label: "Interrogation edits", description: "Full edits in the interrogation style, voice-overs included.", group: "Kinds of video" },
      { id: CAPABILITIES.courtroom, label: "Courtroom edits", description: "Full edits in the courtroom style, voice-overs included.", group: "Kinds of video" },
      { id: CAPABILITIES.commentary, label: "Commentary edits", description: "Narrated video essays, source clips, researched B-roll and motion graphics, voice-overs included.", group: "Kinds of video" },
      { id: CAPABILITIES.shorts, label: "Shorts", description: "9:16 YouTube Shorts: a video's highlights cut to 45–60 seconds, reframed, subtitled and scored.", group: "Kinds of video" },
    ],
    presets: [
      { id: "subtitles", label: "Subtitles only", capabilities: [CAPABILITIES.subtitles] },
      { id: "editor", label: "Editor", capabilities: [CAPABILITIES.bodycam, CAPABILITIES.interrogation, CAPABILITIES.courtroom, CAPABILITIES.commentary, CAPABILITIES.shorts, CAPABILITIES.subtitles] },
      { id: "full", label: "Everything", capabilities: Object.values(CAPABILITIES) },
    ],
  };
}
