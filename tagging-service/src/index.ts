import express from "express";
import tagRouter from "./controller.js";
import { startCronJobs } from "./cron.js";
import { createContractsRouter } from "./contracts.controller.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3002", 10);

app.use(express.json());
app.use(tagRouter);
app.use("/api/contracts", createContractsRouter());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "tagging-service" });
});

app.listen(PORT, () => {
  console.log(`tagging-service running on port ${PORT}`);
  startCronJobs();
});
