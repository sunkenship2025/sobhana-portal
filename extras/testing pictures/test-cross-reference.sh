#!/bin/bash

echo "🧪 Testing Cross-Reference Detection Feature"
echo "=============================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Login to get token
echo "1️⃣  Logging in as owner..."
LOGIN_RESPONSE=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@sobhana.com","password":"password123"}')

TOKEN=$(echo $LOGIN_RESPONSE | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo -e "${RED}❌ Login failed${NC}"
  echo "Response: $LOGIN_RESPONSE"
  exit 1
fi

echo -e "${GREEN}✅ Login successful${NC}"
echo ""

# Step 2: Check if referral doctor phone 9876543220 exists
echo "2️⃣  Checking referral doctor phone (9876543220)..."
REFERRAL_CHECK=$(curl -s -X GET "http://localhost:3000/api/doctors/search-by-contact?phone=9876543220" \
  -H "Authorization: Bearer $TOKEN")

echo "Response:"
echo $REFERRAL_CHECK | jq '.' 2>/dev/null || echo $REFERRAL_CHECK
echo ""

# Step 3: Check if we have clinic doctors
echo "3️⃣  Listing clinic doctors to find a phone number..."
CLINIC_DOCTORS=$(curl -s -X GET "http://localhost:3000/api/clinic-doctors" \
  -H "Authorization: Bearer $TOKEN")

echo "Clinic Doctors Response:"
echo $CLINIC_DOCTORS | jq '.' 2>/dev/null || echo $CLINIC_DOCTORS
echo ""

# Extract first clinic doctor phone
CLINIC_PHONE=$(echo $CLINIC_DOCTORS | grep -o '"phone":"[^"]*' | head -1 | cut -d'"' -f4)

if [ ! -z "$CLINIC_PHONE" ]; then
  echo "4️⃣  Testing cross-reference: Checking clinic doctor phone ($CLINIC_PHONE)..."
  CLINIC_CHECK=$(curl -s -X GET "http://localhost:3000/api/doctors/search-by-contact?phone=$CLINIC_PHONE" \
    -H "Authorization: Bearer $TOKEN")
  
  echo "Response:"
  echo $CLINIC_CHECK | jq '.' 2>/dev/null || echo $CLINIC_CHECK
  echo ""
fi

echo "=============================================="
echo "🎯 Test Summary:"
echo ""
echo "📱 Test credentials:"
echo "   Email: owner@sobhana.com"
echo "   Password: password123"
echo ""
echo "🔗 Frontend URL: http://localhost:8080"
echo "🔗 Backend URL: http://localhost:3000"
echo ""
echo "📝 To test manually:"
echo "   1. Login to frontend with above credentials"
echo "   2. Go to 'Manage Referral Doctors'"
echo "   3. Click 'Add Doctor' and enter phone: 9876543220"
echo "   4. You should see a yellow alert if a clinic doctor exists with this phone"
echo ""
echo "   Alternative: Go to 'Manage Clinic Doctors' and try a referral doctor phone"
