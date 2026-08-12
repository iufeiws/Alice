import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNotesXml } from "../../../src/contexts/skills/src/index.js";

test("formatNotesXml renders name/description/path per note and escapes XML", () => {
  const xml = formatNotesXml([
    { name: "feishu-sending", description: "发送要点", path: "/notes/feishu-sending.md" },
    { name: "b <tag>", description: "B & C", path: "/notes/b&c.md" }
  ]);
  assert.equal(
    xml,
    [
      "<notes>",
      "  <note>",
      "    <name>feishu-sending</name>",
      "    <description>发送要点</description>",
      "    <path>/notes/feishu-sending.md</path>",
      "  </note>",
      "  <note>",
      "    <name>b &lt;tag&gt;</name>",
      "    <description>B &amp; C</description>",
      "    <path>/notes/b&amp;c.md</path>",
      "  </note>",
      "</notes>"
    ].join("\n")
  );
});

test("formatNotesXml renders an empty notes tag for no entries", () => {
  assert.equal(formatNotesXml([]), "<notes>\n</notes>");
});
