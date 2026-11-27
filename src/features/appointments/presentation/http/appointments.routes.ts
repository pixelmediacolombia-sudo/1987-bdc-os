import express from "express";
import type { Pool } from "pg";
import { AppointmentsController } from "./controllers/appointments.controller";

export function createAppointmentsRouter(pool: Pool): express.Router {
  const router = express.Router();
  const controller = new AppointmentsController(pool);
  router.get("/calendar/availability", controller.getCalendarAvailability.bind(controller));
  router.put("/calendar/availability", controller.replaceCalendarAvailability.bind(controller));
  router.get("/appointments", controller.getAppointments.bind(controller));
  router.post("/appointments", controller.createAppointments.bind(controller));
  router.patch("/appointments/:appointmentId", controller.updateAppointmentsByAppointmentId.bind(controller));
  return router;
}
