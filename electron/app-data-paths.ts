import os from "node:os";
import { join } from "node:path";

export const APP_DATA_DIR = join(os.homedir(), ".shotshot");
export const APP_SKILLS_DIR = join(APP_DATA_DIR, "skills");
export const AGENT_SESSIONS_DIR = join(APP_DATA_DIR, "agent-sessions");
export const MIGRATION_MARKER = join(AGENT_SESSIONS_DIR, "legacy-local-storage-v1.json");
