# LUMO Backend Microservices — Complete API Endpoints Specification

This document provides the exhaustive specification for all RESTful HTTP and WebSocket endpoints exposed by the **LUMO Microservices Platform**. All client requests (from Flutter Customer App, Flutter Professional App, and Next.js Admin Panel) pass through the **API Gateway (Port 5000)**.

---

## 🌐 API Gateway Base URL & Routing Map

| Gateway Base URL | Gateway Port | Target Microservice | Target Service Port | Path Prefix |
| :--- | :--- | :--- | :--- | :--- |
| `http://localhost:5000` | 5000 | **Auth & Identity Service** | 5001 | `/api/v1/auth/*` |
| `http://localhost:5000` | 5000 | **User & Profile Service** | 5002 | `/api/v1/users/*` |
| `http://localhost:5000` | 5000 | **Professional & Health Service** | 5003 | `/api/v1/pro/*` |
| `http://localhost:5000` | 5000 | **Service Catalog Service** | 5004 | `/api/v1/catalog/*` |
| `http://localhost:5000` | 5000 | **Booking Engine Service** | 5005 | `/api/v1/bookings/*` |
| `ws://localhost:5006` | 5006 | **Geo Telemetry Service (WS)** | 5006 | `/ws/v1/geo/*` |
| `http://localhost:5000` | 5000 | **Safety & Admin SCC Service** | 5007 | `/api/v1/safety/*` & `/api/v1/admin/*` |
| `http://localhost:5000` | 5000 | **Payment & Wallet Service** | 5008 | `/api/v1/payments/*` |
| `http://localhost:5000` | 5000 | **Notification Service** | 5009 | `/api/v1/notifications/*` |
| `http://localhost:5000` | 5000 | **Media Vault Service** | 5010 | `/api/v1/media/*` |

---

## 🔑 Common Headers & Authorization

All authenticated requests must include the Bearer JWT token in the HTTP Authorization header:

```http
Authorization: Bearer <LUMO_ACCESS_TOKEN>
Content-Type: application/json
```

---

## 1. Auth & Identity Service (`auth-service` — Port 5001)

### 1.1 Send Phone OTP
- **Method**: `POST`
- **Path**: `/api/v1/auth/otp/send`
- **Auth Scope**: `Public`
- **Description**: Dispatches a 6-digit verification OTP to the user's phone number.

#### Request Body
```json
{
  "phoneNumber": "+919876543210"
}
```

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "message": "OTP sent successfully to +919876543210",
  "debugOtp": "123456"
}
```

---

### 1.2 Verify Phone OTP
- **Method**: `POST`
- **Path**: `/api/v1/auth/otp/verify`
- **Auth Scope**: `Public`
- **Description**: Verifies phone OTP code, registers or fetches the user, and issues LUMO JWT access & refresh tokens.

#### Request Body
```json
{
  "phoneNumber": "+919876543210",
  "otp": "123456",
  "role": "CUSTOMER",
  "fullName": "Anandhu",
  "gender": "MALE"
}
```

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr-8a2f4c1e",
      "phoneNumber": "+919876543210",
      "fullName": "Anandhu",
      "role": "CUSTOMER",
      "gender": "MALE",
      "email": null
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1Ni...",
      "refreshToken": "def456...",
      "expiresIn": "1d"
    }
  }
}
```

---

### 1.3 Firebase ID Token Login
- **Method**: `POST`
- **Path**: `/api/v1/auth/firebase-login`
- **Auth Scope**: `Public`
- **Description**: Verifies client-side Firebase ID token (from Phone SMS Auth or Google Sign-In), provisions user in PostgreSQL, and returns LUMO JWT tokens.

#### Request Body
```json
{
  "idToken": "eyJhbGciOiJSUzI1Ni...",
  "role": "CUSTOMER",
  "fullName": "Anandhu",
  "gender": "MALE"
}
```

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "usr-8a2f4c1e",
      "phoneNumber": "+919876543210",
      "email": "anandhu@example.com",
      "fullName": "Anandhu",
      "role": "CUSTOMER"
    },
    "tokens": {
      "accessToken": "eyJhbGciOiJIUzI1Ni...",
      "refreshToken": "def456..."
    }
  }
}
```

---

## 2. User & Profile Service (`user-service` — Port 5002)

### 2.1 Fetch Current User Profile
- **Method**: `GET`
- **Path**: `/api/v1/users/me`
- **Auth Scope**: `Customer` | `Professional` | `Admin`
- **Description**: Fetches current authenticated user's profile details.

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "id": "usr-8a2f4c1e",
    "phoneNumber": "+919876543210",
    "email": "anandhu@example.com",
    "fullName": "Anandhu",
    "role": "CUSTOMER",
    "gender": "MALE",
    "avatarUrl": null
  }
}
```

