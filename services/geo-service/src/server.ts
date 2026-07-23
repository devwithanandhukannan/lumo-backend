import express, { Request, Response } from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5006;

app.use(cors());
app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'UP', service: 'Geo Telemetry Service' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  console.log('📍 Client connected to Geo Telemetry Stream');

  ws.on('message', (message: Buffer | string) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('📍 Ingested Provider GPS Telemetry:', data);

      wss.clients.forEach((client: WebSocket) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'GEO_UPDATE', payload: data }));
        }
      });
    } catch (e) {}
  });
});

server.listen(PORT, () => console.log(`📍 Geo Telemetry WebSocket Service running on port ${PORT}`));
