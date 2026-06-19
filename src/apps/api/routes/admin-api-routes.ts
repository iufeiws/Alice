import type { AdminRoutesContext } from "../bootstrap/admin-route-context.js";

export async function handleAdminApiRoute(context: AdminRoutesContext, request: any, response: any): Promise<void> {
  await context.services.handleApiRoute(request, response);
}
