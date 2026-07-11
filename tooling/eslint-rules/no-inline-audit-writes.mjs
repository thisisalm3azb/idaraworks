/**
 * BUILD_BIBLE §4 item 5 / §19 "the unlogged mutation".
 * audit_log and activity are written ONLY through the command path
 * (src/platform/audit). Any other module that inlines the insert bypasses the
 * atomic single-writer guarantee. Catches the insert in string OR tagged-template
 * (sql`...`) form. Applied everywhere except src/platform/audit (config ignore).
 */
const BANNED = /insert\s+into\s+public\.(audit_log|activity)\b/i;

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow inline inserts into audit_log/activity — use the command path (src/platform/audit).",
    },
    schema: [],
    messages: {
      inline:
        "Only src/platform/audit (the command path) may write audit_log/activity — use command()/recordActivity, never an inline insert (BUILD_BIBLE §4, §19).",
    },
  },
  create(context) {
    const check = (node, raw) => {
      if (BANNED.test(String(raw ?? ""))) {
        context.report({ node, messageId: "inline" });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value?.raw ?? node.value?.cooked);
      },
    };
  },
};

export default rule;
