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
 app.get("/api/health", (req, res) => res.send("OK"));
app.get("/api/config", (req, res) => res.json({ apiKey: process.env.GEMINI_API_KEY }));

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const path = await import("path");
    const fs = await import("fs");
    
    // 使用 resolve 确保路径从根目录开始
    const distPath = path.resolve("dist");
    
    // --- 调试日志：这能告诉我们 dist 到底在不在 ---
    console.log("当前工作目录:", process.cwd());
    console.log("尝试读取的 dist 路径:", distPath);
    if (fs.existsSync(distPath)) {
      console.log("dist 文件夹内容:", fs.readdirSync(distPath));
    } else {
      console.error("致命错误：dist 文件夹不存在！");
    }
    // -------------------------------------------

    // 1. 静态文件中间件（必须在通配符路由之前）
    app.use(express.static(distPath));

    // 2. 通配符路由
    app.get("*", (req, res) => {
      const indexPath = path.join(distPath, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(500).send("服务器错误：找不到 index.html。请检查构建日志。");
      }
    });
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`服务器已在端口 ${PORT} 启动`);
  });
}

startServer().catch(err => {
  console.error("服务器启动失败:", err);
});
