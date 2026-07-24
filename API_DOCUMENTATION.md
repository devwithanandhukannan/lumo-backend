# LUMO Microservices Platform — Comprehensive Current State Documentation & API Specification

**Last Updated**: July 2026  
**Platform Version**: v1.0.0 (Production Candidate Monorepo)  
**Architecture**: Node.js + Express + TypeScript Monorepo (NPM Workspaces), PostgreSQL + PostGIS, WebSockets Telemetry, API Gateway Edge Proxy.

---

## 📂 1. Repository Folder Structure

```
lumo/backend/
├── .env                              # Environment variables (DB credentials, secrets, ports)
├── .gitignore                        # Git exclusion rules
├── API_DOCUMENTATION.md              # Exhaustive API & system architecture specification
├── API_ENDPOINTS.md                  # Quick reference API routing guide
├── README.md                         # Monorepo setup & startup instructions
├── docker-compose.yml                # Local PostgreSQL (PostGIS) & Redis Docker setup
├── firebase-service-account.json     # Firebase Admin SDK credentials for phone auth
├── init.sql                          # Core PostgreSQL schema initialization & seed data
├── package.json                      # Monorepo root workspace configuration
├── package-lock.json                 # Locked dependency tree
├── tsconfig.base.json                # Shared TypeScript base configuration
├── tsconfig.json                     # Root TypeScript project references
├── run-all.sh                        # One-click shell script starting all 11 microservices
├── proff_cert/                       # Global document vault storage for identity & police PDFs
├── scripts/                          # Utility & administrative operational scripts
│
├── packages/                         # Shared Monorepo Core Libraries
│   ├── common/                       # Shared JWT Auth, Custom Errors & Express Middlewares
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts              # Package barrel exporter
│   │       ├── errors/
│   │       │   └── AppError.ts       # Centralized HTTP operational error class
│   │       ├── utils/
│   │       │   └── jwt.utils.ts      # Access & Refresh JWT signing & verification helpers
│   │       └── middlewares/
│   │           ├── auth.middleware.ts# Token authentication & role-based access control (RBAC)
│   │           └── error.middleware.ts # Global Express error handling middleware
│   │
│   └── database/                     # Shared PostgreSQL Database Connection Pool & Migrations
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts              # Database connection pool (`pool`) & auto-migration engine
│           └── init.sql              # Package SQL backup schema
│
└── services/                         # Microservices Architecture (11 Independent Services)
    ├── api-gateway/                  # Port 5000 (Fallback 8000) — Reverse Proxy Edge Router
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── server.ts             # Proxy routing rules & static document vault serving
    │
    ├── auth-service/                 # Port 5001 — Identity, Phone OTP & Firebase Auth
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── server.ts             # OTP dispatch/verify, Argon2 password auth, JWT issuance
    │
    ├── user-service/                 # Port 5002 — Customer & User Profile Management
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── server.ts             # Fetch profiles (`/me`), save PostGIS address locations
    │
    ├── pro-service/                  # Port 5003 — Professional Partner & Account Health
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── proff_cert/               # Local document store for provider certificates
    │   └── src/
    │       └── server.ts             # Account health metrics, document upload, duty status toggle
    │
    ├── catalog-service/              # Port 5004 — Service Categories & Pricing Engine
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── server.ts             # Categories, services catalog, pro custom service approval workflow
    │
    ├── booking-service/              # Port 5005 — Home Service Booking & Provider Match Engine
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── server.ts             # Booking creation, 50km radius matching, start/end OTP verification
    │
    ├── geo-service/                  # Port 5006 — Real-time GPS Telemetry & Tracking (WebSocket)
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── server.ts             # WS server for provider live location streaming
    │
    ├── safety-service/               # Port 5007 — Safety Control Center (SCC) & Admin Portal
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── server.ts             # Instant SOS triggers, SOS resolution, pro verifications, system settings
    │
    ├── payment-service/              # Port 5008 — Escrow & Payment Gateway Interface
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── server.ts             # Payment processing foundation
    │
    ├── notification-service/         # Port 5009 — Push Notifications & SMS Gateway
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       └── server.ts             # FCM push notification dispatcher
    │
    └── media-service/                # Port 5010 — Cloud S3 Media Vault & Presigned URLs
        ├── package.json
        ├── tsconfig.json
        └── src/
            └── server.ts             # Presigned S3 upload URL generator
```

---

## 🌐 2. System Architecture & Routing Map

All requests from frontend clients (**Flutter Customer App**, **Flutter Professional App**, and **Next.js Safety & Admin Panel**) route through the central **API Gateway Edge Proxy** on **Port 5000** (or port **8000** if port 5000 is occupied).

