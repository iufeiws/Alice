export function renderDomScript(): string {
  return `      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
      }

      function escapeAttr(value) { return escapeHtml(value); }

      function cssEscape(value) { return String(value).replace(/["\\\\]/g, "\\\\$&"); }

      function valueAtPath(object, key) {
        return String(key || "").split(".").reduce((value, part) => value && typeof value === "object" ? value[part] : undefined, object);
      }

      function setValueAtPath(object, key, value) {
        const parts = String(key || "").split(".").filter(Boolean);
        let cursor = object;
        parts.forEach((part, index) => {
          if (index === parts.length - 1) {
            cursor[part] = value;
            return;
          }
          cursor[part] = cursor[part] && typeof cursor[part] === "object" ? cursor[part] : {};
          cursor = cursor[part];
        });
      }
`;
}
