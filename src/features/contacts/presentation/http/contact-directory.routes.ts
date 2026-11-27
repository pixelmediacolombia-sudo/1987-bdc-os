import express from "express";
import type { Pool } from "pg";
import { ContactDirectoryController } from "./controllers/contact-directory.controller";

export function createContactDirectoryRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = new ContactDirectoryController(pool);
  router.get("/contacts/dealers", controller.getContactsDealers.bind(controller));

  router.get("/contacts", controller.getContacts.bind(controller));

  router.post("/contacts", controller.createContacts.bind(controller));


  return router;
}
