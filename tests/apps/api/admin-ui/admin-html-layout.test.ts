import { test } from "node:test";
import { assertIncludesAll, renderAdminHtml } from "./admin-html-helpers.js";

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