| Gateway Path Prefix | Target Microservice | Service Port | Auth Required | Primary Responsibilities |
| :--- | :--- | :--- | :--- | :--- |
| `http://localhost:5000/health` | **API Gateway Edge** | `5000` | Public | Edge proxy health status |
| `http://localhost:5000/api/v1/auth/*` | **Auth & Identity Service** | `5001` | Public / Rate Limited | Phone OTP, Firebase ID Login, Argon2 Pro Register |
| `http://localhost:5000/api/v1/users/*` | **User & Profile Service** | `5002` | Authenticated | User details, saved GPS locations |
| `http://localhost:5000/api/v1/pro/*` | **Professional Service** | `5003` | Professional | Partner metrics, document uploads, duty status (Online/Offline) |
| `http://localhost:5000/api/v1/catalog/*` | **Catalog Service** | `5004` | Public / Admin | Categories, services list, custom service approval |
| `http://localhost:5000/api/v1/bookings/*` | **Booking Engine** | `5005` | Customer / Professional | 50km Pro matching, job start/end OTP verification |
| `ws://localhost:5006` | **Geo Telemetry Service** | `5006` | Public / WS | Real-time provider GPS tracking stream |
| `http://localhost:5000/api/v1/safety/*` | **Safety Service (SCC)** | `5007` | Customer / Professional | Sub-second emergency SOS button trigger |
| `http://localhost:5000/api/v1/admin/*` | **Safety & Admin Service** | `5007` | Admin / Super Admin | SOS management, partner verifications, system settings |
| `http://localhost:5000/api/v1/payments/*` | **Payment Service** | `5008` | Authenticated | Escrow payments & wallets |
| `http://localhost:5000/api/v1/notifications/*` | **Notification Service**| `5009` | Authenticated | FCM & SMS alerts |
| `http://localhost:5000/api/v1/media/*` | **Media Vault Service** | `5010` | Authenticated | S3 presigned document upload URLs |
| `http://localhost:5000/proff_cert/*` | **API Gateway Static Vault**| `5000` | Public | Direct file access for uploaded partner certificates |

---

## 🔑 3. Common Headers & Authorization

All authenticated HTTP requests must include the **Bearer JWT Token** in the HTTP Authorization header:

```http
Authorization: Bearer <LUMO_ACCESS_TOKEN>
Content-Type: application/json
```

### Response Error Format
All operational errors follow a standard JSON error envelope:

```json
{
  "success": false,
  "error": "Error description message"
}
```

---

## 📡 4. Complete Endpoints Specification

---

### 4.1 API Gateway Service (`api-gateway` — Port 5000)

#### 4.1.1 Gateway Health Check
- **Method**: `GET`
- **Path**: `/health`
- **Auth Scope**: `Public`
- **Description**: Verifies API Gateway proxy is operational.

##### Response Body (HTTP 200)
```json
{
  "status": "UP",
  "gateway": "LUMO API Gateway Edge Proxy",
  "port": 5000,
  "timestamp": "2026-07-24T10:35:40.000Z"
}
```

---

### 4.2 Auth & Identity Service (`auth-service` — Port 5001)

#### 4.2.1 Service Healthcheck
- **Method**: `GET`
- **Path**: `/health`
- **Auth Scope**: `Public`

##### Response Body (HTTP 200)
```json
{
  "status": "UP",
  "database": "CONNECTED",
  "service": "Auth Service"
}
```

---

#### 4.2.2 Send Phone OTP
- **Method**: `POST`
- **Path**: `/api/v1/auth/otp/send`
- **Auth Scope**: `Public` *(Rate Limited: Max 10 requests / 15 mins)*
- **Description**: Generates and stores a 6-digit OTP code valid for 5 minutes.

##### Request Body
```json
{
  "phoneNumber": "+919876543210"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "OTP sent successfully"
}
```

---

#### 4.2.3 Verify Phone OTP
- **Method**: `POST`
- **Path**: `/api/v1/auth/otp/verify`
- **Auth Scope**: `Public` *(Rate Limited: Max 10 requests / 15 mins)*
- **Description**: Validates OTP. Registers new user in PostgreSQL if not present, issues LUMO JWT Access and Refresh tokens.

##### Request Body
```json
{
  "phoneNumber": "+919876543210",
  "otp": "123456",
  "role": "CUSTOMER",
  "fullName": "Anandhu",
  "gender": "MALE"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr-8a2f4c1e",
      "phone_number": "+919876543210",
      "full_name": "Anandhu",
      "role": "CUSTOMER",
      "gender": "MALE",
      "phone_verified": true,
      "is_active": true
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1Ni...",
      "refreshToken": "eyJhbGciOiJIUzI1Ni..."
    }
  }
}
```

---

#### 4.2.4 Register / Login Professional Partner
- **Method**: `POST`
- **Path**: `/api/v1/auth/pro/register`
- **Auth Scope**: `Public`
- **Description**: Registers a new Professional partner with Argon2 password hashing. If account exists with matching password, seamlessly logs in.

