/** Loads .env.local (dev secrets) then .env for tooling scripts and tests. */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
