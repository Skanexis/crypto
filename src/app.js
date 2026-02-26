const path = require("path");
const express = require("express");
const apiRoutes = require("./routes/api.routes");
const telegramRoutes = require("./routes/telegram.routes");

const app = express();
const publicDir = path.join(__dirname, "public");

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      req.rawBody = buffer.toString("utf8");
    },
  }),
);
app.use(
  express.urlencoded({
    extended: true,
  }),
);

app.use("/static", express.static(publicDir, { maxAge: "1h" }));
app.use("/api", apiRoutes);
app.use("/telegram", telegramRoutes);

app.get("/", (_req, res) => {
  res.redirect("/admin");
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.get("/pay/:token", (_req, res) => {
  res.sendFile(path.join(publicDir, "invoice.html"));
});

app.use((error, _req, res, _next) => {
  const status = error.statusCode || 400;
  res.status(status).json({
    error: "Bad Request",
    message: error.message || "Errore non previsto",
  });
});

module.exports = app;