##### Request Body
```json
{
  "email": "pro@lumo.in",
  "password": "SecurePassword123!",
  "phoneNumber": "+919876543210",
  "fullName": "Rajesh Kumar",
  "gender": "MALE"
}
```

##### Response Body (HTTP 201 Created / HTTP 200 OK)
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr-9f12a4b0",
      "email": "pro@lumo.in",
      "phone_number": "+919876543210",
      "full_name": "Rajesh Kumar",
      "role": "PROFESSIONAL",
      "gender": "MALE"
    },
    "verificationStatus": "PENDING",
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1Ni...",
      "refreshToken": "eyJhbGciOiJIUzI1Ni..."
    }
  }
}
```

---

#### 4.2.5 Firebase ID Token Login
- **Method**: `POST`
- **Path**: `/api/v1/auth/firebase-login`
- **Auth Scope**: `Public`
- **Description**: Verifies client-side Firebase ID token (from SMS Auth or Google Sign-In) via Firebase Admin SDK, provisions user, returns LUMO JWT tokens.

##### Request Body
```json
{
  "idToken": "eyJhbGciOiJSUzI1Ni...",
  "role": "CUSTOMER",
  "fullName": "Anandhu"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr-8a2f4c1e",
      "phone_number": "+919876543210",
      "full_name": "Anandhu",
      "role": "CUSTOMER"
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1Ni...",
      "refreshToken": "eyJhbGciOiJIUzI1Ni..."
    }
  }
}
```

---

### 4.3 User & Profile Service (`user-service` — Port 5002)

#### 4.3.1 Service Healthcheck
- **Method**: `GET`
- **Path**: `/health`
- **Auth Scope**: `Public`

##### Response Body (HTTP 200)
```json
{
  "status": "UP",
  "service": "User Service"
}
```

---

#### 4.3.2 Fetch Current Authenticated User Profile
- **Method**: `GET`
- **Path**: `/api/v1/users/me`
- **Auth Scope**: `Customer` | `Professional` | `Admin`
- **Description**: Retrieves active user details from PostgreSQL database.

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "id": "usr-8a2f4c1e",
    "phone_number": "+919876543210",
    "email": null,
    "full_name": "Anandhu",
    "role": "CUSTOMER",
    "gender": "MALE",
    "avatar_url": null
  }
}
```

---

#### 4.3.3 Save GPS Address Location
- **Method**: `POST`
- **Path**: `/api/v1/users/locations`
- **Auth Scope**: `Customer`
- **Description**: Saves customer address with PostGIS latitude & longitude coordinates.

##### Request Body
```json
{
  "label": "Home",
  "addressText": "Marine Drive, Kochi, Kerala 682031",
  "latitude": 9.9772,
  "longitude": 76.2763,
  "isDefault": true
}
```

##### Response Body (HTTP 201 Created)
```json
{
  "success": true,
  "data": {
    "id": "loc-71ab4c",
    "user_id": "usr-8a2f4c1e",
    "label": "Home",
    "address_text": "Marine Drive, Kochi, Kerala 682031",
    "latitude": 9.9772,
    "longitude": 76.2763,
    "is_default": true,
    "created_at": "2026-07-24T10:35:40.000Z"
  }
}
```

---

### 4.4 Professional Service (`pro-service` — Port 5003)

#### 4.4.1 Service Healthcheck
- **Method**: `GET`
- **Path**: `/health`
- **Auth Scope**: `Public`

##### Response Body (HTTP 200)
```json
{
  "status": "UP",
  "service": "Pro Service"
}
```

---

#### 4.4.2 Fetch Provider Account Health & Rating Metrics
- **Method**: `GET`
- **Path**: `/api/v1/pro/health`
- **Auth Scope**: `Professional`
- **Description**: Returns provider's Account Health Score (0-100), average rating, job metrics, verification status, and duty state.

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "accountHealthScore": 98.5,
    "ratingAvg": 4.92,
    "totalJobsCompleted": 142,
    "acceptanceRate": 95.0,
    "cancellationRate": 1.2,
    "verificationStatus": "APPROVED",
    "coverageRadiusKm": 50.0,
    "assignedRegion": "Kochi, Kerala",
    "serviceArea": "Kochi, Kerala",
    "isOnline": true
  }
}
```

---

#### 4.4.3 Fetch Full Professional Profile & Documents
- **Method**: `GET`
- **Path**: `/api/v1/pro/profile`
- **Auth Scope**: `Professional`
- **Description**: Retrieves full profile details, verification status, uploaded documents metadata, and active offered services with custom rates.

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr-9f12a4b0",
      "phone_number": "+919876543210",
      "email": "pro@lumo.in",
      "full_name": "Rajesh Kumar",
      "role": "PROFESSIONAL",
      "gender": "MALE",
      "avatar_url": null,
      "service_area": "Kochi, Kerala",
      "email_verified": false,
      "phone_verified": true
    },
    "profile": {
      "id": "pro-81ab4c",
      "user_id": "usr-9f12a4b0",
      "verification_status": "APPROVED",
      "documents": {
        "govtIdType": "AADHAAR",
        "govtIdNumber": "XXXX-XXXX-1234",
        "govtIdUrl": "/proff_cert/177000_aadhaar.pdf",
        "policeVerificationUrl": "/proff_cert/177000_police.pdf"
      },
      "face_verification_url": "/proff_cert/177000_selfie.png",
      "face_verified": true,
      "coverage_radius_km": 50.0,
      "rating_avg": 5.0,
      "account_health_score": 100.0,
      "service_area": "Kochi, Kerala"
    },
    "offeredServices": [
      {
        "id": "pos-12ab",
        "pro_id": "usr-9f12a4b0",
        "service_id": "srv-elec-01",
        "custom_price": "220.00",
        "service_name": "Switch & Socket Repair",
        "base_price": "199.00",
        "category_name": "Electrical Repair"
      }
    ]
  }
}
```

