export type NotesIndexEntry = {
  name: string;
  description: string;
  path: string;
};

export function formatNotesXml(notes: NotesIndexEntry[], tag = "notes"): string {
  if (notes.length === 0) return `<${tag}>\n</${tag}>`;
  return [
    `<${tag}>`,
    ...notes.map((note) => [
      "  <note>",
      `    <name>${escapeXml(note.name)}</name>`,
      `    <description>${escapeXml(note.description)}</description>`,
      `    <path>${escapeXml(note.path)}</path>`,
      "  </note>"
    ].join("\n")),
    `</${tag}>`
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
