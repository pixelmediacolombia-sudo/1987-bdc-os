import express from "express";
import type { Pool } from "pg";
import { createContactDirectoryController } from "./controllers/contact-directory.controller";

export function createContactDirectoryRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = createContactDirectoryController(pool);
  router.get("/contacts/dealers", controller.getContactsDealers);

  router.get("/contacts", controller.getContacts);

  router.post("/contacts", controller.createContacts);


  return router;
}
