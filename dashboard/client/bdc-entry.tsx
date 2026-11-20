/// <reference path="./vite-env.d.ts" />
import React from "react";
import { createRoot } from "react-dom/client";
import BdcDashboard from "./bdc-page";
import "./bdc.css";

const root = document.getElementById("root");
if (!root) throw new Error("BDC OS dashboard root is missing");
createRoot(root).render(<BdcDashboard />);
