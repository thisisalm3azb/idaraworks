import type { LogoEditorLabels } from "./LogoEditor";

/** The editor's copy from the catalogue; pages pass the result to the client picker. */
export function logoEditorLabels(t: (key: string) => string): LogoEditorLabels {
  return {
    title: t("logo.editor.title"),
    zoom: t("logo.editor.zoom"),
    fit: t("logo.editor.fit"),
    fill: t("logo.editor.fill"),
    moveHint: t("logo.editor.move_hint"),
    nudgeUp: t("logo.editor.nudge_up"),
    nudgeDown: t("logo.editor.nudge_down"),
    nudgeLeft: t("logo.editor.nudge_left"),
    nudgeRight: t("logo.editor.nudge_right"),
    reset: t("logo.editor.reset"),
    use: t("logo.editor.use"),
    cancel: t("logo.editor.cancel"),
    working: t("logo.editor.working"),
    blurryWarning: t("logo.editor.blurry"),
    tooLarge: t("logo.editor.too_large"),
    unsupported: t("logo.editor.unsupported"),
    decodeFailed: t("logo.editor.decode_failed"),
    transparencyKept: t("logo.editor.transparency_kept"),
    transparencyNone: t("logo.editor.transparency_none"),
  };
}
