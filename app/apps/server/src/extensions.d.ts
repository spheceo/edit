// Files imported `with { type: "file" }`: Bun gives their path (inside the
// compiled binary, a path into its embedded files).

declare module "*.wav" {
  const path: string;
  export default path;
}
