import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5009;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Notification Service' }));

app.listen(PORT, () => console.log(`🔔 Notification Service running on port ${PORT}`));