---

#### 4.4.4 Submit Verification Documents
- **Method**: `POST`
- **Path**: `/api/v1/pro/documents`
- **Auth Scope**: `Professional`
- **Description**: Saves metadata for Govt ID, Police Clearance Certificate PDF, and Face Selfie photo. Resets status to `PENDING` for admin review.

##### Request Body
```json
{
  "govtIdType": "AADHAAR",
  "govtIdNumber": "1234-5678-9012",
  "govtIdUrl": "/proff_cert/177000_aadhaar.pdf",
  "policeVerificationUrl": "/proff_cert/177000_police.pdf",
  "faceSelfieUrl": "/proff_cert/177000_selfie.png",
  "certifications": ["Electrician License Tier 1"]
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "Verification documents submitted for review",
  "data": {
    "id": "pro-81ab4c",
    "user_id": "usr-9f12a4b0",
    "verification_status": "PENDING",
    "is_online": false
  }
}
```

---

#### 4.4.5 Upload Certificate / Document Base64 File
- **Method**: `POST`
- **Path**: `/api/v1/pro/upload-doc`
- **Auth Scope**: `Public`
- **Description**: Stores base64 uploaded files directly into the platform `proff_cert` directory. Returns static file path.

##### Request Body
```json
{
  "fileName": "police_clearance.pdf",
  "fileData": "data:application/pdf;base64,JVBERi0xLjQN...",
  "docType": "POLICE_CLEARANCE"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "Document stored successfully in proff_cert folder",
  "fileUrl": "/proff_cert/1774309200000_police_clearance.pdf",
  "savedFileName": "1774309200000_police_clearance.pdf",
  "localPath": "/Users/anandhu/Desktop/lumo/backend/proff_cert/1774309200000_police_clearance.pdf"
}
```

---

#### 4.4.6 Save Offered Services & Custom Rates
- **Method**: `POST`
- **Path**: `/api/v1/pro/offered-services`
- **Auth Scope**: `Professional`
- **Description**: Associates catalog services with provider's profile and optional custom pricing.

##### Request Body
```json
{
  "services": [
    { "serviceId": "srv-elec-01", "customPrice": 220.00 },
    { "serviceId": "srv-elec-02", "customPrice": 270.00 }
  ]
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "Offered services and custom rates saved"
}
```

---

#### 4.4.7 Request New Custom Service (Pending Admin Approval)
- **Method**: `POST`
- **Path**: `/api/v1/pro/request-service`
- **Auth Scope**: `Professional`
- **Description**: Allows pros to propose new service items. Requires Super Admin approval before listing live in catalog.

##### Request Body
```json
{
  "serviceName": "EV Charger Point Installation",
  "description": "3-phase AC EV wallbox installation and circuit breaker connection",
  "suggestedPrice": 1499.00
}
```

##### Response Body (HTTP 201 Created)
```json
{
  "success": true,
  "message": "New service request submitted for Super Admin approval",
  "data": {
    "id": "svc-req-91ab4c",
    "pro_id": "usr-9f12a4b0",
    "service_name": "EV Charger Point Installation",
    "description": "3-phase AC EV wallbox installation and circuit breaker connection",
    "suggested_price": "1499.00",
    "status": "PENDING_ADMIN_APPROVAL"
  }
}
```

---

#### 4.4.8 Toggle Duty Status (Online / Offline)
- **Method**: `PUT`
- **Path**: `/api/v1/pro/duty-status`
- **Auth Scope**: `Professional` *(Requires `APPROVED` verification status)*
- **Description**: Toggles provider online availability and updates current GPS location.

##### Request Body
```json
{
  "isOnline": true,
  "latitude": 9.9312,
  "longitude": 76.2673
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "Duty status updated to ONLINE",
  "data": {
    "user_id": "usr-9f12a4b0",
    "is_online": true,
    "current_location": "{\"lat\":9.9312,\"lng\":76.2673,\"updatedAt\":\"2026-07-24T10:35:40.000Z\"}"
  }
}
```

