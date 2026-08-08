import { test } from "node:test";
import { assertExcludesAll, assertIncludesAll, renderAdminHtml } from "./admin-html-helpers.js";

test("adminLayout_initialRender_exposesPrimaryNavigation", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "<title>Alice Admin</title>",
    ">Prompt</button>",
    ">Shell</button>",
    ">LLM Sessions</button>",
    ">Token Usage</button>",
    ">Memory</button>",
    ">Plugin</button>",
    ">Initiated Behaviors</button>",
    ">Tool Preview</button>"
  ]);
});

test("adminSidebar_initialRender_exposesSettingsSections", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "LLM Settings",
    "Channel Settings",
    "Alice Core",
    "Agent Settings",
    "Messaging Tools",
    "Unique Bound Contact"
  ]);
});

test("adminSidebar_initialRender_omitsDeprecatedTtsControls", () => {
  const html = renderAdminHtml();

  assertExcludesAll(html, [
    'id="tts-reference-status"',
    'id="ttsReferenceAudio"',
    'id="ttsReferenceText"',
    'id="tts-upload-reference"',
    'id="ttsPreviewText"',
    'id="tts-generate-preview"',
    'id="ttsPreviewAudio"',
    "/admin/api/tts/reference-audio",
    "/admin/api/tts/generate"
  ]);
});

test("feishu account editor converts the API account record into rows", () => {
  const html = renderAdminHtml();

  assertIncludesAll(html, [
    "Array.isArray(accounts)",
    "Object.entries(accounts).map(([id, account])",
    "Account ID<input",
    "App Secret<input",
    ".feishu-account-row { display: grid;"
  ]);
});
