// `edit`: the command (cli.ts). A dev run is `bun apps/server/src/main.ts serve`;
// the release binary's entry is the generated `embedded.gen.ts`, which
// registers the files it carries and then imports this. Either way argv is
// [bun, <script>, …the arguments].

import { main } from "./cli.ts";

await main(process.argv.slice(2));