---

### 4.5 Service Catalog Service (`catalog-service` — Port 5004)

#### 4.5.1 Fetch Active Service Categories
- **Method**: `GET`
- **Path**: `/api/v1/catalog/categories`
- **Auth Scope**: `Public`

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "id": "cat-elec",
      "name": "Electrical Repair",
      "description": "Wiring, switchboard, fan & appliance repairs",
      "icon_url": null,
      "is_active": true
    },
    {
      "id": "cat-clean",
      "name": "Cleaning Services",
      "description": "Home deep cleaning, kitchen & bathroom sanitization",
      "icon_url": null,
      "is_active": true
    }
  ]
}
```

---

#### 4.5.2 Create Service Category (Admin)
- **Method**: `POST`
- **Path**: `/api/v1/catalog/categories`
- **Auth Scope**: `Admin`

##### Request Body
```json
{
  "name": "Solar Panel Maintenance",
  "description": "Cleaning and inspection of rooftop solar panel arrays",
  "iconUrl": "https://cdn-icons-png.flaticon.com/512/3104/3104618.png"
}
```

##### Response Body (HTTP 201 Created)
```json
{
  "success": true,
  "message": "Service category created successfully",
  "data": {
    "id": "cat-81af9c",
    "name": "Solar Panel Maintenance",
    "description": "Cleaning and inspection of rooftop solar panel arrays",
    "icon_url": "https://cdn-icons-png.flaticon.com/512/3104/3104618.png",
    "is_active": true
  }
}
```

---

#### 4.5.3 Fetch Active Services Catalog
- **Method**: `GET`
- **Path**: `/api/v1/catalog/services?categoryId=cat-elec`
- **Auth Scope**: `Public`

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "id": "srv-elec-01",
      "category_id": "cat-elec",
      "name": "Switch & Socket Repair",
      "description": "Fix loose wiring, burnt sockets & switches",
      "base_price": "199.00",
      "duration_minutes": 30,
      "category_name": "Electrical Repair"
    }
  ]
}
```

---

#### 4.5.4 Create New Service Catalog Item (Admin)
- **Method**: `POST`
- **Path**: `/api/v1/catalog/services`
- **Auth Scope**: `Admin`

##### Request Body
```json
{
  "categoryId": "cat-elec",
  "name": "Inverter & Battery Wiring",
  "description": "Complete backup inverter unit wiring and battery connection",
  "basePrice": 599.00,
  "durationMinutes": 90
}
```

##### Response Body (HTTP 201 Created)
```json
{
  "success": true,
  "message": "New service created and listed for professionals",
  "data": {
    "id": "srv-71bc9a",
    "category_id": "cat-elec",
    "name": "Inverter & Battery Wiring",
    "description": "Complete backup inverter unit wiring and battery connection",
    "base_price": "599.00",
    "duration_minutes": 90,
    "category_name": "Electrical Repair"
  }
}
```

---

#### 4.5.5 Soft Delete Service Item (Admin)
- **Method**: `DELETE`
- **Path**: `/api/v1/catalog/services/:id`
- **Auth Scope**: `Admin`

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "Service removed from catalog"
}
```

---

#### 4.5.6 Fetch Pending Custom Service Requests (Admin)
- **Method**: `GET`
- **Path**: `/api/v1/catalog/service-requests`
- **Auth Scope**: `Admin`

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "id": "svc-req-91ab4c",
      "pro_id": "usr-9f12a4b0",
      "pro_name": "Rajesh Kumar",
      "pro_phone": "+919876543210",
      "service_name": "EV Charger Point Installation",
      "description": "3-phase AC EV wallbox installation",
      "suggested_price": "1499.00",
      "status": "PENDING_ADMIN_APPROVAL"
    }
  ]
}
```

---

#### 4.5.7 Approve Partner Service Request (Admin)
- **Method**: `POST`
- **Path**: `/api/v1/catalog/service-requests/:id/approve`
- **Auth Scope**: `Admin`
- **Description**: Approves proposed service and automatically adds it to live active service catalog.

##### Request Body
```json
{
  "categoryId": "cat-elec",
  "basePrice": 1499.00
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "Approved service \"EV Charger Point Installation\" into live catalog"
}
```

---

