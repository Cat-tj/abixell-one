import type { DemoCtx } from "./harness.js";
import { run as foundation } from "./foundation.js";
import { run as commercial } from "./commercial.js";
import { run as serviceOps } from "./service-ops.js";
import { run as complaintsSurveys } from "./complaints-surveys.js";
import { run as workforce } from "./workforce.js";
import { run as supplyChain } from "./supply-chain.js";
import { run as asset } from "./asset.js";
import { run as hse } from "./hse.js";
import { run as projects } from "./projects.js";
import { run as finance } from "./finance.js";

/** Run order matters: foundation first, finance last (it may close past periods). */
export const SECTORS: { key: string; run: (ctx: DemoCtx) => Promise<void> }[] = [
  { key: "foundation", run: foundation },
  { key: "commercial", run: commercial },
  { key: "service-ops", run: serviceOps },
  { key: "complaints-surveys", run: complaintsSurveys },
  { key: "workforce", run: workforce },
  { key: "supply-chain", run: supplyChain },
  { key: "asset", run: asset },
  { key: "hse", run: hse },
  { key: "projects", run: projects },
  { key: "finance", run: finance },
];
