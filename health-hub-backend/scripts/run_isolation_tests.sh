#!/bin/bash
set -e

# Wait for DB
sleep 2

export DATABASE_URL="postgresql://testuser:testpassword@localhost:5433/healthhub_test?schema=public"
export DIRECT_DATABASE_URL="postgresql://testuser:testpassword@localhost:5433/healthhub_test?schema=public"

# Run tests
npx jest src/__tests__/tenant-isolation.test.ts
