// Which preview picture to stream: the full preview (≤1080p, ~5 Mbit/s) on
// the Mac running Edit, the light one (720p, ~1.5 Mbit/s) from another
// machine. Chosen for you; there's no setting.

import { isLocal } from "./api";

/** Whether to stream the light preview (when it's ready). */
export const wantsLight = !isLocal;
