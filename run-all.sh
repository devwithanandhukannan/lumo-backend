#!/usr/bin/env bash

echo "================================================================="
echo "🚀 STARTING ALL LUMO MICROSERVICES & API GATEWAY CONCURRENTLY"
echo "================================================================="

# Start PostgreSQL & Redis if Docker is available
if command -v docker &> /dev/null; then
  echo "🐘 Ensuring PostgreSQL PostGIS & Redis containers are running..."
  docker-compose up -d
fi

# Run all services using npm workspace commands
npx concurrently \
  --names "GATEWAY,AUTH,USER,PRO,CATALOG,BOOKING,GEO,SAFETY,PAYMENT,NOTIF,MEDIA" \
  --prefix-colors "blue,green,magenta,yellow,cyan,blue,red,magenta,green,cyan,yellow" \
  "npm --workspace=services/api-gateway run dev" \
  "npm --workspace=services/auth-service run dev" \
  "npm --workspace=services/user-service run dev" \
  "npm --workspace=services/pro-service run dev" \
  "npm --workspace=services/catalog-service run dev" \
  "npm --workspace=services/booking-service run dev" \
  "npm --workspace=services/geo-service run dev" \
  "npm --workspace=services/safety-service run dev" \
  "npm --workspace=services/payment-service run dev" \
  "npm --workspace=services/notification-service run dev" \
  "npm --workspace=services/media-service run dev"
