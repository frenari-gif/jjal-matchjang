require("dotenv").config();

const http = require("http");
const next = require("next");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");
const { handleAdminRequest, requireAdminPageSession, setupGameSocket } = require("./server/game");

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const prisma = new PrismaClient();

app.prepare().then(() => {
  const httpServer = http.createServer((req, res) => {
    const pathname = req.url ? new URL(req.url, "http://localhost").pathname : "/";

    if (req.url && req.url.startsWith("/api/admin")) {
      handleAdminRequest(req, res, prisma);
      return;
    }

    if (isProtectedAdminPage(pathname) && !requireAdminPageSession(req, res)) {
      const next = encodeURIComponent(req.url || "/admin");
      res.writeHead(302, { Location: `/admin/login?next=${next}` });
      res.end();
      return;
    }

    if (pathname === "/admin/login" && requireAdminPageSession(req, res)) {
      res.writeHead(302, { Location: "/admin" });
      res.end();
      return;
    }

    handle(req, res);
  });

  const io = new Server(httpServer, {
    cors: {
      origin: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
      methods: ["GET", "POST"]
    }
  });

  setupGameSocket(io, prisma);

  httpServer.listen(port, hostname, () => {
    console.log(`짤맞짱 dev server: http://localhost:${port}`);
  });
});

function isProtectedAdminPage(pathname) {
  if (pathname === "/admin" || pathname === "/admin/") return true;
  return pathname.startsWith("/admin/") && pathname !== "/admin/login";
}
