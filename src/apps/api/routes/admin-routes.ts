import { assertLoopbackAdminRequest } from "../middleware/http-utils.js";
import { handleHttpError, writeHtml } from "./admin-http.js";
import { handleAdminApiRoute } from "./admin-api-routes.js";
import type { AdminRoutesContext } from "../bootstrap/admin-route-context.js";
export type { AdminRoutesContext } from "../bootstrap/admin-route-context.js";
import { renderAdminHtmlV2 } from "../admin-ui/admin-html.js";
import { handleVoiceCallRoute } from "./voice-call-routes.js";

export function createApiRequestHandler(context: AdminRoutesContext) {
  return async (request: any, response: any) => {
    try {
      assertLoopbackAdminRequest(request);

      if (request.method === "GET" && request.url === "/admin") {
        writeHtml(response, 200, renderAdminHtmlV2());
        return;
      }

      if (handleVoiceCallRoute(request, response)) {
        return;
      }

      await handleAdminApiRoute(context, request, response);

    } catch (error) {
      handleHttpError(context.services, response, error);
    }
  };
}
