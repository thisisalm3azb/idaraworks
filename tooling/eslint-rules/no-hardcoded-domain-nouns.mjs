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
      // Review finding #6: string/template literals rendered as JSX children
      // ({"All jobs"} / {`...`}) previously escaped the tripwire.
      // S1: attribute VALUES only count for UI attrs — href/className route
      // paths legitimately contain segment names like /jobs (URLs are chrome,
      // doc 07); user-visible children remain fully checked.
      JSXExpressionContainer(node) {
        if (
          node.parent?.type === "JSXAttribute" &&
          !UI_ATTRS.has(String(node.parent.name?.name ?? ""))
        ) {
          return;
        }
        const expr = node.expression;
        if (expr?.type === "Literal" && typeof expr.value === "string") {
          check(expr, expr.value);
        } else if (expr?.type === "TemplateLiteral") {
          for (const quasi of expr.quasis) {
            check(quasi, quasi.value?.raw);
          }
        }
      },
    };
  },
};

export default rule;
