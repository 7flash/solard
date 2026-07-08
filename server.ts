import { serve } from "tradjs";
import { logSolardBootConfigOnce } from "./src/solard/config.js";

logSolardBootConfigOnce();

await serve();
