import { renderAdminLayout } from "./layout.js";
import { renderAdminScript } from "./scripts/admin-script.js";
import { renderAdminStyles } from "./styles.js";

export function renderAdminHtmlV2(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Alice Admin</title>
    <style>
${renderAdminStyles()}
    </style>
  </head>
  <body>
${renderAdminLayout()}
    <script>
${renderAdminScript()}
    </script>
  </body>
</html>`;
}
