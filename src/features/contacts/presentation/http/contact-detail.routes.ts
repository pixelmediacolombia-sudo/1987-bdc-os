import express from "express";
import type { Pool } from "pg";
import { ContactDetailController } from "./controllers/contact-detail.controller";

export function createContactDetailRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = new ContactDetailController(pool);
  router.patch("/contacts/:contactId", controller.updateContactsByContactId);

  router.get("/contacts/:contactId", controller.getContactsByContactId);


  return router;
}
