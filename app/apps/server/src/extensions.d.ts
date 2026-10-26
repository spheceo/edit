// Files imported `with { type: "file" }`: Bun gives their path (inside the
// compiled binary, a path into its embedded files).

declare module "*.wav" {
  const path: string;
  export default path;
}

declare module "*.png" {
  const path: string;
  export default path;
}

declare module "*.mp3" {
  const path: string;
  export default path;
}

declare module "*.mp4" {
  const path: string;
  export default path;
}

// Markdown imported `with { type: "text" }` (the agent's text, agent.ts):
// Bun gives its contents, carried inside the compiled binary.
declare module "*.md" {
  const text: string;
  export default text;
}