#### 4.5.8 Reject Partner Service Request (Admin)
- **Method**: `POST`
- **Path**: `/api/v1/catalog/service-requests/:id/reject`
- **Auth Scope**: `Admin`

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "Service request rejected"
}
```

---

### 4.6 Booking Engine Service (`booking-service` — Port 5005)

#### 4.6.1 Service Healthcheck
- **Method**: `GET`
- **Path**: `/health`
- **Auth Scope**: `Public`

##### Response Body (HTTP 200)
```json
{
  "status": "UP",
  "service": "Booking Service"
}
```

---

#### 4.6.2 Create Home Service Booking (50km Auto-Matching Matrix)
- **Method**: `POST`
- **Path**: `/api/v1/bookings`
- **Auth Scope**: `Customer`
- **Description**: Creates booking. Queries nearby active, online, non-busy approved professionals within provider's 50km coverage radius. Generates 4-digit start & end security OTPs.

##### Request Body
```json
{
  "serviceId": "srv-elec-01",
  "scheduledAt": "2026-07-25T10:00:00.000Z",
  "addressText": "Marine Drive, Kochi, Kerala",
  "latitude": 9.9772,
  "longitude": 76.2763,
  "femaleProPreferred": false
}
```

##### Response Body (HTTP 201 Created)
```json
{
  "success": true,
  "data": {
    "id": "bk-4f91b8a0",
    "customer_id": "usr-8a2f4c1e",
    "pro_id": "usr-9f12a4b0",
    "service_id": "srv-elec-01",
    "status": "ACCEPTED",
    "scheduled_at": "2026-07-25T10:00:00.000Z",
    "address_text": "Marine Drive, Kochi, Kerala",
    "latitude": 9.9772,
    "longitude": 76.2763,
    "female_pro_preferred": false,
    "start_otp": "7482",
    "end_otp": "9124",
    "total_amount": "199.00",
    "service_name": "Switch & Socket Repair"
  }
}
```

---

#### 4.6.3 Fetch My Bookings (Customer / Professional)
- **Method**: `GET`
- **Path**: `/api/v1/bookings/my-bookings`
- **Auth Scope**: `Customer` | `Professional`
- **Description**: Returns booking history for the current user or available jobs for professionals.

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "id": "bk-4f91b8a0",
      "customer_id": "usr-8a2f4c1e",
      "pro_id": "usr-9f12a4b0",
      "service_id": "srv-elec-01",
      "status": "ACCEPTED",
      "service_name": "Switch & Socket Repair",
      "customer_name": "Anandhu",
      "customer_phone": "+919876543210",
      "total_amount": "199.00",
      "scheduled_at": "2026-07-25T10:00:00.000Z"
    }
  ]
}
```

---

#### 4.6.4 Accept Requested Booking (Professional)
- **Method**: `POST`
- **Path**: `/api/v1/bookings/:id/accept`
- **Auth Scope**: `Professional` *(Requires `APPROVED` status)*

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "id": "bk-4f91b8a0",
    "pro_id": "usr-9f12a4b0",
    "status": "ACCEPTED"
  }
}
```

---

#### 4.6.5 Verify Start OTP & Start Job (Professional)
- **Method**: `POST`
- **Path**: `/api/v1/bookings/:id/start`
- **Auth Scope**: `Professional`
- **Description**: Validates 4-digit start OTP provided by customer before work begins. Transitions status to `IN_PROGRESS`.

##### Request Body
```json
{
  "otp": "7482"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "Start OTP verified. Service in progress.",
  "data": {
    "id": "bk-4f91b8a0",
    "status": "IN_PROGRESS"
  }
}
```

---

#### 4.6.6 Verify End OTP & Complete Job (Professional)
- **Method**: `POST`
- **Path**: `/api/v1/bookings/:id/complete`
- **Auth Scope**: `Professional`
- **Description**: Validates 4-digit end OTP provided by customer upon job completion. Updates total job metrics and marks pro available (`is_busy = false`).

##### Request Body
```json
{
  "otp": "9124"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "End OTP verified. Job completed successfully.",
  "data": {
    "id": "bk-4f91b8a0",
    "status": "COMPLETED"
  }
}
```

---

### 4.7 Geo Telemetry Service (`geo-service` — Port 5006)

#### 4.7.1 Service Healthcheck
- **Method**: `GET`
- **Path**: `/health`
- **Auth Scope**: `Public`

##### Response Body (HTTP 200)
```json
{
  "status": "UP",
  "service": "Geo Telemetry Service"
}
```

---

#### 4.7.2 Live Provider GPS Telemetry Stream (WebSocket)
- **Protocol**: `WebSocket (WS)`
- **URL**: `ws://localhost:5006`
- **Auth Scope**: `Public` / `Authenticated`
- **Description**: Bidirectional stream for ingesting provider GPS locations and broadcasting live tracking updates to customers.

##### Incoming Telemetry Ping (From Professional App)
```json
{
  "type": "LOCATION_PING",
  "proId": "usr-9f12a4b0",
  "bookingId": "bk-4f91b8a0",
  "latitude": 9.9780,
  "longitude": 76.2770,
  "bearing": 145.2,
  "speed": 12.4
}
```

##### Outgoing Broadcast (To Customer App)
```json
{
  "type": "GEO_UPDATE",
  "payload": {
    "proId": "usr-9f12a4b0",
    "bookingId": "bk-4f91b8a0",
    "latitude": 9.9780,
    "longitude": 76.2770,
    "bearing": 145.2,
    "etaMinutes": 8
  }
}
```

