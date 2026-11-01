// `edit`: the command (cli.ts). A dev run is `bun apps/server/src/main.ts serve`;
// the release binary's entry is the generated `embedded.gen.ts`, which
// registers the files it carries and then imports this. Either way argv is
// [bun, <script>, …the arguments].

// An e-code script's sandbox (`script-eval`, started by run_edit) loads only its
// own two files, not the whole server: under load the full import took most
// of a script's 20 s (E2, Oct 31: `note("hi")` timed out three times).
if (process.argv[2] === "script-eval") {
  const { main: scriptEval } = await import("./script_eval.ts");
  await scriptEval().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1); });
} else {
  const { main } = await import("./cli.ts");
  await main(process.argv.slice(2));
}