---

### 2.2 Save GPS Address Location
- **Method**: `POST`
- **Path**: `/api/v1/users/locations`
- **Auth Scope**: `Customer`
- **Description**: Saves a new user location (Home, Work, Other) with PostGIS GPS coordinates.

#### Request Body
```json
{
  "label": "Home",
  "addressText": "Kochi, Kerala, India",
  "latitude": 9.9312,
  "longitude": 76.2673,
  "isDefault": true
}
```

#### Response Body (HTTP 201)
```json
{
  "success": true,
  "data": {
    "id": "loc-91fa8b",
    "user_id": "usr-8a2f4c1e",
    "label": "Home",
    "address_text": "Kochi, Kerala, India",
    "latitude": 9.9312,
    "longitude": 76.2673,
    "is_default": true
  }
}
```

---

## 3. Professional & Health Service (`pro-service` — Port 5003)

### 3.1 Fetch Provider Account Health & Rating Metrics
- **Method**: `GET`
- **Path**: `/api/v1/pro/health`
- **Auth Scope**: `Professional`
- **Description**: Returns provider's Account Health Score (0-100), rating average, completion rate, and verification status.

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "accountHealthScore": 98.5,
    "ratingAvg": 4.92,
    "totalJobsCompleted": 142,
    "acceptanceRate": 95.0,
    "cancellationRate": 1.2,
    "verificationStatus": "APPROVED"
  }
}
```

---

## 4. Service Catalog Service (`catalog-service` — Port 5004)

### 4.1 Fetch Service Categories
- **Method**: `GET`
- **Path**: `/api/v1/catalog/categories`
- **Auth Scope**: `Public`
- **Description**: Returns all active home service categories (Electrical, Plumbing, Cleaning).

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "id": "cat-elec",
      "name": "Electrical Services",
      "description": "Fan repair, wiring, switchboard installation",
      "icon_url": "https://cdn-icons-png.flaticon.com/512/2983/2983780.png"
    }
  ]
}
```

---

### 4.2 Fetch Services List
- **Method**: `GET`
- **Path**: `/api/v1/catalog/services?categoryId=cat-elec`
- **Auth Scope**: `Public`
- **Description**: Returns services under a category with base prices and duration estimates.

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "id": "srv-elec-01",
      "category_id": "cat-elec",
      "name": "Switch & Socket Repair",
      "base_price": "199.00",
      "duration_minutes": 30
    }
  ]
}
```

---

## 5. Booking Engine Service (`booking-service` — Port 5005)

### 5.1 Create Home Service Booking Request
- **Method**: `POST`
- **Path**: `/api/v1/bookings`
- **Auth Scope**: `Customer`
- **Description**: Creates a new booking request in `REQUESTED` state and generates job start/finish OTPs.

#### Request Body
```json
{
  "serviceId": "srv-elec-01",
  "scheduledAt": "2026-07-25T14:00:00Z",
  "addressText": "Kochi, Kerala",
  "latitude": 9.9312,
  "longitude": 76.2673,
  "femaleProPreferred": false
}
```

#### Response Body (HTTP 201)
```json
{
  "success": true,
  "data": {
    "id": "bk-4f91b",
    "customer_id": "usr-8a2f4c1e",
    "service_id": "srv-elec-01",
    "status": "REQUESTED",
    "start_otp": "7482",
    "end_otp": "9124",
    "total_amount": "199.00"
  }
}
```

---

### 5.2 Fetch My Bookings
- **Method**: `GET`
- **Path**: `/api/v1/bookings/my-bookings`
- **Auth Scope**: `Customer` | `Professional`
- **Description**: Returns booking history for current user/provider.

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "id": "bk-4f91b",
      "service_name": "Switch & Socket Repair",
      "status": "ACCEPTED",
      "total_amount": "199.00",
      "scheduled_at": "2026-07-25T14:00:00Z"
    }
  ]
}
```

---