---

### 4.8 Safety & Admin SCC Service (`safety-service` — Port 5007)

#### 4.8.1 Service Healthcheck
- **Method**: `GET`
- **Path**: `/health`
- **Auth Scope**: `Public`

##### Response Body (HTTP 200)
```json
{
  "status": "UP",
  "service": "Safety Control Center Service"
}
```

---

#### 4.8.2 Trigger Instant Emergency SOS
- **Method**: `POST`
- **Path**: `/api/v1/safety/sos/trigger`
- **Auth Scope**: `Customer` | `Professional`
- **Description**: Sub-second emergency SOS button dispatch to Admin Safety Control Center (SCC) with real-time GPS coordinates.

##### Request Body
```json
{
  "bookingId": "bk-4f91b8a0",
  "latitude": 9.9772,
  "longitude": 76.2763,
  "notes": "Emergency SOS Button Pressed in Customer App"
}
```

##### Response Body (HTTP 201 Created)
```json
{
  "success": true,
  "data": {
    "id": "sos-31bc9a",
    "booking_id": "bk-4f91b8a0",
    "triggered_by_user_id": "usr-8a2f4c1e",
    "trigger_latitude": 9.9772,
    "trigger_longitude": 76.2763,
    "status": "ACTIVE",
    "notes": "Emergency SOS Button Pressed in Customer App",
    "created_at": "2026-07-24T10:35:40.000Z"
  }
}
```

---

#### 4.8.3 Fetch Active SOS Alerts (Admin Safety Control Center)
- **Method**: `GET`
- **Path**: `/api/v1/admin/safety/sos`
- **Auth Scope**: `Admin` | `Super Admin`

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "id": "sos-31bc9a",
      "booking_id": "bk-4f91b8a0",
      "triggered_by_user_id": "usr-8a2f4c1e",
      "user_name": "Anandhu",
      "user_phone": "+919876543210",
      "user_role": "CUSTOMER",
      "trigger_latitude": 9.9772,
      "trigger_longitude": 76.2763,
      "status": "ACTIVE",
      "created_at": "2026-07-24T10:35:40.000Z"
    }
  ]
}
```

---

#### 4.8.4 Resolve Emergency SOS Alert (Admin)
- **Method**: `PATCH` / `POST`
- **Path**: `/api/v1/admin/safety/sos/:sosId/resolve`
- **Auth Scope**: `Admin` | `Super Admin`

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "id": "sos-31bc9a",
    "status": "RESOLVED",
    "resolved_at": "2026-07-24T10:40:00.000Z"
  }
}
```

---

#### 4.8.5 Fetch Professional Partner Verification Applications (Admin)
- **Method**: `GET`
- **Path**: `/api/v1/admin/pro/verifications`
- **Auth Scope**: `Admin` | `Super Admin`
- **Description**: Lists all provider applicants, uploaded document URLs, police verification certificates, and face selfie verification status.

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "user_id": "usr-9f12a4b0",
      "full_name": "Rajesh Kumar",
      "email": "pro@lumo.in",
      "phone_number": "+919876543210",
      "gender": "MALE",
      "verification_status": "PENDING",
      "documents": {
        "govtIdType": "AADHAAR",
        "govtIdNumber": "1234-5678-9012",
        "govtIdUrl": "/proff_cert/177000_aadhaar.pdf",
        "policeVerificationUrl": "/proff_cert/177000_police.pdf"
      },
      "face_verification_url": "/proff_cert/177000_selfie.png",
      "face_verified": true,
      "coverage_radius_km": 50.0,
      "service_area": "Kochi, Kerala",
      "assigned_region": "Kochi, Kerala",
      "is_online": false,
      "rating_avg": 5.0
    }
  ]
}
```

---

#### 4.8.6 Approve / Suspend / Reject Professional Partner (Admin)
- **Method**: `POST`
- **Path**: `/api/v1/admin/pro/:userId/verify`
- **Auth Scope**: `Admin` | `Super Admin`

##### Request Body
```json
{
  "status": "APPROVED",
  "notes": "Verified Aadhaar card & Police background clearance PDF"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "Professional status updated to APPROVED",
  "data": {
    "user_id": "usr-9f12a4b0",
    "verification_status": "APPROVED",
    "verification_notes": "Verified Aadhaar card & Police background clearance PDF"
  }
}
```

---

#### 4.8.7 Update Professional Operational Radius (Default 50km) & Region (Admin)
- **Method**: `PUT`
- **Path**: `/api/v1/admin/pro/:userId/coverage`
- **Auth Scope**: `Admin` | `Super Admin`

##### Request Body
```json
{
  "coverageRadiusKm": 50.0,
  "assignedRegion": "Kochi, Kerala"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "user_id": "usr-9f12a4b0",
    "coverage_radius_km": "50.00",
    "assigned_region": "Kochi, Kerala",
    "service_area": "Kochi, Kerala"
  }
}
```

---

#### 4.8.8 Fetch System Settings (Google Maps API Key & Platform Config) (Admin)
- **Method**: `GET`
- **Path**: `/api/v1/admin/settings`
- **Auth Scope**: `Admin` | `Super Admin`

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "setting_key": "GOOGLE_MAPS_API_KEY",
      "setting_value": "AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4",
      "description": "Google Maps Platform API Key for Geocoding & Distance Matrix",
      "updated_at": "2026-07-24T10:35:40.000Z"
    },
    {
      "setting_key": "DEFAULT_COVERAGE_RADIUS_KM",
      "setting_value": "50",
      "description": "Default operational coverage radius for professionals in km",
      "updated_at": "2026-07-24T10:35:40.000Z"
    }
  ]
}
```

