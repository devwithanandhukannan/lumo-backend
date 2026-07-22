import app from './app';
import { config } from './config';
import { initDatabaseTables } from './db/pgDb';

const startServer = async () => {
  try {
    // Initialize PostgreSQL tables
    await initDatabaseTables();

    const server = app.listen(config.port, () => {
      console.log(`=======================================================`);
      console.log(`🚀 LUMO Safety-First Backend running on port ${config.port}`);
      console.log(`🌐 Environment: ${config.nodeEnv}`);
      console.log(`🐘 Connected to PostgreSQL DB: ${config.db.name}`);
      console.log(`🌐 Base URL: http://localhost:${config.port}`);
      console.log(`🛡️  Auth Service:        http://localhost:${config.port}/api/v1/auth`);
      console.log(`👤 User Service:        http://localhost:${config.port}/api/v1/users`);
      console.log(`👷 Professional Service: http://localhost:${config.port}/api/v1/pro`);
      console.log(`=======================================================`);
    });

    process.on('SIGTERM', () => {
      console.log('SIGTERM signal received: closing HTTP server');
      server.close(() => {
        console.log('HTTP server closed');
      });
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

startServer();
