# LUMO Microservices Platform — Quick API Endpoints Guide

> 📖 **Comprehensive Documentation**: For the complete repository folder structure, database schema, and detailed JSON response payload samples, see [API_DOCUMENTATION.md](file:///Users/anandhu/Desktop/lumo/backend/API_DOCUMENTATION.md).

All client HTTP requests pass through the central **API Gateway (Port 5000 / Fallback 8000)**.

---

## 🌐 1. API Gateway Base URL & Routing Map

| Gateway Base URL | Gateway Port | Target Microservice | Target Service Port | Path Prefix |
| :--- | :--- | :--- | :--- | :--- |
| `http://localhost:5000` | 5000 | **API Gateway Edge** | 5000 | `/health` |
| `http://localhost:5000` | 5000 | **Auth & Identity Service** | 5001 | `/api/v1/auth/*` |
| `http://localhost:5000` | 5000 | **User & Profile Service** | 5002 | `/api/v1/users/*` |
| `http://localhost:5000` | 5000 | **Professional Service** | 5003 | `/api/v1/pro/*` |
| `http://localhost:5000` | 5000 | **Service Catalog Service** | 5004 | `/api/v1/catalog/*` |
| `http://localhost:5000` | 5000 | **Booking Engine Service** | 5005 | `/api/v1/bookings/*` |
| `ws://localhost:5006` | 5006 | **Geo Telemetry Service (WS)** | 5006 | `/ws/v1/geo/*` |
| `http://localhost:5000` | 5000 | **Safety & Admin SCC Service** | 5007 | `/api/v1/safety/*` & `/api/v1/admin/*` |
| `http://localhost:5000` | 5000 | **Payment & Wallet Service** | 5008 | `/api/v1/payments/*` |
| `http://localhost:5000` | 5000 | **Notification Service** | 5009 | `/api/v1/notifications/*` |
| `http://localhost:5000` | 5000 | **Media Vault Service** | 5010 | `/api/v1/media/*` |
| `http://localhost:5000` | 5000 | **Document Vault Static Files** | 5000 | `/proff_cert/*` |

---

## 🔑 2. Common Headers & Authorization

```http
Authorization: Bearer <LUMO_ACCESS_TOKEN>
Content-Type: application/json
```

---

## 📡 3. Endpoints Summary Table

| Service | Method | Endpoint Path | Auth Scope | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Gateway** | `GET` | `/health` | Public | Edge proxy health check |
| **Auth** | `GET` | `/health` | Public | Auth DB healthcheck |
| **Auth** | `POST` | `/api/v1/auth/otp/send` | Public (Rate Limited) | Send 6-digit verification phone OTP |
| **Auth** | `POST` | `/api/v1/auth/otp/verify` | Public (Rate Limited) | Verify phone OTP & issue JWT tokens |
| **Auth** | `POST` | `/api/v1/auth/pro/register` | Public | Argon2 partner register / login |
| **Auth** | `POST` | `/api/v1/auth/firebase-login` | Public | Firebase ID token verification & login |
| **User** | `GET` | `/health` | Public | User service healthcheck |
| **User** | `GET` | `/api/v1/users/me` | Authenticated | Fetch current user profile |
| **User** | `POST` | `/api/v1/users/locations` | Customer | Save GPS address location |
| **Pro** | `GET` | `/health` | Public | Pro service healthcheck |
| **Pro** | `GET` | `/api/v1/pro/health` | Professional | Fetch partner health score & rating metrics |
| **Pro** | `GET` | `/api/v1/pro/profile` | Professional | Fetch full partner profile & documents |
| **Pro** | `POST` | `/api/v1/pro/documents` | Professional | Submit verification document URLs (Govt ID, Police PDF, Selfie) |
| **Pro** | `POST` | `/api/v1/pro/upload-doc` | Public | Upload certificate base64 file to `proff_cert` folder |
| **Pro** | `POST` | `/api/v1/pro/offered-services` | Professional | Save offered services & custom pricing |
| **Pro** | `POST` | `/api/v1/pro/request-service` | Professional | Submit custom service request for Admin review |
| **Pro** | `PUT` | `/api/v1/pro/duty-status` | Professional | Toggle duty status (Online/Offline) & location |
| **Catalog** | `GET` | `/health` | Public | Catalog service healthcheck |
| **Catalog** | `GET` | `/api/v1/catalog/categories` | Public | Fetch active service categories |
| **Catalog** | `POST` | `/api/v1/catalog/categories` | Admin | Create service category |
| **Catalog** | `GET` | `/api/v1/catalog/services` | Public | Fetch active services (supports `categoryId` filter) |
| **Catalog** | `POST` | `/api/v1/catalog/services` | Admin | Create new service catalog item |
| **Catalog** | `DELETE` | `/api/v1/catalog/services/:id` | Admin | Soft delete service catalog item |
| **Catalog** | `GET` | `/api/v1/catalog/service-requests` | Admin | Fetch pending pro custom service requests |
| **Catalog** | `POST` | `/api/v1/catalog/service-requests/:id/approve` | Admin | Approve custom service request to live catalog |
| **Catalog** | `POST` | `/api/v1/catalog/service-requests/:id/reject` | Admin | Reject custom service request |
| **Booking** | `GET` | `/health` | Public | Booking service healthcheck |
| **Booking** | `POST` | `/api/v1/bookings` | Customer | Create booking & auto-match pros within 50km |
| **Booking** | `GET` | `/api/v1/bookings/my-bookings` | Customer \| Pro | Fetch booking history |
| **Booking** | `POST` | `/api/v1/bookings/:id/accept` | Professional | Accept requested booking |
| **Booking** | `POST` | `/api/v1/bookings/:id/start` | Professional | Verify 4-digit start OTP & start job |
| **Booking** | `POST` | `/api/v1/bookings/:id/complete` | Professional | Verify 4-digit end OTP & complete job |
| **Geo (WS)**| `GET` | `/health` | Public | Geo service healthcheck |
| **Geo (WS)**| `WS` | `ws://localhost:5006` | Public / WS | Real-time live provider GPS telemetry stream |
| **Safety** | `GET` | `/health` | Public | Safety service healthcheck |
| **Safety** | `POST` | `/api/v1/safety/sos/trigger` | Customer \| Pro | Sub-second Emergency SOS button trigger |
| **Safety** | `GET` | `/api/v1/admin/safety/sos` | Admin | Fetch active Emergency SOS alerts |
| **Safety** | `PATCH` | `/api/v1/admin/safety/sos/:sosId/resolve` | Admin | Mark Emergency SOS alert resolved |
| **Safety** | `GET` | `/api/v1/admin/pro/verifications` | Admin | Fetch pro verification applications & documents |
| **Safety** | `POST` | `/api/v1/admin/pro/:userId/verify` | Admin | Approve / Suspend / Reject pro verification status |
| **Safety** | `PUT` | `/api/v1/admin/pro/:userId/coverage` | Admin | Update pro coverage radius (50km) & region |
| **Safety** | `GET` | `/api/v1/admin/settings` | Admin | Fetch system settings (Google Maps API Key, etc.) |
| **Safety** | `PUT` | `/api/v1/admin/settings/:settingKey` | Admin | Update system setting key |
| **Media** | `GET` | `/health` | Public | Media service healthcheck |
| **Media** | `POST` | `/api/v1/media/upload-url` | Customer \| Pro | Generate presigned S3 document upload URL |
