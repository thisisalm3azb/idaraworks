/**
 * BUILD_BIBLE §2 P8 / §19 "The hardcoded noun".
 * Domain nouns must reach the UI through the terminology resolver (doc 07), never as literals.
 * This is the Phase A tripwire; the full t()-coverage lint lands with i18n in Phase F.
 */
const BANNED = /\b(jobs?|boats?|work\s?orders?|hulls?)\b|قارب|مشروع|أمر\s?عمل/i;

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hardcoded domain nouns in UI text — use the terminology resolver (phase2/07).",
    },
    schema: [],
    messages: {
      banned:
        'Hardcoded domain noun "{{text}}" in UI text. Domain nouns come from the terminology resolver (BUILD_BIBLE §2 P8, phase2/07).',
    },
  },
  create(context) {
    const check = (node, raw) => {
      const text = String(raw ?? "");
      const match = text.match(BANNED);
      if (match) {
        context.report({ node, messageId: "banned", data: { text: match[0] } });
      }
    };
    const UI_ATTRS = new Set(["title", "label", "placeholder", "alt", "aria-label"]);
    return {
      JSXText(node) {
        check(node, node.value);
      },
      JSXAttribute(node) {
        if (
          node.name?.name &&
          UI_ATTRS.has(String(node.name.name)) &&
          node.value?.type === "Literal"
        ) {
          check(node.value, node.value.value);
        }
      },
    };
  },
};

export default rule;
