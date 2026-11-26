import express from "express";
import type { Pool } from "pg";
import { createSessionRoutes } from "./routes/session.routes";
import { createAdminOverviewRoutes } from "./routes/admin-overview.routes";
import { createAdminDealerRoutes } from "./routes/admin-dealer.routes";
import { createAdminDealerMutationRoutes } from "./routes/admin-dealer-mutations.routes";
import { createInvitationRoutes } from "./routes/invitation.routes";
import { createContactsRouter } from "@/features/contacts/presentation/http/contacts.routes";
import { createOpportunitiesRouter } from "@/features/opportunities/presentation/http/opportunities.routes";
import { createAppointmentsRouter } from "@/features/appointments/presentation/http/appointments.routes";
import type { IdentityRouteOptions } from "./routes/route-helpers";

export function createIdentityRouter(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  router.use(createSessionRoutes(pool, options));
  router.use(createAdminOverviewRoutes(pool, options));
  router.use(createAdminDealerRoutes(pool, options));
  router.use(createAdminDealerMutationRoutes(pool, options));
  router.use(createInvitationRoutes(pool, options));
  router.use(createContactsRouter(pool, options.conversationReplySender));
  router.use(createOpportunitiesRouter(pool));
  router.use(createAppointmentsRouter(pool));
  return router;
}

