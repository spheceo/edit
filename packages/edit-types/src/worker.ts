import type { ExportOptions, Project } from "./index";

/** Control messages only; media bytes stay in R2. Not a second project model. */
export interface WorkerAsset { media: string; key: string; size: number; etag: string }
export interface WorkerManifest {
  version: 1;
  project: Project;
  options: ExportOptions;
  assets: WorkerAsset[];
}
export const WORKER_SECONDS = 1800;
export const WORKER_STARTUP_SECONDS = 300;
export const WORKER_OUTPUT_LIMIT = 16 * 1024 ** 3;
export const WORKER_INPUT_LIMIT = 128 * 1024 ** 3;
/** Published Modal Function rates, USD/second; 4 physical cores, 16 GiB RAM. */
export const WORKER_RATES = {
  L4: 0.000222 + 4 * 0.0000131 + 16 * 0.00000222,
  L40S: 0.000542 + 4 * 0.0000131 + 16 * 0.00000222,
  "RTX-PRO-6000": 0.000842 + 4 * 0.0000131 + 16 * 0.00000222,
};
export type WorkerGpu = keyof typeof WORKER_RATES;
