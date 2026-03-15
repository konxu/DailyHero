import express from "express";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;
app.get("/api/health", (req, res) => {
    res.send("OK");
  });

  app.use(express.json());

  // API Route for Health Check
  app.get("/api/health", (req, res) => {
  res.send("Server is alive! Time: " + new Date().toISOString());
});

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    if (!fs.existsSync(distPath)) {
      console.error("错误：找不到 dist 目录！请确保执行了 npm run build");
    }

    app.use(express.static(distPath));

    app.get("*", (req, res) => {
      const indexPath = path.join(distPath, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(500).send("前端文件未生成，请检查构建日志。");
      }
    });
    app.get("/api/config", (req, res) => {
  res.json({
    apiKey: process.env.GEMINI_API_KEY
  });
});
    
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`服务器已在端口 ${PORT} 启动`);
  });
}

startServer().catch(err => {
  console.error("服务器启动失败:", err);
});