## 6. Geo Telemetry & Tracking Service (`geo-service` — Port 5006)

### 6.1 Real-Time Provider GPS Position Stream (WebSocket)
- **Protocol**: `WebSocket (WS)`
- **URL**: `ws://localhost:5006`
- **Auth Scope**: `Professional` / `Customer`
- **Description**: Real-time bidirectional telemetry stream broadcasting provider positions.

#### Incoming Telemetry Message (From Provider)
```json
{
  "type": "LOCATION_PING",
  "proId": "usr-pro-123",
  "bookingId": "bk-4f91b",
  "latitude": 9.9320,
  "longitude": 76.2680,
  "bearing": 180.5
}
```

#### Outgoing Broadcast Event (To Customer)
```json
{
  "type": "GEO_UPDATE",
  "payload": {
    "proId": "usr-pro-123",
    "latitude": 9.9320,
    "longitude": 76.2680,
    "etaMinutes": 12
  }
}
```

---

## 7. Safety & Admin SCC Service (`safety-service` — Port 5007)

### 7.1 Instant Emergency SOS Trigger
- **Method**: `POST`
- **Path**: `/api/v1/safety/sos/trigger`
- **Auth Scope**: `Customer` | `Professional`
- **Description**: Broadcasts sub-second emergency SOS alert with current GPS position to the Admin Safety Control Center (SCC).

#### Request Body
```json
{
  "bookingId": "bk-4f91b",
  "latitude": 9.9322,
  "longitude": 76.2685,
  "notes": "Emergency SOS Button Pressed"
}
```

#### Response Body (HTTP 201)
```json
{
  "success": true,
  "data": {
    "id": "sos-88ab12",
    "booking_id": "bk-4f91b",
    "triggered_by_user_id": "usr-8a2f4c1e",
    "trigger_latitude": 9.9322,
    "trigger_longitude": 76.2685,
    "status": "ACTIVE"
  }
}
```

---

### 7.2 Fetch Admin Active SOS Alerts
- **Method**: `GET`
- **Path**: `/api/v1/admin/safety/sos`
- **Auth Scope**: `Admin` | `Super Admin`
- **Description**: Returns all active emergency SOS alerts for the Admin Safety Control Center dashboard.

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "id": "sos-88ab12",
      "user_name": "Anandhu",
      "user_phone": "+919876543210",
      "status": "ACTIVE",
      "trigger_latitude": 9.9322,
      "trigger_longitude": 76.2685,
      "created_at": "2026-07-23T11:30:00Z"
    }
  ]
}
```

---

### 7.3 Fetch System Settings (Google Maps API Key)
- **Method**: `GET`
- **Path**: `/api/v1/admin/settings`
- **Auth Scope**: `Admin` | `Super Admin`
- **Description**: Returns all system configuration keys including Google Maps Platform API key.

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": [
    {
      "setting_key": "GOOGLE_MAPS_API_KEY",
      "setting_value": "AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4",
      "description": "Google Maps Platform API Key for Geocoding & Distance Matrix"
    }
  ]
}
```

---

### 7.4 Update System Setting Key
- **Method**: `PUT`
- **Path**: `/api/v1/admin/settings/GOOGLE_MAPS_API_KEY`
- **Auth Scope**: `Admin` | `Super Admin`
- **Description**: Dynamically updates system configuration keys from the Admin Dashboard.

#### Request Body
```json
{
  "value": "AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4"
}
```

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "setting_key": "GOOGLE_MAPS_API_KEY",
    "setting_value": "AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4",
    "updated_at": "2026-07-23T12:00:00Z"
  }
}
```

---

## 8. Media Vault Service (`media-service` — Port 5010)

### 8.1 Generate S3 Presigned Upload URL
- **Method**: `POST`
- **Path**: `/api/v1/media/upload-url`
- **Auth Scope**: `Customer` | `Professional`
- **Description**: Generates secure presigned S3 URL for uploading verification documents or misconduct media proof.

#### Request Body
```json
{
  "fileName": "id_proof.pdf",
  "fileType": "application/pdf"
}
```

#### Response Body (HTTP 200)
```json
{
  "success": true,
  "data": {
    "uploadUrl": "https://lumo-vault.s3.amazonaws.com/uploads/usr-123/id_proof.pdf?signature=...",
    "fileKey": "uploads/usr-123/id_proof.pdf",
    "expiresInSeconds": 900
  }
}
```
