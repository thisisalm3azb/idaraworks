/** Agent substrate (H12 / A1) — see docs/architecture/ROLE_AWARE_AGENT_ARCHITECTURE.md. */
export * from "./registry";
export * from "./contract";
export * from "./provider";
export * from "./context";
export * from "./gate";
export * from "./approval";
export { runAgent, runAgentCore, type AgentDeps, type AgentToolHandler } from "./run";
