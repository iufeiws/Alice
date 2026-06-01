# apply_patch Character Normalization

The memory `apply_patch` tool normalizes a small set of common fullwidth
characters to halfwidth characters after a patch is applied. The same
normalization is also used when checking patch context lines, so a patch that
uses halfwidth text can match existing memory content that uses these fullwidth
variants.

Normalization is intentionally limited to the reusable
`commonHalfwidthNormalizationMap` in `core/agent/src/memory.ts`.

## Character Map

Fullwidth ASCII letters and digits are normalized:

- `Ａ-Ｚ` -> `A-Z`
- `ａ-ｚ` -> `a-z`
- `０-９` -> `0-9`

Additional characters:

| Source | Target |
| --- | --- |
| `　` | space |
| `，` | `,` |
| `。` | `.` |
| `．` | `.` |
| `：` | `:` |
| `；` | `;` |
| `？` | `?` |
| `！` | `!` |
| `（` | `(` |
| `）` | `)` |
| `【` | `[` |
| `】` | `]` |
| `［` | `[` |
| `］` | `]` |
| `｛` | `{` |
| `｝` | `}` |
| `“` | `"` |
| `”` | `"` |
| `‘` | `'` |
| `’` | `'` |
| `／` | `/` |
| `＼` | `\` |
| `＿` | `_` |
| `－` | `-` |
| `～` | `~` |
| `｜` | `|` |
| `＃` | `#` |
| `＠` | `@` |
| `＆` | `&` |
| `＊` | `*` |
| `＋` | `+` |
| `＝` | `=` |
| `＜` | `<` |
| `＞` | `>` |
