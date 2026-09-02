/**
 * H26 — the condition evaluator lives in the platform (pure, browser-safe) so
 * public pages can evaluate conditional sections without server code. The
 * module re-exports it with the document vocabulary.
 */
export { evaluateConditions, lookupValue, type ConditionValues } from "@/platform/rules/conditions";
