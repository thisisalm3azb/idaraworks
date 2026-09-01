/**
 * The HR module's public surface (BUILD_BIBLE §3.3: other modules import a
 * module only through its service.ts). HR is large enough to keep people,
 * time, leave, claims and recruitment in their own files — this file is the
 * one door other modules walk through.
 */
export * from "./people";
export * from "./time";
export * from "./leave";
export * from "./claims";
export * from "./recruitment";
