// backend/server.js
//
// 进程入口：只负责把 app 跑起来、把启动信息打清楚、优雅退出。
//
// 端口优先级：环境变量 PORT > config.json 里的 server.port。
// 注意 config.json 里默认是 5500，和 .env 的 VITE_API_BASE_URL、
// frontend/vite.config.js 的代理目标保持一致，三者不能各说各话。

const app = require('./app');

const configManager = app.locals.configManager;
const logger = app.locals.logger;

const port = Number(process.env.PORT) || configManager.get('server.port') || 5500;
const host = process.env.HOST || configManager.get('server.host') || '127.0.0.1';

const server = app.listen(port, host, () => {
  const assetRoot = app.locals.assetServer.root();
  const platforms = app.locals.assetServer.listPlatforms();

  console.log('');
  console.log('  热更新模拟器已启动');
  console.log(`  本机地址   http://localhost:${port}`);
  console.log(`  接口文档   http://localhost:${port}/docs`);
  console.log(`  使用手册   http://localhost:${port}/manual.md`);
  console.log(`  配置文件   ${configManager.configPath}`);
  console.log(`  资产目录   ${assetRoot}`);
  console.log(`  可用平台   ${platforms.length ? platforms.join(', ') : '（空，请把热更包放进资产目录）'}`);

  if (host === '0.0.0.0' || host === '::') {
    console.warn('');
    console.warn('  ⚠ 正在监听所有网络接口。控制类接口没有认证，');
    console.warn('    同局域网内的任何机器都能读写模拟参数、注入故障、读取全部请求日志。');
    console.warn('    只在需要给真机联调时这样用，用完改回 127.0.0.1。');
  }
  console.log('');
  logger.log({ message: `服务器已启动，监听 ${host}:${port}` });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${port} 已被占用。`);
    console.error('改端口有两种方式：');
    console.error('  1. 设置环境变量，例如 set PORT=5600 && npm start');
    console.error(`  2. 修改 ${configManager.configPath} 里的 server.port`);
    console.error('（同时记得改 .env 的 VITE_API_BASE_URL，否则前端代理会指错地方）\n');
  } else {
    console.error('启动失败：', err);
  }
  process.exit(1);
});

/** 优雅退出：先把在途请求处理完，避免下载到一半的连接被硬切。 */
function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭服务器…`);
  logger.log({ message: `收到 ${signal}，服务器关闭` });

  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });

  // 兜底：如果还有长连接挂着（比如正在限速下载一个大包），
  // 给它 5 秒收尾，之后强制退出
  setTimeout(() => {
    console.warn('仍有连接未结束，强制退出');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