---

#### 4.8.9 Update Dynamic System Setting Key (Admin)
- **Method**: `PUT`
- **Path**: `/api/v1/admin/settings/:settingKey`
- **Auth Scope**: `Admin` | `Super Admin`

##### Request Body
```json
{
  "value": "AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4",
  "description": "Updated Production Google Maps API Key"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "setting_key": "GOOGLE_MAPS_API_KEY",
    "setting_value": "AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4",
    "description": "Updated Production Google Maps API Key",
    "updated_at": "2026-07-24T10:35:40.000Z"
  }
}
```

---

### 4.9 Media Vault Service (`media-service` — Port 5010)

#### 4.9.1 Service Healthcheck
- **Method**: `GET`
- **Path**: `/health`
- **Auth Scope**: `Public`

##### Response Body (HTTP 200)
```json
{
  "status": "UP",
  "service": "Media Vault Service"
}
```

---

#### 4.9.2 Generate S3 Presigned Upload URL
- **Method**: `POST`
- **Path**: `/api/v1/media/upload-url`
- **Auth Scope**: `Customer` | `Professional`
- **Description**: Generates temporary S3 upload presigned URL valid for 15 minutes.

##### Request Body
```json
{
  "fileName": "police_clearance_scan.pdf",
  "fileType": "application/pdf"
}
```

##### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "uploadUrl": "https://lumo-vault.s3.amazonaws.com/uploads/usr-8a2f4c1e/9f12a4b0_police_clearance_scan.pdf?mock_signature=abc123xyz",
    "fileKey": "uploads/usr-8a2f4c1e/9f12a4b0_police_clearance_scan.pdf",
    "expiresInSeconds": 900
  }
}
```

---

## 🗄️ 5. PostgreSQL Database Schema Reference

The platform uses a PostGIS-enabled PostgreSQL relational database. Key tables and foreign key relationships are detailed below:

```mermaid
erDiagram
    users ||--o{ saved_locations : "has"
    users ||--o| professional_profiles : "owns"
    users ||--o{ bookings : "creates as customer"
    users ||--o{ bookings : "assigned as pro"
    service_categories ||--o{ services : "contains"
    services ||--o{ bookings : "booked in"
    bookings ||--o{ sos_alerts : "triggers"
    users ||--o{ sos_alerts : "triggered by"
    users ||--o{ pending_service_requests : "pro proposes"
```

### Table Definitions Overview
1. `users`: Core identity table supporting Customer, Professional, Admin, and Super Admin roles.
2. `otps`: Temporary phone OTP store with expiry timestamps.
3. `refresh_tokens`: JWT refresh token persistent store.
4. `saved_locations`: Customer saved addresses with PostGIS latitude & longitude coordinates.
5. `professional_profiles`: Provider verification status, document JSONB metadata, rating average, account health score (0-100), 50km coverage radius, duty state (`is_online`, `is_busy`), and current location.
6. `service_categories`: Active service categories (Electrical, Plumbing, Cleaning, Salon, Safety).
7. `services`: Base catalog services with base price and duration estimates.
8. `pending_service_requests`: Partner-submitted custom service requests pending Admin review.
9. `bookings`: Bookings with job lifecycle states (`REQUESTED`, `ACCEPTED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`), start & end 4-digit OTPs, and total amounts.
10. `sos_alerts`: Active emergency SOS alerts with GPS coordinates, booking links, and resolution status.
11. `system_settings`: Dynamic key-value configuration table (e.g. Google Maps API keys, platform commission rates).

---

## 🚀 6. Startup & Execution Instructions

To start all microservices concurrently using NPM workspaces:

```bash
# Navigate to backend monorepo root
cd /Users/anandhu/Desktop/lumo/backend

# Make startup script executable
chmod +x run-all.sh

# Run all 11 microservices and API Gateway
./run-all.sh
```

Or execute individual microservices via npm workspace commands:
```bash
npm --workspace=services/api-gateway run dev
npm --workspace=services/auth-service run dev
npm --workspace=services/pro-service run dev
npm --workspace=services/booking-service run dev
npm --workspace=services/safety-service run dev
```
