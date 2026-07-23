# LUMO Backend — Modular Microservices Architecture

This repository contains the backend infrastructure for the **LUMO (Safety-First Home Services Platform)**, organized as an **npm Workspaces Monorepo**.

---

## 📚 API Endpoints & Routing Documentation

Full request and response specifications for all RESTful and WebSocket endpoints are documented in:
📖 **[API_ENDPOINTS.md](./API_ENDPOINTS.md)**

---

## 🌐 Microservice Services & Port Allocation

| Service Name | Package Location | Port | Gateway Proxy Path |
| :--- | :--- | :--- | :--- |
| **API Gateway** | `services/api-gateway` | `5000` | Edge Proxy (`http://localhost:5000`) |
| **Auth Service** | `services/auth-service` | `5001` | `/api/v1/auth/*` |
| **User Service** | `services/user-service` | `5002` | `/api/v1/users/*` |
| **Pro Service** | `services/pro-service` | `5003` | `/api/v1/pro/*` |
| **Catalog Service** | `services/catalog-service` | `5004` | `/api/v1/catalog/*` |
| **Booking Service** | `services/booking-service` | `5005` | `/api/v1/bookings/*` |
| **Geo Service** | `services/geo-service` | `5006` | `ws://localhost:5006` |
| **Safety Service** | `services/safety-service` | `5007` | `/api/v1/safety/*` & `/api/v1/admin/*` |
| **Payment Service** | `services/payment-service` | `5008` | `/api/v1/payments/*` |
| **Notification Service** | `services/notification-service` | `5009` | `/api/v1/notifications/*` |
| **Media Service** | `services/media-service` | `5010` | `/api/v1/media/*` |

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Database & Infrastructure (PostgreSQL PostGIS + Redis)
```bash
docker-compose up -d
```

### 3. Build All Monorepo Packages & Services
```bash
npm run build
```

### 4. Start ALL Microservices Concurrently (Single Command)
```bash
npm run dev:all
# OR
./run-all.sh
```
This will automatically launch PostgreSQL/Redis (via Docker Compose) and boot up all 11 microservices + API Gateway simultaneously with color-coded logs.

---

### 5. Start Individual Services (Optional)
```bash
# Start API Gateway (Port 5000)
npm --workspace=services/api-gateway run dev

# Start Auth Service (Port 5001)
npm --workspace=services/auth-service run dev

# Start Booking Service (Port 5005)
npm --workspace=services/booking-service run dev
```
