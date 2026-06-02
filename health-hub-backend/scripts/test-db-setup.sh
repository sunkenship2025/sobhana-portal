#!/bin/bash
set -e

# Start Docker container
docker-compose -f docker-compose.test.yml up -d db-test

# Wait for database to be ready
echo "Waiting for test database to be ready..."
sleep 5

# Run Prisma migrations
export DATABASE_URL="postgresql://testuser:testpassword@localhost:5433/healthhub_test?schema=public"
export DIRECT_DATABASE_URL="postgresql://testuser:testpassword@localhost:5433/healthhub_test?schema=public"

# Since this is a test db and our migrations are messy, we'll just push the schema
npx prisma db push --accept-data-loss

echo "Test database is ready."
