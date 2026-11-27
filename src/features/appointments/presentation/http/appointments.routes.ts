import express from "express";
import type { Pool } from "pg";
import { createAppointmentsController } from "./controllers/appointments.controller";

export function createAppointmentsRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = createAppointmentsController(pool);
  router.get("/calendar/availability", controller.getCalendarAvailability);
  router.put("/calendar/availability", controller.replaceCalendarAvailability);
  router.get("/appointments", controller.getAppointments);
  router.post("/appointments", controller.createAppointments);
  router.patch("/appointments/:appointmentId", controller.updateAppointmentsByAppointmentId);
  return router;
}
