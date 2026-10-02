// backend/server.js
const app = require('./app');
const configManager = app.locals.configManager; // 可选的，获取配置

const port = process.env.PORT || (configManager && configManager.get().server.port) || 3000;

const server = app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

process.on('SIGTERM', () => {
    server.close(() => {
        console.log('Server closed');
    });
});